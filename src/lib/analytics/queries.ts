import { prisma } from "@/lib/db";
import { LIVE_WINDOW_SECONDS, monthKey, type Env } from "./limits";

export type DayPoint = { day: string; dau: number; newUsers: number; sessions: number; avgSeconds: number };
export type Cohort = { day: string; size: number; d1: number | null; d7: number | null; d30: number | null };

const DAYS = 30;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The last 30 UTC days, oldest first, with zero-filled gaps. */
async function daily(gameId: string, env: Env): Promise<DayPoint[]> {
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (DAYS - 1)));
  const fromDay = isoDay(from);

  const [dau, fresh, sessions] = await Promise.all([
    prisma.$queryRaw<{ day: Date; n: bigint }[]>`
      SELECT day, count(*) AS n FROM "AnalyticsActiveDay"
      WHERE "gameId" = ${gameId} AND env = ${env} AND day >= ${fromDay}::date
      GROUP BY day`,
    prisma.$queryRaw<{ day: Date; n: bigint }[]>`
      SELECT "firstSeenAt"::date AS day, count(*) AS n FROM "AnalyticsPlayer"
      WHERE "gameId" = ${gameId} AND env = ${env} AND "firstSeenAt" >= ${fromDay}::date
      GROUP BY 1`,
    prisma.$queryRaw<{ day: Date; n: bigint; avg: number | null }[]>`
      SELECT "startedAt"::date AS day, count(*) AS n,
        avg(EXTRACT(EPOCH FROM COALESCE("endedAt", "lastSeenAt") - "startedAt"))::float8 AS avg
      FROM "AnalyticsSession"
      WHERE "gameId" = ${gameId} AND env = ${env} AND "startedAt" >= ${fromDay}::date
      GROUP BY 1`,
  ]);

  const byDay = new Map<string, DayPoint>();
  for (let i = 0; i < DAYS; i++) {
    const day = isoDay(new Date(from.getTime() + i * 86_400_000));
    byDay.set(day, { day, dau: 0, newUsers: 0, sessions: 0, avgSeconds: 0 });
  }
  for (const r of dau) { const p = byDay.get(isoDay(r.day)); if (p) p.dau = Number(r.n); }
  for (const r of fresh) { const p = byDay.get(isoDay(r.day)); if (p) p.newUsers = Number(r.n); }
  for (const r of sessions) {
    const p = byDay.get(isoDay(r.day));
    if (p) { p.sessions = Number(r.n); p.avgSeconds = Math.round(r.avg ?? 0); }
  }
  return [...byDay.values()];
}

/**
 * Classic day-N retention: of the players first seen on a day, how many
 * played again exactly N days later. A cohort too young to have reached
 * day N reports null, not 0, so it isn't averaged in as a failure.
 */
async function cohorts(gameId: string, env: Env): Promise<Cohort[]> {
  const rows = await prisma.$queryRaw<{ day: Date; size: bigint; d1: bigint; d7: bigint; d30: bigint }[]>`
    SELECT p."firstSeenAt"::date AS day, count(*) AS size,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "AnalyticsActiveDay" a WHERE a."gameId" = p."gameId" AND a.env = p.env
        AND a."robloxUserId" = p."robloxUserId" AND a.day = p."firstSeenAt"::date + 1)) AS d1,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "AnalyticsActiveDay" a WHERE a."gameId" = p."gameId" AND a.env = p.env
        AND a."robloxUserId" = p."robloxUserId" AND a.day = p."firstSeenAt"::date + 7)) AS d7,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "AnalyticsActiveDay" a WHERE a."gameId" = p."gameId" AND a.env = p.env
        AND a."robloxUserId" = p."robloxUserId" AND a.day = p."firstSeenAt"::date + 30)) AS d30
    FROM "AnalyticsPlayer" p
    WHERE p."gameId" = ${gameId} AND p.env = ${env} AND p."firstSeenAt" >= (now() AT TIME ZONE 'UTC')::date - 44
    GROUP BY 1 ORDER BY 1 DESC`;

  const today = isoDay(new Date());
  const age = (day: string) => Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000);
  return rows.map((r) => {
    const day = isoDay(r.day);
    const a = age(day);
    return {
      day,
      size: Number(r.size),
      d1: a >= 1 ? Number(r.d1) : null,
      d7: a >= 7 ? Number(r.d7) : null,
      d30: a >= 30 ? Number(r.d30) : null,
    };
  });
}

/** Size-weighted retention over every cohort old enough to measure. */
export function overallRetention(list: Cohort[], key: "d1" | "d7" | "d30"): number | null {
  let kept = 0;
  let size = 0;
  for (const c of list) {
    const v = c[key];
    if (v === null) continue;
    kept += v;
    size += c.size;
  }
  return size ? kept / size : null;
}

export async function gameOverview(gameId: string, env: Env) {
  const [days, cohortRows, live, totals, topEvents, recent, usage] = await Promise.all([
    daily(gameId, env),
    cohorts(gameId, env),
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "AnalyticsSession"
      WHERE "gameId" = ${gameId} AND env = ${env} AND "endedAt" IS NULL
        AND "lastSeenAt" > (now() AT TIME ZONE 'UTC') - make_interval(secs => ${LIVE_WINDOW_SECONDS})`,
    prisma.analyticsPlayer.aggregate({
      where: { gameId, env },
      _count: true,
      _sum: { playSeconds: true, sessionCount: true },
    }),
    prisma.$queryRaw<{ name: string; n: bigint; users: bigint }[]>`
      SELECT name, count(*) AS n, count(DISTINCT "robloxUserId") AS users FROM "AnalyticsEvent"
      WHERE "gameId" = ${gameId} AND env = ${env} AND at > (now() AT TIME ZONE 'UTC') - interval '7 days'
      GROUP BY name ORDER BY n DESC LIMIT 25`,
    prisma.analyticsEvent.findMany({
      where: { gameId, env },
      orderBy: { at: "desc" },
      take: 30,
      select: { id: true, name: true, robloxUserId: true, value: true, at: true },
    }),
    prisma.analyticsUsage.findUnique({
      where: { gameId_month: { gameId, month: monthKey() } },
      select: { events: true },
    }),
  ]);

  return {
    days,
    cohorts: cohortRows,
    retention: {
      d1: overallRetention(cohortRows, "d1"),
      d7: overallRetention(cohortRows, "d7"),
      d30: overallRetention(cohortRows, "d30"),
    },
    live: Number(live[0]?.n ?? 0),
    totalPlayers: totals._count,
    totalSessions: totals._sum.sessionCount ?? 0,
    totalPlaySeconds: totals._sum.playSeconds ?? 0,
    topEvents: topEvents.map((e) => ({ name: e.name, count: Number(e.n), users: Number(e.users) })),
    recent: recent.map((e) => ({
      id: e.id.toString(),
      name: e.name,
      userId: e.robloxUserId?.toString() ?? null,
      value: e.value,
      at: e.at.toISOString(),
    })),
    eventsThisMonth: usage?.events ?? 0,
  };
}

export type RevenueDay = { day: string; gross: number; net: number };

/**
 * Last 30 UTC days of sales. Everything is reported three ways: what
 * players paid (gross), what the owner keeps after Roblox's cut (net), and
 * net converted at the game's DevEx rate. Premium Payouts aren't sales and
 * never reach the SDK, so they're not in any of these.
 */
export async function gameRevenue(gameId: string, env: Env, devexRate: number) {
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (DAYS - 1)));
  const fromDay = isoDay(from);

  const [daily, totals, players, items, kinds] = await Promise.all([
    prisma.$queryRaw<{ day: Date; gross: bigint; net: bigint }[]>`
      SELECT at::date AS day, sum(robux) AS gross, sum("netRobux") AS net FROM "AnalyticsPurchase"
      WHERE "gameId" = ${gameId} AND env = ${env} AND at >= ${fromDay}::date
      GROUP BY 1`,
    prisma.$queryRaw<{ gross: bigint | null; net: bigint | null; sales: bigint; payers: bigint }[]>`
      SELECT sum(robux) AS gross, sum("netRobux") AS net, count(*) AS sales, count(DISTINCT "robloxUserId") AS payers
      FROM "AnalyticsPurchase"
      WHERE "gameId" = ${gameId} AND env = ${env} AND at >= ${fromDay}::date`,
    prisma.$queryRaw<{ unique: bigint; playerDays: bigint }[]>`
      SELECT count(DISTINCT "robloxUserId") AS unique, count(*) AS "playerDays" FROM "AnalyticsActiveDay"
      WHERE "gameId" = ${gameId} AND env = ${env} AND day >= ${fromDay}::date`,
    prisma.$queryRaw<{ kind: string; itemId: bigint | null; name: string | null; sales: bigint; gross: bigint; net: bigint }[]>`
      SELECT kind, "itemId", max("itemName") AS name, count(*) AS sales, sum(robux) AS gross, sum("netRobux") AS net
      FROM "AnalyticsPurchase"
      WHERE "gameId" = ${gameId} AND env = ${env} AND at >= ${fromDay}::date
      GROUP BY kind, "itemId", CASE WHEN "itemId" IS NULL THEN "itemName" END
      ORDER BY net DESC LIMIT 12`,
    prisma.$queryRaw<{ kind: string; gross: bigint; net: bigint }[]>`
      SELECT kind, sum(robux) AS gross, sum("netRobux") AS net FROM "AnalyticsPurchase"
      WHERE "gameId" = ${gameId} AND env = ${env} AND at >= ${fromDay}::date
      GROUP BY kind ORDER BY net DESC`,
  ]);

  const byDay = new Map<string, RevenueDay>();
  for (let i = 0; i < DAYS; i++) {
    const day = isoDay(new Date(from.getTime() + i * 86_400_000));
    byDay.set(day, { day, gross: 0, net: 0 });
  }
  for (const r of daily) {
    const p = byDay.get(isoDay(r.day));
    if (p) { p.gross = Number(r.gross); p.net = Number(r.net); }
  }

  const t = totals[0];
  const gross = Number(t?.gross ?? 0);
  const net = Number(t?.net ?? 0);
  const payers = Number(t?.payers ?? 0);
  const unique = Number(players[0]?.unique ?? 0);
  const playerDays = Number(players[0]?.playerDays ?? 0);

  return {
    days: [...byDay.values()],
    gross,
    net,
    usd: net * devexRate,
    devexRate,
    sales: Number(t?.sales ?? 0),
    payers,
    conversion: unique ? payers / unique : null,
    /** Net Robux per daily active player. */
    arpdau: playerDays ? net / playerDays : null,
    /** Net Robux per paying player. */
    arppu: payers ? net / payers : null,
    items: items.map((i) => ({
      kind: i.kind,
      itemId: i.itemId?.toString() ?? null,
      name: i.name,
      sales: Number(i.sales),
      gross: Number(i.gross),
      net: Number(i.net),
    })),
    kinds: kinds.map((k) => ({ kind: k.kind, gross: Number(k.gross), net: Number(k.net) })),
  };
}

export type AudienceRow = { label: string | null; sessions: number; players: number; avgSeconds: number };

/**
 * Last 30 days of sessions split by device (from the optional client
 * script; null when it isn't installed) and by country.
 */
export async function gameAudience(gameId: string, env: Env) {
  const from = new Date(Date.now() - 30 * 86_400_000);
  const split = (column: "device" | "country", limit: number) =>
    prisma.$queryRawUnsafe<{ label: string | null; sessions: bigint; players: bigint; secs: number | null }[]>(
      `SELECT ${column} AS label, count(*) AS sessions, count(DISTINCT "robloxUserId") AS players,
         avg(EXTRACT(EPOCH FROM "lastSeenAt" - "startedAt"))::float8 AS secs
       FROM "AnalyticsSession" WHERE "gameId" = $1 AND env = $2 AND "startedAt" >= $3
       GROUP BY 1 ORDER BY players DESC LIMIT ${limit}`,
      gameId,
      env,
      from,
    );
  const [devices, countries] = await Promise.all([split("device", 10), split("country", 12)]);
  const shape = (rows: Awaited<ReturnType<typeof split>>): AudienceRow[] =>
    rows.map((r) => ({
      label: r.label,
      sessions: Number(r.sessions),
      players: Number(r.players),
      avgSeconds: Math.round(r.secs ?? 0),
    }));
  return { devices: shape(devices), countries: shape(countries) };
}
