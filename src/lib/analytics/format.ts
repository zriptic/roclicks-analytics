export type ChartFormat = "count" | "duration";

export function formatValue(v: number, format: ChartFormat): string {
  if (format === "duration") {
    const m = Math.floor(v / 60);
    const s = Math.round(v % 60);
    return m ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
  }
  return v.toLocaleString("en-US");
}
