import { prisma } from "@/lib/db";
import { readEnv, type Env } from "./limits";
import { badKeyWait, clientIp, noteBadKey, takeKeyToken, tooManyRequests } from "./rateLimit";

/**
 * Every game server hits the SDK API every few seconds, so keys are checked
 * against an in-memory copy of ALL SDK keys (one short row per game) instead
 * of a query per request. The copy is reloaded every minute, and at once when
 * a key is created, rotated or deleted (invalidateSdkKeys).
 *
 * That also means a junk or guessed key is rejected without touching the
 * database. A key that isn't in the copy can force one reload, at most every
 * few seconds, so a brand-new game works immediately even on another replica.
 */
const REFRESH_MS = 60_000;
const MISS_RELOAD_MS = 5_000;

let keys = new Map<string, string>(); // sdkKey -> gameId
let loadedAt = 0;
let loading: Promise<void> | null = null;

async function reload(): Promise<void> {
  loading ??= (async () => {
    try {
      const rows = await prisma.analyticsGame.findMany({ select: { id: true, sdkKey: true } });
      keys = new Map(rows.map((r) => [r.sdkKey, r.id]));
      loadedAt = Date.now();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function lookup(key: string): Promise<string | null> {
  if (Date.now() - loadedAt > REFRESH_MS) await reload();
  let id = keys.get(key);
  if (!id && Date.now() - loadedAt > MISS_RELOAD_MS) {
    await reload();
    id = keys.get(key);
  }
  return id ?? null;
}

/** Call after creating, rotating or deleting a game's key. */
export function invalidateSdkKeys(): void {
  loadedAt = 0;
}

export async function gameFromRequest(
  request: Request,
): Promise<{ gameId: string; env: Env } | Response> {
  const key = request.headers.get("x-rc-key")?.trim();
  const gameId = key && key.startsWith("rca_") && key.length <= 64 ? await lookup(key) : null;

  if (!gameId) {
    // Only rejected keys are limited by address. Roblox servers share
    // outbound IPs across games, so a real key is never refused because a
    // neighbour on the same IP sent junk.
    const ip = clientIp(request);
    const blocked = badKeyWait(ip);
    if (blocked) return tooManyRequests(blocked, "too many rejected keys from this address");
    noteBadKey(ip);
    return Response.json(
      { error: key ? "unknown key" : "missing or malformed x-rc-key" },
      { status: 401 },
    );
  }

  const wait = takeKeyToken(key!);
  if (wait) return tooManyRequests(wait, "too many requests for this key");

  return { gameId, env: readEnv(request.headers.get("x-rc-env")) };
}
