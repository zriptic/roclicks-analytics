import { gameFromRequest } from "@/lib/analytics/sdkAuth";
import { parseBatch, writeBatch, type IngestBatch } from "@/lib/analytics/ingest";
import { configVersion } from "@/lib/analytics/config";
import { MAX_BODY_BYTES } from "@/lib/analytics/limits";

/**
 * Called by the RoClicks Analytics SDK from Roblox game servers. One request
 * carries session starts, ends, the heartbeat and markers. The response
 * carries the config version, so servers learn about a config edit on their
 * next flush without a separate poll.
 */
export async function POST(request: Request) {
  const who = await gameFromRequest(request);
  if (who instanceof Response) return who;

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ error: "batch too large" }, { status: 413 });
  }
  let body: IngestBatch;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "body is not JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "body must be an object" }, { status: 400 });
  }

  const now = Date.now();
  const parsed = parseBatch(body, now);
  const [result, version] = await Promise.all([
    writeBatch(who.gameId, who.env, parsed, now),
    configVersion(who.gameId, who.env),
  ]);

  return Response.json({ ok: true, ...result, configVersion: version });
}
