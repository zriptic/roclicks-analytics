import type { Heatmap } from "@/lib/analytics/heatmap";

/**
 * Colour for a cell, from a dim red through the signal colour to a near-white
 * yellow. `t` is 0..1 on a log scale, so one hotspot with thousands of
 * markers doesn't wash every other cell out to nothing.
 */
function heat(t: number): string {
  const l = 0.42 + t * 0.5; // lightness
  const c = 0.2 - t * 0.06; // chroma eases off as it brightens
  const h = 26 + t * 64; // red -> orange -> yellow
  const a = 0.35 + t * 0.65;
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)} / ${a.toFixed(2)})`;
}

function studs(v: number): string {
  return `${Math.round(v)}`;
}

/** Top-down heatmap: X runs left to right, Z top to bottom, in studs. */
export function HeatmapGrid({ grid, marker }: { grid: NonNullable<Heatmap["grid"]>; marker: string }) {
  const { cols, rows, cells, max, cell, minX, minZ, maxX, maxZ } = grid;
  const logMax = Math.log1p(max);

  return (
    <figure className="min-w-0">
      <div className="panel overflow-hidden p-3">
        <svg
          viewBox={`0 0 ${cols} ${rows}`}
          className="block h-auto w-full"
          style={{ background: "var(--surface-2)", aspectRatio: `${cols} / ${rows}` }}
          role="img"
          aria-label={`Heatmap of ${marker}, ${grid.total.toLocaleString("en-US")} markers seen from above`}
          shapeRendering="crispEdges"
        >
          {/* light reference grid every 8 cells */}
          {Array.from({ length: Math.floor(cols / 8) + 1 }, (_, i) => (
            <line key={`v${i}`} x1={i * 8} x2={i * 8} y1={0} y2={rows} stroke="var(--line-soft)" strokeWidth={0.08} />
          ))}
          {Array.from({ length: Math.floor(rows / 8) + 1 }, (_, i) => (
            <line key={`h${i}`} y1={i * 8} y2={i * 8} x1={0} x2={cols} stroke="var(--line-soft)" strokeWidth={0.08} />
          ))}
          {cells.map(([c, r, n, y]) => (
            <rect key={`${c},${r}`} x={c} y={r} width={1} height={1} fill={heat(logMax ? Math.log1p(n) / logMax : 1)}>
              <title>
                {`${n.toLocaleString("en-US")} × ${marker}\nx ${studs(minX + c * cell)} to ${studs(minX + (c + 1) * cell)}, z ${studs(minZ + r * cell)} to ${studs(minZ + (r + 1) * cell)}\naverage height y ${y}`}
              </title>
            </rect>
          ))}
        </svg>
      </div>
      <figcaption className="text-ink-3 mt-2 flex flex-wrap items-center justify-between gap-3 text-xs">
        <span>
          Seen from above. X {studs(minX)} to {studs(maxX)}, Z {studs(minZ)} to {studs(maxZ)} studs; each square is{" "}
          {cell < 10 ? cell.toFixed(1) : Math.round(cell)} studs across.
        </span>
        <span className="flex items-center gap-2">
          1
          <span
            className="inline-block h-2.5 w-28 rounded-sm"
            style={{ background: `linear-gradient(90deg, ${heat(0)}, ${heat(0.5)}, ${heat(1)})` }}
            aria-hidden="true"
          />
          {max.toLocaleString("en-US")} per square
        </span>
      </figcaption>
    </figure>
  );
}
