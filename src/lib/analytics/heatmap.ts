import { prisma } from "@/lib/db";
import type { Env } from "./limits";

/**
 * Top-down heatmap of where a marker happened, from the x/z the SDK stores
 * with every marker (a player's character position by default).
 *
 * Binning happens in Postgres, so a million markers come back as at most
 * GRID x GRID counts. The map is framed on the 1st to 99th percentile of
 * positions, so one marker fired at a spawn far away can't squash the rest
 * into a single cell; markers outside that frame are counted and reported.
 */
export const HEATMAP_GRID = 64;
export const HEATMAP_RANGES = [1, 7, 30, 90] as const;
export type HeatmapRange = (typeof HEATMAP_RANGES)[number];

export type HeatmapMarker = { name: string; count: number };

export type Heatmap = {
  markers: HeatmapMarker[];
  marker: string | null;
  days: HeatmapRange;
  /** Absent when the chosen marker has no positions in the range. */
  grid?: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    cols: number;
    rows: number;
    cell: number;
    /** [col, row, count, avgY] for every non-empty cell. */
    cells: [number, number, number, number][];
    max: number;
    total: number;
    outside: number;
  };
};

export function readRange(v: string | undefined): HeatmapRange {
  const n = Number(v);
  return (HEATMAP_RANGES as readonly number[]).includes(n) ? (n as HeatmapRange) : 7;
}

export async function gameHeatmap(
  gameId: string,
  env: Env,
  wanted: string | undefined,
  days: HeatmapRange,
): Promise<Heatmap> {
  const from = new Date(Date.now() - days * 86_400_000);

  const names = await prisma.$queryRaw<{ name: string; n: bigint }[]>`
    SELECT name, count(*) AS n FROM "AnalyticsEvent"
    WHERE "gameId" = ${gameId} AND env = ${env} AND at >= ${from} AND x IS NOT NULL AND z IS NOT NULL
    GROUP BY name ORDER BY n DESC LIMIT 40`;
  const markers = names.map((r) => ({ name: r.name, count: Number(r.n) }));
  const marker = markers.find((m) => m.name === wanted)?.name ?? markers[0]?.name ?? null;
  if (!marker) return { markers, marker: null, days };

  const [b] = await prisma.$queryRaw<
    { x0: number | null; x1: number | null; z0: number | null; z1: number | null; total: bigint }[]
  >`
    SELECT
      percentile_cont(0.01) WITHIN GROUP (ORDER BY x) AS x0,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY x) AS x1,
      percentile_cont(0.01) WITHIN GROUP (ORDER BY z) AS z0,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY z) AS z1,
      count(*) AS total
    FROM "AnalyticsEvent"
    WHERE "gameId" = ${gameId} AND env = ${env} AND name = ${marker} AND at >= ${from}
      AND x IS NOT NULL AND z IS NOT NULL`;
  if (!b || b.x0 === null || b.x1 === null || b.z0 === null || b.z1 === null) return { markers, marker, days };

  // Square cells: the longer side gets GRID cells, the other side as many as
  // fit, with a little padding so edge markers aren't cut in half. A map that
  // is a single point still gets a small frame around it.
  const pad = (lo: number, hi: number) => {
    const span = Math.max(hi - lo, 8);
    const mid = (lo + hi) / 2;
    return [mid - span * 0.55, mid + span * 0.55] as const;
  };
  const [minX, maxX] = pad(b.x0, b.x1);
  const [minZ, maxZ] = pad(b.z0, b.z1);
  const cell = Math.max(maxX - minX, maxZ - minZ) / HEATMAP_GRID;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cell));

  const binned = await prisma.$queryRaw<{ c: number; r: number; n: bigint; y: number }[]>`
    SELECT floor((x - ${minX}) / ${cell})::int AS c, floor((z - ${minZ}) / ${cell})::int AS r,
      count(*) AS n, avg(y)::float8 AS y
    FROM "AnalyticsEvent"
    WHERE "gameId" = ${gameId} AND env = ${env} AND name = ${marker} AND at >= ${from}
      AND x >= ${minX} AND x < ${maxX} AND z >= ${minZ} AND z < ${maxZ}
    GROUP BY 1, 2`;

  const cells: [number, number, number, number][] = [];
  let inside = 0;
  let max = 0;
  for (const r of binned) {
    if (r.c < 0 || r.r < 0 || r.c >= cols || r.r >= rows) continue;
    const n = Number(r.n);
    inside += n;
    max = Math.max(max, n);
    cells.push([r.c, r.r, n, Math.round((r.y ?? 0) * 10) / 10]);
  }
  const total = Number(b.total);

  return {
    markers,
    marker,
    days,
    grid: { minX, maxX, minZ, maxZ, cols, rows, cell, cells, max, total, outside: total - inside },
  };
}
