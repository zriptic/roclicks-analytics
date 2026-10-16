import { prisma } from "@/lib/db";
import { MAX_CONFIG_BYTES, readEnv } from "@/lib/analytics/limits";
import { ownedGame } from "@/lib/analytics/owner";

/**
 * Save a config. `baseVersion` is the version the editor loaded; if someone
 * saved in between, the save is refused with 409 instead of overwriting.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { userId, game } = await ownedGame(id);
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!game) return Response.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as
    | { env?: unknown; values?: unknown; baseVersion?: unknown }
    | null;
  const env = readEnv(typeof body?.env === "string" ? body.env : null);
  const values = body?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return Response.json({ error: "The config must be a JSON object, like { \"coins\": 50 }." }, { status: 400 });
  }
  if (JSON.stringify(values).length > MAX_CONFIG_BYTES) {
    return Response.json({ error: "The config is over 256 KB." }, { status: 400 });
  }
  const baseVersion = typeof body?.baseVersion === "number" ? body.baseVersion : -1;

  const current = await prisma.analyticsConfig.findUnique({
    where: { gameId_env: { gameId: id, env } },
    select: { version: true },
  });
  const currentVersion = current?.version ?? 0;
  if (baseVersion !== currentVersion) {
    return Response.json(
      { error: "Someone saved this config since you opened it. Reload to get their changes.", version: currentVersion },
      { status: 409 },
    );
  }

  // The version check above and this write race only if two saves land in
  // the same instant; updateMany with the version in the filter closes that.
  const json = values as object;
  if (current) {
    const res = await prisma.analyticsConfig.updateMany({
      where: { gameId: id, env, version: currentVersion },
      data: { values: json, version: currentVersion + 1 },
    });
    if (res.count === 0) return Response.json({ error: "Config changed, reload." }, { status: 409 });
  } else {
    try {
      await prisma.analyticsConfig.create({ data: { gameId: id, env, values: json, version: 1 } });
    } catch {
      return Response.json({ error: "Config changed, reload." }, { status: 409 });
    }
  }
  return Response.json({ ok: true, version: currentVersion + 1 });
}
