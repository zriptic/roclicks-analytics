/**
 * Rate limits for the public SDK API (/api/a/v1/*), kept in memory.
 *
 * The SDK key ships inside every game, so it is public, and Roblox game
 * servers share outbound IPs across many games. So:
 *  - each key gets a generous token bucket (default 100 requests/s, bursts of
 *    500): ~1,500 servers of one game flushing every 15 s stay well inside it,
 *    while a leaked key used to flood the API is cut off;
 *  - an IP is only limited for *rejected* keys (30 a minute), so junk or
 *    guessed keys can't hit the database on every request, but a shared Roblox
 *    IP serving real games never trips it.
 *
 * State is per process. The web service runs one replica; with more, each
 * replica enforces its own share, which only makes the limits looser.
 */

type Bucket = { tokens: number; at: number };

const KEY_RATE = Number(process.env.ANALYTICS_RATE_PER_KEY ?? 100); // tokens per second
const KEY_BURST = Number(process.env.ANALYTICS_BURST_PER_KEY ?? 500);
const BAD_KEYS_PER_MINUTE = Number(process.env.ANALYTICS_BAD_KEYS_PER_IP ?? 30);

const keyBuckets = new Map<string, Bucket>();
const badKeyBuckets = new Map<string, Bucket>();

function refill(map: Map<string, Bucket>, id: string, rate: number, burst: number, now: number): Bucket {
  const b = map.get(id) ?? { tokens: burst, at: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
  b.at = now;
  map.set(id, b);
  return b;
}

/** Seconds to wait until one token is back. */
function waitFor(b: Bucket, rate: number): number {
  return Math.max(1, Math.ceil((1 - b.tokens) / rate));
}

/** Takes one request from the key's bucket. Returns seconds to wait, or 0 if allowed. */
export function takeKeyToken(key: string, now = Date.now()): number {
  const b = refill(keyBuckets, key, KEY_RATE, KEY_BURST, now);
  if (b.tokens < 1) return waitFor(b, KEY_RATE);
  b.tokens -= 1;
  return 0;
}

const BAD_RATE = BAD_KEYS_PER_MINUTE / 60;

/** Seconds this IP must wait because of recent rejected keys, or 0. Doesn't consume. */
export function badKeyWait(ip: string, now = Date.now()): number {
  const b = refill(badKeyBuckets, ip, BAD_RATE, BAD_KEYS_PER_MINUTE, now);
  return b.tokens < 1 ? waitFor(b, BAD_RATE) : 0;
}

/** Records one rejected key from this IP. */
export function noteBadKey(ip: string, now = Date.now()): void {
  const b = refill(badKeyBuckets, ip, BAD_RATE, BAD_KEYS_PER_MINUTE, now);
  b.tokens = Math.max(0, b.tokens - 1);
}

/** First hop of X-Forwarded-For (Railway's proxy sets it), else "unknown". */
export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  const first = fwd?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || "unknown";
}

export function tooManyRequests(retryAfter: number, what: string): Response {
  return Response.json(
    { error: `rate limited: ${what}`, retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

// Forget idle buckets so the maps can't grow without bound. A full bucket
// and a missing one behave the same, so dropping idle entries is lossless.
const IDLE_MS = 10 * 60_000;
setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  for (const map of [keyBuckets, badKeyBuckets]) {
    for (const [id, b] of map) if (b.at < cutoff) map.delete(id);
  }
}, 60_000).unref?.();

/** Test hook: clears all buckets. */
export function resetRateLimits(): void {
  keyBuckets.clear();
  badKeyBuckets.clear();
}
