import { prisma } from "@/lib/db";
import { assignVariant, type Variant } from "./experiments";
import {
  EVENT_NAME,
  FREE_EVENTS_PER_MONTH,
  MAX_EVENTS_PER_BATCH,
  MAX_PURCHASE_ROBUX,
  MAX_PURCHASES_PER_BATCH,
  MAX_SESSIONS_PER_BATCH,
  MAX_VALUE_BYTES,
  OWNER_SHARE,
  monthKey,
  type Env,
} from "./limits";

/**
 * One batch from one game server. The SDK sends this every flush interval
 * whether or not it has markers, because `active` doubles as the session
 * heartbeat. Times are unix seconds from the server's os.time()/tick clock.
 */
export type IngestBatch = {
  serverId?: unknown;
  placeId?: unknown;
  started?: unknown; // [{ id, userId, t, country?, device? }]
  ended?: unknown; // [{ id, t }]
  active?: unknown; // [sessionId]
  events?: unknown; // [{ name, t, userId?, sessionId?, value?, pos?: [x,y,z] }]
  purchases?: unknown; // [{ id, userId, kind, robux, t, itemId?, name?, sessionId? }]
  exposures?: unknown; // [{ e: experimentId, userId, t }]
  devices?: unknown; // [{ id: sessionId, device }], from the optional client script
};

export type IngestResult = {
  accepted: number;
  rejected: number;
  reasons: string[];
  overQuota: boolean;
};

type StartedRow = { id: string; uid: number; t: number; country: string | null; device: string | null };
type EndedRow = { id: string; t: number };
type EventRow = {
  name: string;
  t: number;
  uid: number | null;
  sid: string | null;
  value: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
};

type PurchaseRow = {
  id: string;
  uid: number;
  sid: string | null;
  kind: string;
  itemId: number | null;
  name: string | null;
  robux: number;
  share: number;
  net: number;
  t: number;
};

type ExposureRow = { e: string; uid: number; t: number };

const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;
const EXPERIMENT_ID = /^[a-z0-9]{10,40}$/;
const MAX_EXPOSURES_PER_BATCH = 1000;
export const DEVICES = ["phone", "tablet", "desktop", "console", "vr"] as const;
const PURCHASE_ID = /^[A-Za-z0-9_:.-]{1,80}$/;

/**
 * Server clocks drift and a batch can sit in a retry queue, but nothing
 * legitimate is a day old or from the future. Out-of-range times are pulled
 * to "now" rather than rejected so the marker still counts.
 */
function clampTime(t: unknown, now: number): number {
  const ms = typeof t === "number" && Number.isFinite(t) ? t * 1000 : now;
  return ms < now - 86_400_000 || ms > now + 300_000 ? now : ms;
}

function userId(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v !== 0 ? v : null;
}

function shortString(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

function list(v: unknown, max: number): unknown[] {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

export function parseBatch(body: IngestBatch, now: number) {
  const reasons = new Set<string>();
  let rejected = 0;
  const reject = (why: string) => {
    rejected++;
    reasons.add(why);
  };

  const started: StartedRow[] = [];
  for (const raw of list(body.started, MAX_SESSIONS_PER_BATCH)) {
    const s = raw as Record<string, unknown>;
    const uid = userId(s?.userId);
    if (typeof s?.id !== "string" || !SESSION_ID.test(s.id) || uid === null) {
      reject("bad session start");
      continue;
    }
    started.push({
      id: s.id,
      uid,
      t: clampTime(s.t, now),
      country: shortString(s.country, 8),
      device: shortString(s.device, 16),
    });
  }

  const ended: EndedRow[] = [];
  for (const raw of list(body.ended, MAX_SESSIONS_PER_BATCH)) {
    const s = raw as Record<string, unknown>;
    if (typeof s?.id !== "string" || !SESSION_ID.test(s.id)) {
      reject("bad session end");
      continue;
    }
    ended.push({ id: s.id, t: clampTime(s.t, now) });
  }

  const active = list(body.active, MAX_SESSIONS_PER_BATCH * 2).filter(
    (id): id is string => typeof id === "string" && SESSION_ID.test(id),
  );

  const events: EventRow[] = [];
  const rawEvents = Array.isArray(body.events) ? body.events : [];
  if (rawEvents.length > MAX_EVENTS_PER_BATCH) {
    rejected += rawEvents.length - MAX_EVENTS_PER_BATCH;
    reasons.add(`more than ${MAX_EVENTS_PER_BATCH} markers in one batch`);
  }
  for (const raw of rawEvents.slice(0, MAX_EVENTS_PER_BATCH)) {
    const e = raw as Record<string, unknown>;
    if (typeof e?.name !== "string" || !EVENT_NAME.test(e.name)) {
      reject("marker name must be 1-64 letters, digits, spaces or _ . : / -");
      continue;
    }
    let value: string | null = null;
    if (e.value !== undefined && e.value !== null) {
      value = JSON.stringify(e.value);
      if (value.length > MAX_VALUE_BYTES) {
        reject(`marker value over ${MAX_VALUE_BYTES} bytes`);
        continue;
      }
    }
    const pos = Array.isArray(e.pos) && e.pos.length === 3 && e.pos.every((n) => typeof n === "number" && Number.isFinite(n))
      ? (e.pos as number[])
      : null;
    events.push({
      name: e.name,
      t: clampTime(e.t, now),
      uid: userId(e.userId),
      sid: typeof e.sessionId === "string" && SESSION_ID.test(e.sessionId) ? e.sessionId : null,
      value,
      x: pos?.[0] ?? null,
      y: pos?.[1] ?? null,
      z: pos?.[2] ?? null,
    });
  }

  const purchases: PurchaseRow[] = [];
  for (const raw of list(body.purchases, MAX_PURCHASES_PER_BATCH)) {
    const p = raw as Record<string, unknown>;
    const uid = userId(p?.userId);
    const robux = p?.robux;
    const kind = typeof p?.kind === "string" && p.kind in OWNER_SHARE ? p.kind : "other";
    if (
      typeof p?.id !== "string" || !PURCHASE_ID.test(p.id) || uid === null ||
      typeof robux !== "number" || !Number.isInteger(robux) || robux < 0 || robux > MAX_PURCHASE_ROBUX
    ) {
      reject("bad purchase");
      continue;
    }
    const share = OWNER_SHARE[kind];
    purchases.push({
      id: p.id,
      uid,
      sid: typeof p.sessionId === "string" && SESSION_ID.test(p.sessionId) ? p.sessionId : null,
      kind,
      itemId: userId(p.itemId),
      name: shortString(p.name, 100),
      robux,
      share,
      // Roblox rounds the owner's cut down to whole Robux.
      net: Math.floor(robux * share),
      t: clampTime(p.t, now),
    });
  }

  const exposures: ExposureRow[] = [];
  for (const raw of list(body.exposures, MAX_EXPOSURES_PER_BATCH)) {
    const x = raw as Record<string, unknown>;
    const uid = userId(x?.userId);
    if (typeof x?.e !== "string" || !EXPERIMENT_ID.test(x.e) || uid === null) {
      reject("bad exposure");
      continue;
    }
    exposures.push({ e: x.e, uid, t: clampTime(x.t, now) });
  }

  const devices: { id: string; device: string }[] = [];
  for (const raw of list(body.devices, MAX_SESSIONS_PER_BATCH)) {
    const d = raw as Record<string, unknown>;
    if (typeof d?.id !== "string" || !SESSION_ID.test(d.id) || !(DEVICES as readonly unknown[]).includes(d.device)) {
      reject("bad device");
      continue;
    }
    devices.push({ id: d.id, device: d.device as string });
  }

  const serverId = shortString(body.serverId, 64) ?? "unknown";
  const placeId = userId(body.placeId);

  return { started, ended, active, events, purchases, exposures, devices, serverId, placeId, rejected, reasons: [...reasons] };
}

/**
 * Write a parsed batch. Each step is idempotent where it matters: a session
 * start retried after a timeout hits ON CONFLICT and doesn't bump the
 * player's session count twice, and an end only adds play time once.
 */
export async function writeBatch(
  gameId: string,
  env: Env,
  batch: ReturnType<typeof parseBatch>,
  now: number,
): Promise<IngestResult> {
  const { started, ended, active, events, purchases, exposures, devices, serverId, placeId } = batch;
  const nowTs = new Date(now);

  if (started.length) {
    const json = JSON.stringify(started);
    await prisma.$executeRaw`
      WITH rows AS (
        SELECT r.id, r.uid, to_timestamp(r.t / 1000.0) AT TIME ZONE 'UTC' AS ts, r.country, r.device
        FROM jsonb_to_recordset(${json}::jsonb) AS r(id text, uid bigint, t double precision, country text, device text)
      ), inserted AS (
        INSERT INTO "AnalyticsSession" (id, "gameId", env, "robloxUserId", "serverId", "placeId", "startedAt", "lastSeenAt", country, device)
        SELECT id, ${gameId}, ${env}, uid, ${serverId}, ${placeId}::bigint, ts, ts, country, device FROM rows
        ON CONFLICT (id) DO NOTHING
        RETURNING "robloxUserId", "startedAt", country
      )
      INSERT INTO "AnalyticsPlayer" ("gameId", env, "robloxUserId", "firstSeenAt", "lastSeenAt", "sessionCount", country)
      SELECT ${gameId}, ${env}, "robloxUserId", min("startedAt"), max("startedAt"), count(*), max(country)
      FROM inserted GROUP BY "robloxUserId"
      ON CONFLICT ("gameId", env, "robloxUserId") DO UPDATE SET
        "lastSeenAt" = GREATEST("AnalyticsPlayer"."lastSeenAt", EXCLUDED."lastSeenAt"),
        "firstSeenAt" = LEAST("AnalyticsPlayer"."firstSeenAt", EXCLUDED."firstSeenAt"),
        "sessionCount" = "AnalyticsPlayer"."sessionCount" + EXCLUDED."sessionCount",
        country = COALESCE(EXCLUDED.country, "AnalyticsPlayer".country)`;

    await prisma.$executeRaw`
      INSERT INTO "AnalyticsActiveDay" ("gameId", env, day, "robloxUserId")
      SELECT DISTINCT ${gameId}, ${env}, (to_timestamp(r.t / 1000.0) AT TIME ZONE 'UTC')::date, r.uid
      FROM jsonb_to_recordset(${json}::jsonb) AS r(uid bigint, t double precision)
      ON CONFLICT DO NOTHING`;
  }

  if (devices.length) {
    // Usually lands in the same batch as the start (above); a slow client
    // can report a flush later. First answer wins.
    const json = JSON.stringify(devices);
    await prisma.$executeRaw`
      UPDATE "AnalyticsSession" s SET device = r.device
      FROM jsonb_to_recordset(${json}::jsonb) AS r(id text, device text)
      WHERE s.id = r.id AND s."gameId" = ${gameId} AND s.device IS NULL`;
  }

  if (active.length) {
    // Heartbeat. A session that runs past midnight UTC also counts as
    // active on the new day, which is what DAU means.
    const ids = JSON.stringify(active);
    await prisma.$executeRaw`
      WITH touched AS (
        UPDATE "AnalyticsSession" SET "lastSeenAt" = to_timestamp(${now} / 1000.0) AT TIME ZONE 'UTC'
        WHERE "gameId" = ${gameId} AND "endedAt" IS NULL
          AND id IN (SELECT jsonb_array_elements_text(${ids}::jsonb))
        RETURNING "robloxUserId"
      )
      INSERT INTO "AnalyticsActiveDay" ("gameId", env, day, "robloxUserId")
      SELECT DISTINCT ${gameId}, ${env}, ${nowTs.toISOString().slice(0, 10)}::date, "robloxUserId" FROM touched
      ON CONFLICT DO NOTHING`;
  }

  if (ended.length) {
    const json = JSON.stringify(ended);
    await prisma.$executeRaw`
      WITH closed AS (
        UPDATE "AnalyticsSession" s SET
          "endedAt" = GREATEST(s."startedAt", to_timestamp(r.t / 1000.0) AT TIME ZONE 'UTC'),
          "lastSeenAt" = GREATEST(s."startedAt", to_timestamp(r.t / 1000.0) AT TIME ZONE 'UTC')
        FROM jsonb_to_recordset(${json}::jsonb) AS r(id text, t double precision)
        WHERE s.id = r.id AND s."gameId" = ${gameId} AND s."endedAt" IS NULL
        RETURNING s."robloxUserId", s."endedAt", EXTRACT(EPOCH FROM s."endedAt" - s."startedAt")::int AS secs
      ), per_player AS (
        SELECT "robloxUserId", max("endedAt") AS last, sum(secs) AS secs FROM closed GROUP BY "robloxUserId"
      )
      UPDATE "AnalyticsPlayer" p SET
        "playSeconds" = p."playSeconds" + pp.secs,
        "lastSeenAt" = GREATEST(p."lastSeenAt", pp.last)
      FROM per_player pp
      WHERE p."gameId" = ${gameId} AND p.env = ${env} AND p."robloxUserId" = pp."robloxUserId"`;
  }

  let accepted = events.length;
  let overQuota = false;
  if (events.length) {
    // Reserve quota first, then insert only what fit. Studio markers are
    // free: testing shouldn't burn a game's month.
    let allowed = events.length;
    if (env === "prod") {
      const month = monthKey(nowTs);
      const [row] = await prisma.$queryRaw<{ events: number }[]>`
        INSERT INTO "AnalyticsUsage" ("gameId", month, events) VALUES (${gameId}, ${month}, ${events.length})
        ON CONFLICT ("gameId", month) DO UPDATE SET events = "AnalyticsUsage".events + ${events.length}
        RETURNING events`;
      const before = row.events - events.length;
      allowed = Math.max(0, Math.min(events.length, FREE_EVENTS_PER_MONTH - before));
      overQuota = allowed < events.length;
    }
    const kept = events.slice(0, allowed);
    accepted = kept.length;
    if (kept.length) {
      const json = JSON.stringify(kept);
      await prisma.$executeRaw`
        INSERT INTO "AnalyticsEvent" ("gameId", env, name, "robloxUserId", "sessionId", value, x, y, z, at)
        SELECT ${gameId}, ${env}, r.name, r.uid, r.sid, r.value::jsonb, r.x, r.y, r.z, to_timestamp(r.t / 1000.0) AT TIME ZONE 'UTC'
        FROM jsonb_to_recordset(${json}::jsonb)
          AS r(name text, uid bigint, sid text, value text, x double precision, y double precision, z double precision, t double precision)`;
    }
  }

  if (purchases.length) {
    // Sales never count toward the marker quota. A developer product
    // receipt that Roblox retries carries the same PurchaseId and is
    // stored once.
    const json = JSON.stringify(purchases);
    await prisma.$executeRaw`
      INSERT INTO "AnalyticsPurchase" ("gameId", env, "purchaseId", "robloxUserId", "sessionId", kind, "itemId", "itemName", robux, share, "netRobux", at)
      SELECT ${gameId}, ${env}, r.id, r.uid, r.sid, r.kind, r."itemId", r.name, r.robux, r.share, r.net, to_timestamp(r.t / 1000.0) AT TIME ZONE 'UTC'
      FROM jsonb_to_recordset(${json}::jsonb)
        AS r(id text, uid bigint, sid text, kind text, "itemId" bigint, name text, robux int, share double precision, net int, t double precision)
      ON CONFLICT ("gameId", "purchaseId") DO NOTHING`;
  }

  if (exposures.length) {
    // Only this game's running tests. The variant is worked out here from
    // the same hash the SDK uses, not taken from the server, so a stale or
    // tampered server can't put a player in the wrong group.
    const tests = await prisma.analyticsExperiment.findMany({
      where: { gameId, env, status: "running", id: { in: [...new Set(exposures.map((x) => x.e))] } },
      select: { id: true, variants: true },
    });
    const variants = new Map(tests.map((t) => [t.id, t.variants as Variant[]]));
    const rows = exposures
      .filter((x) => variants.has(x.e))
      .map((x) => ({ ...x, v: assignVariant(x.e, x.uid, variants.get(x.e)!) }));
    if (rows.length) {
      const json = JSON.stringify(rows);
      await prisma.$executeRaw`
        INSERT INTO "AnalyticsExposure" ("experimentId", "robloxUserId", variant, at)
        SELECT r.e, r.uid, r.v, min(to_timestamp(r.t / 1000.0) AT TIME ZONE 'UTC')
        FROM jsonb_to_recordset(${json}::jsonb) AS r(e text, uid bigint, v text, t double precision)
        GROUP BY r.e, r.uid, r.v
        ON CONFLICT ("experimentId", "robloxUserId") DO NOTHING`;
    }
  }

  await prisma.analyticsGame.update({ where: { id: gameId }, data: { lastIngestAt: nowTs } });

  const reasons = [...batch.reasons];
  if (overQuota) reasons.push(`monthly marker quota of ${FREE_EVENTS_PER_MONTH.toLocaleString("en-US")} reached`);
  return {
    accepted,
    rejected: batch.rejected + (events.length - accepted),
    reasons,
    overQuota,
  };
}
