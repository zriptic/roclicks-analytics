import { prisma } from "@/lib/db";
import { EVENT_NAME, MAX_VALUE_BYTES, type Env } from "./limits";

/**
 * A/B tests on remote config. A test replaces one config key with 2 to 4
 * variants. The SDK picks a player's variant itself from a hash of the test
 * id and the user id (assignVariant below, mirrored in the Luau SDK), so a
 * player sees the same value on every server and every visit, and the API
 * never has to remember who got what before they show up.
 *
 * The first time a server hands a player a variant it reports an exposure.
 * Results only count what each player did after their exposure, so players
 * who never reached the tested code don't dilute the comparison.
 */
export const MAX_VARIANTS = 4;
export const MAX_RUNNING_TESTS = 10;
export const EXPERIMENT_KEY = /^[A-Za-z0-9_]{1,40}(\.[A-Za-z0-9_]{1,40}){0,4}$/;
const VARIANT_NAME = /^[A-Za-z0-9_ -]{1,20}$/;
const BUCKETS = 10_000;

export type Variant = { name: string; value: unknown; weight: number };
export type ExperimentInput = { name: string; key: string; variants: Variant[]; goal: string | null };

/** FNV-1a, 32 bit, over the UTF-8 bytes. The Luau SDK has the same function. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The variant a player gets. Weights are relative: 50/50, 1/1, 90/10. */
export function assignVariant(experimentId: string, userId: number | bigint, variants: Pick<Variant, "name" | "weight">[]): string {
  const bucket = fnv1a(`${experimentId}:${userId}`) % BUCKETS;
  const total = variants.reduce((sum, v) => sum + v.weight, 0);
  let acc = 0;
  for (const v of variants) {
    acc += v.weight;
    if (bucket < Math.floor((acc * BUCKETS) / total)) return v.name;
  }
  return variants[variants.length - 1].name;
}

export function parseExperimentInput(body: unknown): ExperimentInput | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 60) return "Give the test a name of up to 60 characters.";
  const key = typeof b.key === "string" ? b.key.trim() : "";
  if (!EXPERIMENT_KEY.test(key)) return "The config key must look like starterCoins or shop.price (letters, digits, _ and dots).";
  const goal = typeof b.goal === "string" && b.goal.trim() ? b.goal.trim() : null;
  if (goal !== null && !EVENT_NAME.test(goal)) return "The goal must be a marker name.";

  if (!Array.isArray(b.variants) || b.variants.length < 2 || b.variants.length > MAX_VARIANTS) {
    return `A test needs 2 to ${MAX_VARIANTS} variants.`;
  }
  const variants: Variant[] = [];
  for (const raw of b.variants as unknown[]) {
    const v = (raw ?? {}) as Record<string, unknown>;
    const vname = typeof v.name === "string" ? v.name.trim() : "";
    if (!VARIANT_NAME.test(vname)) return "Variant names are 1 to 20 letters, digits, spaces, _ or -.";
    if (variants.some((o) => o.name === vname)) return `Two variants are called "${vname}".`;
    if (v.value === undefined || v.value === null) return `Variant "${vname}" needs a value.`;
    if (JSON.stringify(v.value).length > MAX_VALUE_BYTES) return `Variant "${vname}" is over ${MAX_VALUE_BYTES} bytes.`;
    const weight = Number(v.weight ?? 1);
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) return "Weights are whole numbers from 1 to 100.";
    variants.push({ name: vname, value: v.value, weight });
  }
  return { name, key, variants, goal };
}

/**
 * Bump the config version so every server refetches on its next flush.
 * Starting or stopping a test changes what servers should hand out even
 * though the config JSON itself didn't change.
 */
export async function bumpConfigVersion(gameId: string, env: Env): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "AnalyticsConfig" ("gameId", env, values, version, "updatedAt")
    VALUES (${gameId}, ${env}, '{}'::jsonb, 1, now())
    ON CONFLICT ("gameId", env) DO UPDATE SET version = "AnalyticsConfig".version + 1, "updatedAt" = now()`;
}

/** Running tests for the SDK, sent along with the config. */
export async function runningExperiments(gameId: string, env: Env) {
  const rows = await prisma.analyticsExperiment.findMany({
    where: { gameId, env, status: "running" },
    select: { id: true, key: true, variants: true },
    orderBy: { startedAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    variants: (r.variants as Variant[]).map((v) => ({ name: v.name, value: v.value, weight: v.weight })),
  }));
}

/** Copy of `obj` with the dotted `path` set to `value`, creating tables on the way. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(obj ?? {});
  const parts = path.split(".");
  let node = out;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
  return out;
}

export function getPath(obj: unknown, path: string): unknown {
  let node = obj;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** How a variant compares to the control on one metric. */
export type Verdict = "better" | "worse" | "unclear" | "early";

export type VariantResult = {
  name: string;
  value: unknown;
  weight: number;
  players: number;
  /** Players exposed before today, the only ones who could have come back. */
  eligible: number;
  returned: number;
  playSeconds: number;
  payers: number;
  netRobux: number;
  goal: number | null;
  verdicts: { returned: Verdict; play: Verdict; payers: Verdict; revenue: Verdict; goal: Verdict } | null;
};

/** Players per variant before a verdict is shown at all. */
export const MIN_PLAYERS = 30;
const Z95 = 1.96;

function proportionVerdict(a: number, an: number, b: number, bn: number): Verdict {
  if (an < MIN_PLAYERS || bn < MIN_PLAYERS) return "early";
  const p = (a + b) / (an + bn);
  const se = Math.sqrt(p * (1 - p) * (1 / an + 1 / bn));
  if (!se) return "unclear";
  const z = (b / bn - a / an) / se;
  return z >= Z95 ? "better" : z <= -Z95 ? "worse" : "unclear";
}

/** Welch's test with a normal approximation; fine at the sample sizes we require. */
function meanVerdict(am: number, asd: number, an: number, bm: number, bsd: number, bn: number): Verdict {
  if (an < MIN_PLAYERS || bn < MIN_PLAYERS) return "early";
  const se = Math.sqrt((asd * asd) / an + (bsd * bsd) / bn);
  if (!se) return "unclear";
  const z = (bm - am) / se;
  return z >= Z95 ? "better" : z <= -Z95 ? "worse" : "unclear";
}

type Row = {
  variant: string;
  players: bigint;
  eligible: bigint;
  returned: bigint;
  play_avg: number | null;
  play_sd: number | null;
  payers: bigint;
  rev_avg: number | null;
  rev_sd: number | null;
  goal: bigint;
};

export async function experimentResults(exp: {
  id: string;
  gameId: string;
  env: string;
  variants: unknown;
  goal: string | null;
  startedAt: Date;
  stoppedAt: Date | null;
}): Promise<VariantResult[]> {
  const end = exp.stoppedAt ?? new Date();
  const today = new Date().toISOString().slice(0, 10);
  // Each metric is one set-based join over the test's time window, so the
  // existing (gameId, env, time) indexes do the narrowing.
  const rows = await prisma.$queryRaw<Row[]>`
    WITH x AS (
      SELECT "robloxUserId" AS u, variant, at FROM "AnalyticsExposure" WHERE "experimentId" = ${exp.id}
    ), play AS (
      SELECT x.u, sum(EXTRACT(EPOCH FROM LEAST(s."lastSeenAt", ${end}) - GREATEST(s."startedAt", x.at))) AS secs
      FROM x JOIN "AnalyticsSession" s ON s."robloxUserId" = x.u
      WHERE s."gameId" = ${exp.gameId} AND s.env = ${exp.env}
        AND s."lastSeenAt" >= ${exp.startedAt} AND s."startedAt" <= ${end} AND s."lastSeenAt" > x.at
      GROUP BY x.u
    ), back AS (
      SELECT DISTINCT x.u FROM x JOIN "AnalyticsActiveDay" d ON d."robloxUserId" = x.u
      WHERE d."gameId" = ${exp.gameId} AND d.env = ${exp.env}
        AND d.day > ${exp.startedAt}::date AND d.day <= ${end}::date AND d.day > x.at::date
    ), paid AS (
      SELECT x.u, sum(p."netRobux") AS net
      FROM x JOIN "AnalyticsPurchase" p ON p."robloxUserId" = x.u
      WHERE p."gameId" = ${exp.gameId} AND p.env = ${exp.env}
        AND p.at >= ${exp.startedAt} AND p.at <= ${end} AND p.at >= x.at
      GROUP BY x.u
    ), hit AS (
      SELECT DISTINCT x.u FROM x JOIN "AnalyticsEvent" e ON e."robloxUserId" = x.u
      WHERE ${exp.goal}::text IS NOT NULL AND e."gameId" = ${exp.gameId} AND e.env = ${exp.env}
        AND e.name = ${exp.goal} AND e.at >= ${exp.startedAt} AND e.at <= ${end} AND e.at >= x.at
    ), per AS (
      SELECT x.variant, x.at::date < ${today}::date AS eligible, back.u IS NOT NULL AS returned,
        COALESCE(play.secs, 0)::float8 AS secs, paid.u IS NOT NULL AS payer, COALESCE(paid.net, 0)::float8 AS net,
        hit.u IS NOT NULL AS goal
      FROM x
      LEFT JOIN play ON play.u = x.u
      LEFT JOIN back ON back.u = x.u
      LEFT JOIN paid ON paid.u = x.u
      LEFT JOIN hit ON hit.u = x.u
    )
    SELECT variant, count(*) AS players,
      count(*) FILTER (WHERE eligible) AS eligible,
      count(*) FILTER (WHERE eligible AND returned) AS returned,
      avg(secs) AS play_avg, stddev_samp(secs) AS play_sd,
      count(*) FILTER (WHERE payer) AS payers,
      avg(net) AS rev_avg, stddev_samp(net) AS rev_sd,
      count(*) FILTER (WHERE goal) AS goal
    FROM per GROUP BY variant`;

  const by = new Map(rows.map((r) => [r.variant, r]));
  const variants = exp.variants as Variant[];
  const stats = variants.map((v) => {
    const r = by.get(v.name);
    return {
      v,
      n: Number(r?.players ?? 0),
      eligible: Number(r?.eligible ?? 0),
      returned: Number(r?.returned ?? 0),
      playAvg: r?.play_avg ?? 0,
      playSd: r?.play_sd ?? 0,
      payers: Number(r?.payers ?? 0),
      revAvg: r?.rev_avg ?? 0,
      revSd: r?.rev_sd ?? 0,
      goal: Number(r?.goal ?? 0),
    };
  });
  const c = stats[0];
  return stats.map((s, i) => ({
    name: s.v.name,
    value: s.v.value,
    weight: s.v.weight,
    players: s.n,
    eligible: s.eligible,
    returned: s.returned,
    playSeconds: s.playAvg,
    payers: s.payers,
    netRobux: s.revAvg,
    goal: exp.goal ? s.goal : null,
    verdicts:
      i === 0
        ? null
        : {
            returned: proportionVerdict(c.returned, c.eligible, s.returned, s.eligible),
            play: meanVerdict(c.playAvg, c.playSd, c.n, s.playAvg, s.playSd, s.n),
            payers: proportionVerdict(c.payers, c.n, s.payers, s.n),
            revenue: meanVerdict(c.revAvg, c.revSd, c.n, s.revAvg, s.revSd, s.n),
            goal: exp.goal ? proportionVerdict(c.goal, c.n, s.goal, s.n) : "unclear",
          },
  }));
}
