import { prisma } from "@/lib/db";
import type { Env } from "./limits";

/**
 * Ordered funnels over markers. A step is a marker name, optionally narrowed
 * to one value of a key in the marker's value table:
 *
 *   ShopOpened
 *   TutorialStep[step=3]      -> TutorialStep markers whose value.step is 3
 *
 * A player reaches step N if they fired steps 1..N in that order (each step's
 * first time at or after the previous step's) inside the time range. Only
 * player markers count; global markers have no player to follow.
 */
export const FUNNEL_RANGES = [7, 30, 90] as const;
export type FunnelRange = (typeof FUNNEL_RANGES)[number];
export const MAX_FUNNEL_STEPS = 8;

export type FunnelStepSpec = { raw: string; name: string; key?: string; value?: string };
export type FunnelStep = FunnelStepSpec & {
  users: number;
  /** Share of the players who did step 1. */
  ofFirst: number | null;
  /** Share of the players who did the previous step. */
  ofPrevious: number | null;
  /** Median seconds from the previous step, for players who made it. */
  medianSeconds: number | null;
};

// Marker names never contain "[" or "=", so the filter syntax can't collide.
const STEP = /^([A-Za-z0-9_ .:/-]{1,64}?)(?:\[([A-Za-z0-9_]{1,40})=([^\]]{1,64})\])?$/;

export function parseStep(raw: string): FunnelStepSpec | null {
  const m = STEP.exec(raw.trim());
  if (!m) return null;
  const name = m[1].trim();
  return m[2] ? { raw: raw.trim(), name, key: m[2], value: m[3] } : { raw: raw.trim(), name };
}

export function readFunnelRange(v: string | undefined): FunnelRange {
  const n = Number(v);
  return (FUNNEL_RANGES as readonly number[]).includes(n) ? (n as FunnelRange) : 30;
}

export function readSteps(v: string | string[] | undefined): { steps: FunnelStepSpec[]; invalid: string[] } {
  const list = (Array.isArray(v) ? v : v ? [v] : []).map((s) => s.trim()).filter(Boolean);
  const steps: FunnelStepSpec[] = [];
  const invalid: string[] = [];
  for (const raw of list.slice(0, MAX_FUNNEL_STEPS)) {
    const step = parseStep(raw);
    if (step) steps.push(step);
    else invalid.push(raw);
  }
  return { steps, invalid };
}

/** Player marker names from the range, busiest first, to build steps from. */
export async function funnelMarkerNames(gameId: string, env: Env, days: FunnelRange): Promise<string[]> {
  const from = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT name FROM "AnalyticsEvent"
    WHERE "gameId" = ${gameId} AND env = ${env} AND at >= ${from} AND "robloxUserId" IS NOT NULL
    GROUP BY name ORDER BY count(*) DESC LIMIT 50`;
  return rows.map((r) => r.name);
}

export async function gameFunnel(
  gameId: string,
  env: Env,
  specs: FunnelStepSpec[],
  days: FunnelRange,
): Promise<FunnelStep[]> {
  if (!specs.length) return [];
  const from = new Date(Date.now() - days * 86_400_000);

  // Built with numbered parameters only: every user-supplied piece (names,
  // keys, values) is a bound parameter, never spliced into the SQL text.
  const params: unknown[] = [gameId, env, from, [...new Set(specs.map((s) => s.name))]];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const match = (alias: string, s: FunnelStepSpec) =>
    `${alias}.name = ${p(s.name)}` + (s.key ? ` AND ${alias}.value ->> ${p(s.key)} = ${p(s.value)}` : "");

  const ctes = [
    `ev AS (SELECT "robloxUserId" AS u, name, value, at FROM "AnalyticsEvent"
      WHERE "gameId" = $1 AND env = $2 AND at >= $3 AND "robloxUserId" IS NOT NULL AND name = ANY($4::text[]))`,
    `s1 AS (SELECT e.u, min(e.at) AS t FROM ev e WHERE ${match("e", specs[0])} GROUP BY e.u)`,
  ];
  for (let i = 1; i < specs.length; i++) {
    ctes.push(
      `s${i + 1} AS (SELECT e.u, min(e.at) AS t FROM ev e JOIN s${i} prev ON e.u = prev.u AND e.at >= prev.t
        WHERE ${match("e", specs[i])} GROUP BY e.u)`,
    );
  }
  const selects = [`SELECT 1 AS k, count(*) AS users, NULL::float8 AS median FROM s1`];
  for (let i = 1; i < specs.length; i++) {
    selects.push(
      `SELECT ${i + 1}, count(*), percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM cur.t - prev.t))
        FROM s${i + 1} cur JOIN s${i} prev ON cur.u = prev.u`,
    );
  }
  const sql = `WITH ${ctes.join(",\n")}\n${selects.join("\nUNION ALL\n")}\nORDER BY k`;

  const rows = await prisma.$queryRawUnsafe<{ k: number; users: bigint; median: number | null }[]>(sql, ...params);
  const first = Number(rows[0]?.users ?? 0);
  return specs.map((spec, i) => {
    const users = Number(rows[i]?.users ?? 0);
    const prev = i === 0 ? null : Number(rows[i - 1]?.users ?? 0);
    return {
      ...spec,
      users,
      ofFirst: first ? users / first : null,
      ofPrevious: prev === null ? null : prev ? users / prev : null,
      medianSeconds: i === 0 || rows[i]?.median === null || rows[i]?.median === undefined ? null : Math.round(rows[i].median!),
    };
  });
}
