"use client";

import { useEffect, useRef, useState } from "react";
import { formatValue, type ChartFormat } from "@/lib/analytics/format";

function shortDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * A "nice" axis ceiling: 1, 2 or 5 times a power of ten, or for durations a
 * whole number of minutes so the half-way tick lands on a round value.
 */
function niceMax(v: number, format: ChartFormat): number {
  if (format === "duration") {
    for (const m of [1, 2, 4, 10, 20, 30, 60, 120, 240]) if (m * 60 >= v) return m * 60;
    return Math.ceil(v / 3600) * 3600;
  }
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * One series over the last 30 UTC days. Area for running totals (DAU),
 * bars for per-day counts. Hover anywhere in a day's column for its value.
 */
export function DayChart({
  points,
  format = "count",
  kind = "area",
  label,
}: {
  points: { day: string; value: number }[];
  format?: ChartFormat;
  kind?: "area" | "bar";
  label: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 180;
  const padL = 44;
  const padR = 8;
  const padT = 10;
  const padB = 24;
  const plotW = width - padL - padR;
  const plotH = H - padT - padB;
  const max = niceMax(Math.max(...points.map((p) => p.value), 0), format);
  const n = points.length;
  const step = plotW / n;
  const x = (i: number) => padL + step * i + step / 2;
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];

  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const area = `${line}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const labelEvery = Math.ceil(n / Math.max(2, Math.floor(plotW / 70)));

  const hovered = hover !== null ? points[hover] : null;

  return (
    <div ref={wrap} className="relative w-full min-w-0 overflow-hidden select-none">
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`${label}, last ${n} days`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const i = Math.floor((e.clientX - rect.left - padL) / step);
          setHover(i >= 0 && i < n ? i : null);
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="var(--line-soft)" strokeWidth={1} />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--ink-3)" className="tabular-nums">
              {format === "duration" ? `${t / 60}m` : t >= 1000 ? `${t / 1000}k` : t}
            </text>
          </g>
        ))}

        {kind === "area" ? (
          <>
            <path d={area} fill="var(--signal)" opacity={0.16} />
            <path d={line} fill="none" stroke="var(--signal-hi)" strokeWidth={2} strokeLinejoin="round" />
          </>
        ) : (
          points.map((p, i) => {
            const bw = Math.max(2, step - 2);
            const h = y(0) - y(p.value);
            const r = Math.min(4, bw / 2, h);
            const bx = x(i) - bw / 2;
            const top = y(p.value);
            // Rounded top only; the end at the baseline stays square.
            return h > 0 ? (
              <path
                key={p.day}
                d={`M${bx},${y(0)}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + bw - r}Q${bx + bw},${top} ${bx + bw},${top + r}V${y(0)}Z`}
                fill={hover === i ? "var(--signal-hi)" : "var(--signal)"}
              />
            ) : null;
          })
        )}

        {points.map((p, i) =>
          i % labelEvery === (n - 1) % labelEvery ? (
            <text
              key={p.day}
              x={i === n - 1 ? width - padR : x(i)}
              y={H - 6}
              textAnchor={i === n - 1 ? "end" : "middle"}
              fontSize={11}
              fill="var(--ink-3)"
            >
              {shortDay(p.day)}
            </text>
          ) : null,
        )}

        {hovered && hover !== null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={y(0)} stroke="var(--ink-3)" strokeWidth={1} strokeDasharray="3 3" />
            {kind === "area" && (
              <circle cx={x(hover)} cy={y(hovered.value)} r={4.5} fill="var(--signal-hi)" stroke="var(--surface)" strokeWidth={2} />
            )}
          </g>
        )}
      </svg>

      {hovered && hover !== null && (
        <div
          className="panel pointer-events-none absolute top-0 z-10 px-3 py-2 text-xs shadow-lg"
          style={{
            left: Math.min(Math.max(x(hover) - 60, 0), width - 130),
            background: "var(--surface-2)",
          }}
        >
          <div className="text-ink-3">{shortDay(hovered.day)}</div>
          <div className="text-ink font-semibold tabular-nums">
            {formatValue(hovered.value, format)} <span className="text-ink-2 font-normal">{label.toLowerCase()}</span>
          </div>
        </div>
      )}
    </div>
  );
}
