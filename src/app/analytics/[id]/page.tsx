import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { Header } from "@/components/Header";
import { DayChart } from "@/components/analytics/DayChart";
import { formatValue } from "@/lib/analytics/format";
import { ConfigEditor } from "@/components/analytics/ConfigEditor";
import { CopyText } from "@/components/analytics/CopyText";
import { GameDanger } from "@/components/analytics/GameDanger";
import { gameAudience, gameOverview, gameRevenue, type AudienceRow, type Cohort } from "@/lib/analytics/queries";
import { DevexRatePicker } from "@/components/analytics/DevexRatePicker";
import { HeatmapGrid } from "@/components/analytics/HeatmapGrid";
import { HEATMAP_RANGES, gameHeatmap, readRange, type HeatmapRange } from "@/lib/analytics/heatmap";
import {
  FUNNEL_RANGES,
  MAX_FUNNEL_STEPS,
  funnelMarkerNames,
  gameFunnel,
  readFunnelRange,
  readSteps,
  type FunnelRange,
} from "@/lib/analytics/funnel";
import { readConfig } from "@/lib/analytics/config";
import { ExperimentForm } from "@/components/analytics/ExperimentForm";
import { ExperimentActions } from "@/components/analytics/ExperimentActions";
import { MIN_PLAYERS, experimentResults, type Verdict } from "@/lib/analytics/experiments";
import { DEVEX_RATES, FREE_EVENTS_PER_MONTH, OWNER_SHARE, readEnv, type Env } from "@/lib/analytics/limits";

export const dynamic = "force-dynamic";
export const metadata = { title: "Game analytics", robots: { index: false } };

type Tab = "overview" | "revenue" | "heatmap" | "funnels" | "config" | "tests" | "setup";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "revenue", label: "Revenue" },
  { id: "heatmap", label: "Heatmap" },
  { id: "funnels", label: "Funnels" },
  { id: "config", label: "Remote config" },
  { id: "tests", label: "A/B tests" },
  { id: "setup", label: "Setup" },
];

function pct(v: number | null): string {
  return v === null ? "–" : `${(v * 100).toFixed(1)}%`;
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="panel p-4">
      <div className="text-ink-3 text-xs font-semibold tracking-wide uppercase">{label}</div>
      <div className="eyebrow-rank text-ink mt-1.5 text-2xl">{value}</div>
      {note && <div className="text-ink-3 mt-1 text-xs">{note}</div>}
    </div>
  );
}

/** Retention cell: the signal hue gets more opaque as retention rises. */
function RetentionCell({ kept, size }: { kept: number | null; size: number }) {
  if (kept === null) return <td className="text-ink-3 px-3 py-2 text-center">–</td>;
  const r = size ? kept / size : 0;
  return (
    <td
      className="text-ink px-3 py-2 text-center tabular-nums"
      style={{ background: `oklch(0.6 0.216 26 / ${(0.08 + r * 0.7).toFixed(2)})` }}
      title={`${kept} of ${size} players came back`}
    >
      {(r * 100).toFixed(0)}%
    </td>
  );
}

function CohortTable({ cohorts }: { cohorts: Cohort[] }) {
  if (!cohorts.length) return <p className="text-ink-2 text-sm">No players yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] border-separate border-spacing-y-0.5 text-sm">
        <thead>
          <tr className="text-ink-3 text-xs uppercase">
            <th className="px-3 py-2 text-left font-semibold">Joined</th>
            <th className="px-3 py-2 text-right font-semibold">Players</th>
            <th className="px-3 py-2 font-semibold">Day 1</th>
            <th className="px-3 py-2 font-semibold">Day 7</th>
            <th className="px-3 py-2 font-semibold">Day 30</th>
          </tr>
        </thead>
        <tbody>
          {cohorts.slice(0, 31).map((c) => (
            <tr key={c.day}>
              <td className="text-ink-2 px-3 py-2">
                {new Date(c.day + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
              </td>
              <td className="text-ink-2 px-3 py-2 text-right tabular-nums">{c.size.toLocaleString("en-US")}</td>
              <RetentionCell kept={c.d1} size={c.size} />
              <RetentionCell kept={c.d7} size={c.size} />
              <RetentionCell kept={c.d30} size={c.size} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const DEVICE_LABEL: Record<string, string> = {
  phone: "Phone",
  tablet: "Tablet",
  desktop: "Computer",
  console: "Console",
  vr: "VR",
};
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

function AudienceBars({ rows, label }: { rows: AudienceRow[]; label: (v: string | null) => string }) {
  const total = rows.reduce((s, r) => s + r.players, 0);
  return (
    <ul className="space-y-2.5 text-sm">
      {rows.map((r) => (
        <li key={r.label ?? "none"}>
          <div className="flex items-baseline justify-between gap-3">
            <span className={r.label ? "text-ink" : "text-ink-3"}>{label(r.label)}</span>
            <span className="text-ink-2 tabular-nums">
              {r.players.toLocaleString("en-US")}
              <span className="text-ink-3"> · {formatValue(r.avgSeconds, "duration")} avg</span>
            </span>
          </div>
          <div className="bg-surface-2 mt-1 h-1.5 overflow-hidden rounded-full" aria-hidden="true">
            <div className="bg-signal h-full rounded-full" style={{ width: `${total ? (r.players / total) * 100 : 0}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

async function Overview({ gameId, env }: { gameId: string; env: Env }) {
  const [o, audience] = await Promise.all([gameOverview(gameId, env), gameAudience(gameId, env)]);
  const noDevices = audience.devices.every((d) => d.label === null);
  const today = o.days[o.days.length - 1];
  const avgSession =
    o.days.reduce((s, d) => s + d.avgSeconds * d.sessions, 0) / Math.max(1, o.days.reduce((s, d) => s + d.sessions, 0));

  if (o.totalPlayers === 0 && o.recent.length === 0) {
    return (
      <div className="panel mt-8 p-6">
        <p className="text-ink font-semibold">No {env === "studio" ? "Studio" : "live"} data yet.</p>
        <p className="text-ink-2 mt-2 text-sm leading-relaxed">
          Follow the <Link href={`/analytics/${gameId}?tab=setup`} className="text-signal-hi underline">setup steps</Link>,
          then {env === "studio" ? "press Play in Studio" : "join your published game"}. Data shows up here within 15 seconds.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Playing now" value={o.live.toLocaleString("en-US")} note="Heartbeat in the last 2 min" />
        <Stat label="Players today" value={today.dau.toLocaleString("en-US")} note={`${today.newUsers.toLocaleString("en-US")} new`} />
        <Stat label="Avg session" value={formatValue(Math.round(avgSession), "duration")} note="Last 30 days" />
        <Stat label="All-time players" value={o.totalPlayers.toLocaleString("en-US")} note={`${Math.round(o.totalPlaySeconds / 3600).toLocaleString("en-US")} h played`} />
        <Stat label="Day 1 retention" value={pct(o.retention.d1)} />
        <Stat label="Day 7 retention" value={pct(o.retention.d7)} />
        <Stat label="Day 30 retention" value={pct(o.retention.d30)} />
        <Stat
          label="Markers this month"
          value={o.eventsThisMonth.toLocaleString("en-US")}
          note={env === "prod" ? `cap ${FREE_EVENTS_PER_MONTH.toLocaleString("en-US")}` : "Studio markers don't count"}
        />
      </div>

      <section className="panel mt-6 min-w-0 p-5">
        <h2 className="text-ink font-bold">Daily active players</h2>
        <p className="text-ink-3 mb-3 text-xs">Unique players per UTC day</p>
        <DayChart label="Players" points={o.days.map((d) => ({ day: d.day, value: d.dau }))} />
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className="panel min-w-0 p-5">
          <h2 className="text-ink font-bold">New players</h2>
          <DayChart kind="bar" label="New" points={o.days.map((d) => ({ day: d.day, value: d.newUsers }))} />
        </section>
        <section className="panel min-w-0 p-5">
          <h2 className="text-ink font-bold">Sessions</h2>
          <DayChart kind="bar" label="Sessions" points={o.days.map((d) => ({ day: d.day, value: d.sessions }))} />
        </section>
        <section className="panel min-w-0 p-5">
          <h2 className="text-ink font-bold">Avg session length</h2>
          <DayChart kind="bar" format="duration" label="Avg" points={o.days.map((d) => ({ day: d.day, value: d.avgSeconds }))} />
        </section>
      </div>

      <section className="panel mt-4 min-w-0 p-5">
        <h2 className="text-ink font-bold">Retention by join day</h2>
        <p className="text-ink-3 mb-3 text-xs">
          Share of each day&apos;s new players who played again exactly 1, 7 or 30 days later. A dash means that day hasn&apos;t come yet.
        </p>
        <CohortTable cohorts={o.cohorts} />
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="panel min-w-0 p-5">
          <h2 className="text-ink font-bold">Devices</h2>
          <p className="text-ink-3 mb-3 text-xs">Players and average session, last 30 days</p>
          {noDevices ? (
            <p className="text-ink-2 text-sm leading-relaxed">
              Add the optional client script from{" "}
              <Link href={`/analytics/${gameId}?tab=setup`} className="text-signal-hi underline">
                setup
              </Link>{" "}
              to see phones, tablets, computers, consoles and VR. The server can&apos;t tell them apart on its own.
            </p>
          ) : (
            <AudienceBars rows={audience.devices} label={(v) => (v ? (DEVICE_LABEL[v] ?? v) : "Not reported")} />
          )}
        </section>
        <section className="panel min-w-0 p-5">
          <h2 className="text-ink font-bold">Countries</h2>
          <p className="text-ink-3 mb-3 text-xs">Players and average session, last 30 days</p>
          <AudienceBars rows={audience.countries} label={(v) => (v ? countryName(v) : "Unknown")} />
        </section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="panel min-w-0 p-5">
          <h2 className="text-ink mb-3 font-bold">Top markers, last 7 days</h2>
          {o.topEvents.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-ink-3 text-xs uppercase">
                  <th className="py-1.5 text-left font-semibold">Marker</th>
                  <th className="py-1.5 text-right font-semibold">Count</th>
                  <th className="py-1.5 text-right font-semibold">Players</th>
                </tr>
              </thead>
              <tbody>
                {o.topEvents.map((e) => (
                  <tr key={e.name} className="border-line-soft border-t">
                    <td className="text-ink py-2">{e.name}</td>
                    <td className="text-ink-2 py-2 text-right tabular-nums">{e.count.toLocaleString("en-US")}</td>
                    <td className="text-ink-2 py-2 text-right tabular-nums">{e.users.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-ink-2 text-sm">No markers in the last 7 days.</p>
          )}
        </section>
        <section className="panel min-w-0 p-5">
          <h2 className="text-ink mb-3 font-bold">Latest markers</h2>
          <ul className="max-h-[26rem] space-y-1 overflow-y-auto text-sm">
            {o.recent.map((e) => (
              <li key={e.id} className="border-line-soft flex gap-3 border-t py-2">
                <span className="text-ink-3 w-16 shrink-0 tabular-nums">
                  {new Date(e.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })}
                </span>
                <span className="text-ink shrink-0 font-medium">{e.name}</span>
                <span className="text-ink-3 min-w-0 truncate font-mono text-xs leading-5">
                  {e.userId ? `user ${e.userId} ` : ""}
                  {e.value !== null ? JSON.stringify(e.value) : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

const KIND_LABEL: Record<string, string> = {
  product: "Developer product",
  pass: "Game pass",
  subscription: "Subscription",
  private_server: "Private server",
  avatar_item: "Avatar item",
  other: "Other",
};

function robux(n: number): string {
  return `R$ ${Math.round(n).toLocaleString("en-US")}`;
}

function usd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 100 ? 2 : 0 });
}

async function Revenue({ gameId, env, devexRate }: { gameId: string; env: Env; devexRate: number }) {
  const r = await gameRevenue(gameId, env, devexRate);
  const cut = r.gross - r.net;

  return (
    <>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <p className="text-ink-2 text-sm">Last 30 days, UTC.</p>
        <DevexRatePicker gameId={gameId} rate={devexRate} options={DEVEX_RATES} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Players spent" value={robux(r.gross)} note={`${r.sales.toLocaleString("en-US")} sales, before Roblox's cut`} />
        <Stat label="You keep" value={robux(r.net)} note={`Roblox took ${robux(cut)}`} />
        <Stat label="Est. cash out" value={usd(r.usd)} note={`${robux(r.net)} × $${devexRate} DevEx`} />
        <Stat
          label="Paying players"
          value={r.payers.toLocaleString("en-US")}
          note={r.conversion === null ? undefined : `${(r.conversion * 100).toFixed(1)}% of players`}
        />
        <Stat label="Per daily player" value={r.arpdau === null ? "–" : `R$ ${r.arpdau.toFixed(2)}`} note="Net Robux / player-days (ARPDAU)" />
        <Stat label="Per paying player" value={r.arppu === null ? "–" : robux(r.arppu)} note="Net Robux (ARPPU)" />
      </div>

      <section className="panel mt-6 min-w-0 p-5">
        <h2 className="text-ink font-bold">Robux you keep per day</h2>
        <p className="text-ink-3 mb-3 text-xs">After Roblox&apos;s cut</p>
        <DayChart kind="bar" label="Robux" points={r.days.map((d) => ({ day: d.day, value: d.net }))} />
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_2fr]">
        <section className="panel min-w-0 p-5">
          <h2 className="text-ink mb-3 font-bold">By type</h2>
          {r.kinds.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-ink-3 text-xs uppercase">
                  <th className="py-1.5 text-left font-semibold">Type</th>
                  <th className="py-1.5 text-right font-semibold">You keep</th>
                  <th className="py-1.5 text-right font-semibold">Share</th>
                </tr>
              </thead>
              <tbody>
                {r.kinds.map((k) => (
                  <tr key={k.kind} className="border-line-soft border-t">
                    <td className="text-ink py-2">{KIND_LABEL[k.kind] ?? k.kind}</td>
                    <td className="text-ink-2 py-2 text-right tabular-nums">{robux(k.net)}</td>
                    <td className="text-ink-3 py-2 text-right tabular-nums">{Math.round((OWNER_SHARE[k.kind] ?? 0.7) * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-ink-2 text-sm">No sales in the last 30 days.</p>
          )}
        </section>
        <section className="panel min-w-0 p-5">
          <h2 className="text-ink mb-3 font-bold">Top items</h2>
          {r.items.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] text-sm">
                <thead>
                  <tr className="text-ink-3 text-xs uppercase">
                    <th className="py-1.5 text-left font-semibold">Item</th>
                    <th className="py-1.5 text-right font-semibold">Sales</th>
                    <th className="py-1.5 text-right font-semibold">Players paid</th>
                    <th className="py-1.5 text-right font-semibold">You keep</th>
                  </tr>
                </thead>
                <tbody>
                  {r.items.map((i) => (
                    <tr key={`${i.kind}-${i.itemId ?? i.name}`} className="border-line-soft border-t">
                      <td className="py-2">
                        <span className="text-ink block">{i.name ?? (i.itemId ? `#${i.itemId}` : "Unnamed")}</span>
                        <span className="text-ink-3 text-xs">{KIND_LABEL[i.kind] ?? i.kind}</span>
                      </td>
                      <td className="text-ink-2 py-2 text-right tabular-nums">{i.sales.toLocaleString("en-US")}</td>
                      <td className="text-ink-2 py-2 text-right tabular-nums">{robux(i.gross)}</td>
                      <td className="text-ink py-2 text-right tabular-nums">{robux(i.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-ink-2 text-sm">
              No sales yet. See <Link href={`/analytics/${gameId}?tab=setup`} className="text-signal-hi underline">Setup</Link>{" "}
              step 5 to record them.
            </p>
          )}
        </section>
      </div>

      <section className="text-ink-3 mt-6 max-w-3xl space-y-2 text-sm leading-relaxed">
        <p>
          <b className="text-ink-2">How the cut is counted.</b>{" "}You keep 70% of what players pay for developer products,
          game passes, private servers and subscriptions, and a 40% commission on avatar items sold in your game. Roblox
          rounds your share down to whole Robux on each sale.
        </p>
        <p>
          <b className="text-ink-2">Prices.</b>{" "}Developer products use the Robux the player actually paid, so regional
          prices and price tests are already in. Game passes use the pass&apos;s list price.
        </p>
        <p>
          <b className="text-ink-2">Not included.</b>{" "}Premium Payouts (paid for Premium players&apos; play time, not for
          sales), and Robux that are still pending. The USD figure is an estimate at the DevEx rate you pick. You need
          30,000 earned Robux to cash out, and anything earned before Sep 5, 2025 cashes out first at $0.0035.
        </p>
      </section>
    </>
  );
}

async function HeatmapTab({
  gameId,
  env,
  marker,
  days,
}: {
  gameId: string;
  env: Env;
  marker: string | undefined;
  days: HeatmapRange;
}) {
  const data = await gameHeatmap(gameId, env, marker, days);
  const link = (m: string | null, d: HeatmapRange) => {
    const q = new URLSearchParams({ tab: "heatmap", days: String(d) });
    if (m) q.set("marker", m);
    if (env === "studio") q.set("env", "studio");
    return `/analytics/${gameId}?${q}`;
  };

  if (!data.markers.length) {
    return (
      <div className="panel mt-8 max-w-2xl p-6">
        <p className="text-ink font-semibold">No positions in the last {days} days.</p>
        <p className="text-ink-2 mt-2 text-sm leading-relaxed">
          Markers sent for a player carry where their character was standing, so deaths, pickups and
          checkpoints show up here by themselves. For a global marker, pass a position:{" "}
          <code className="text-ink">Analytics.Track(nil, &quot;BossSpawned&quot;, nil, boss.Position)</code>.
        </p>
        <div className="mt-4 flex gap-2 text-sm">
          {HEATMAP_RANGES.filter((d) => d !== days).map((d) => (
            <Link key={d} href={link(null, d)} className="btn-ghost">
              Last {d} {d === 1 ? "day" : "days"}
            </Link>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <aside className="space-y-6">
        <div>
          <p className="text-ink-3 text-xs font-semibold tracking-wide uppercase">Time</p>
          <div className="panel mt-2 grid grid-cols-4 p-1 text-sm lg:grid-cols-2">
            {HEATMAP_RANGES.map((d) => (
              <Link
                key={d}
                href={link(data.marker, d)}
                aria-current={d === days ? "true" : undefined}
                className={`rounded-md px-2 py-1.5 text-center font-semibold transition-colors ${d === days ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink"}`}
              >
                {d === 1 ? "24h" : `${d}d`}
              </Link>
            ))}
          </div>
        </div>
        <div>
          <p className="text-ink-3 text-xs font-semibold tracking-wide uppercase">Marker</p>
          <ul className="mt-2 max-h-[26rem] space-y-0.5 overflow-y-auto text-sm">
            {data.markers.map((m) => (
              <li key={m.name}>
                <Link
                  href={link(m.name, days)}
                  aria-current={m.name === data.marker ? "true" : undefined}
                  className={`flex items-baseline justify-between gap-3 rounded-md px-2.5 py-1.5 transition-colors ${m.name === data.marker ? "bg-surface-2 text-ink font-semibold" : "text-ink-2 hover:text-ink"}`}
                >
                  <span className="min-w-0 truncate">{m.name}</span>
                  <span className="text-ink-3 text-xs tabular-nums">{m.count.toLocaleString("en-US")}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <div className="min-w-0">
        {data.grid && data.marker ? (
          <>
            <HeatmapGrid grid={data.grid} marker={data.marker} />
            {data.grid.outside > 0 && (
              <p className="text-ink-3 mt-2 text-xs">
                {data.grid.outside.toLocaleString("en-US")} of {data.grid.total.toLocaleString("en-US")}{" "}
                markers fall outside this frame and aren&apos;t drawn. The map is framed on the middle 98% of
                positions, so a few far-off markers can&apos;t shrink everything else.
              </p>
            )}
          </>
        ) : (
          <p className="text-ink-2 text-sm">No positions for this marker in the range.</p>
        )}
      </div>
    </div>
  );
}

function duration(sec: number): string {
  if (sec < 1) return "under 1s";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 172_800) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86_400)}d`;
}

async function FunnelsTab({
  gameId,
  env,
  rawSteps,
  days,
}: {
  gameId: string;
  env: Env;
  rawSteps: string | string[] | undefined;
  days: FunnelRange;
}) {
  const { steps: specs, invalid } = readSteps(rawSteps);
  const [names, steps] = await Promise.all([
    funnelMarkerNames(gameId, env, days),
    gameFunnel(gameId, env, specs, days),
  ]);
  // Without a funnel yet, start the form from the busiest markers.
  const prefill = specs.length ? specs.map((s) => s.raw) : names.slice(0, 3);
  const inputs = [...prefill, ...Array(Math.max(0, Math.min(MAX_FUNNEL_STEPS, prefill.length + 2) - prefill.length)).fill("")];
  const listId = `markers-${gameId}`;

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <form method="get" className="panel h-fit space-y-4 p-5">
        <input type="hidden" name="tab" value="funnels" />
        {env === "studio" && <input type="hidden" name="env" value="studio" />}
        <div>
          <p className="text-ink font-semibold">Steps, in order</p>
          <p className="text-ink-3 mt-1 text-xs leading-relaxed">
            A marker name, or one value of it: <code className="text-ink-2">TutorialStep[step=3]</code>. Empty
            boxes are skipped.
          </p>
        </div>
        <datalist id={listId}>
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <ol className="space-y-2">
          {inputs.map((v, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="text-ink-3 w-5 shrink-0 text-right text-xs tabular-nums">{i + 1}</span>
              <input
                name="s"
                defaultValue={v}
                list={listId}
                maxLength={140}
                placeholder={i === 0 ? "First marker" : "Then..."}
                className="input py-2 text-sm"
                aria-label={`Step ${i + 1}`}
              />
            </li>
          ))}
        </ol>
        <label className="text-ink-2 flex items-center justify-between gap-3 text-sm">
          Time range
          <select name="days" defaultValue={String(days)} className="input w-auto py-1.5 text-sm">
            {FUNNEL_RANGES.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-primary w-full justify-center">
          Show funnel
        </button>
        {invalid.length > 0 && (
          <p className="text-signal-hi text-xs">Skipped steps that aren&apos;t valid: {invalid.join(", ")}</p>
        )}
      </form>

      <div className="min-w-0">
        {!steps.length ? (
          <div className="panel p-6">
            <p className="text-ink font-semibold">Build a funnel to see where players drop off.</p>
            <p className="text-ink-2 mt-2 text-sm leading-relaxed">
              Pick markers in the order players should hit them, like <code className="text-ink">TutorialStep[step=1]</code>,
              <code className="text-ink"> TutorialStep[step=5]</code>, <code className="text-ink">ShopOpened</code>. Each bar
              shows how many players got that far, in that order, within the time range.
            </p>
          </div>
        ) : (
          <ol className="space-y-3">
            {steps.map((st, i) => (
              <li key={i} className="panel p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="text-ink min-w-0 font-semibold break-words">
                    <span className="text-ink-3 mr-2 text-sm tabular-nums">{i + 1}</span>
                    {st.name}
                    {st.key && (
                      <span className="text-ink-3 ml-1.5 text-sm font-normal">
                        {st.key} = {st.value}
                      </span>
                    )}
                  </p>
                  <p className="text-ink-2 text-sm tabular-nums">
                    <span className="text-ink font-semibold">{st.users.toLocaleString("en-US")}</span> players
                    {i > 0 && st.ofFirst !== null && <span className="text-ink-3"> · {pct(st.ofFirst)} of step 1</span>}
                  </p>
                </div>
                <div className="bg-surface-2 mt-3 h-2.5 overflow-hidden rounded-full" aria-hidden="true">
                  <div className="bg-signal h-full rounded-full" style={{ width: `${Math.max(st.ofFirst ?? 0, 0.004) * 100}%` }} />
                </div>
                {i > 0 && (
                  <p className="text-ink-3 mt-2 text-xs">
                    {st.ofPrevious !== null && (
                      <>
                        <span className={st.ofPrevious < 0.5 ? "text-signal-hi font-semibold" : ""}>
                          {pct(1 - st.ofPrevious)} dropped
                        </span>{" "}
                        after step {i}
                      </>
                    )}
                    {st.medianSeconds !== null && <> · typically {duration(st.medianSeconds)} later</>}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/** Every leaf path in the config, for the test form's key suggestions. */
function configPaths(values: unknown, prefix = "", depth = 0): string[] {
  if (!values || typeof values !== "object" || Array.isArray(values) || depth > 4) return [];
  return Object.entries(values as Record<string, unknown>).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v) ? configPaths(v, path, depth + 1) : [path];
  });
}

function Mark({ v }: { v: Verdict | undefined }) {
  if (v === "better") return <span className="text-ok ml-1.5 text-xs font-semibold">better</span>;
  if (v === "worse") return <span className="text-danger ml-1.5 text-xs font-semibold">worse</span>;
  return null;
}

function shortJson(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 24 ? s.slice(0, 23) + "…" : s;
}

async function TestsTab({ gameId, env }: { gameId: string; env: Env }) {
  const [config, tests, markers] = await Promise.all([
    readConfig(gameId, env),
    prisma.analyticsExperiment.findMany({
      where: { gameId, env },
      orderBy: [{ status: "asc" }, { startedAt: "desc" }], // "running" sorts before "stopped"
      take: 30,
    }),
    funnelMarkerNames(gameId, env, 30),
  ]);
  const results = await Promise.all(tests.map((t) => experimentResults(t)));

  return (
    <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-6">
        {!tests.length && (
          <div className="panel p-6">
            <p className="text-ink font-semibold">Try two values on real players and keep the one that works.</p>
            <p className="text-ink-2 mt-2 text-sm leading-relaxed">
              A test swaps one config key for a few variants. Read the key with the player passed in:
            </p>
            <pre className="bg-surface-2 text-ink mt-3 overflow-x-auto rounded-md p-3 text-[13px]">
              local coins = Analytics.Config.Get(&quot;starterCoins&quot;, 50, player)
            </pre>
            <p className="text-ink-2 mt-3 text-sm leading-relaxed">
              Each player keeps the same variant on every server and every visit. Results compare how often players came
              back, how long they played, how many paid and how many hit your goal marker, counted from the moment they
              got their variant.
            </p>
          </div>
        )}
        {tests.map((t, i) => {
          const rows = results[i];
          const early = rows.some((r) => r.players < MIN_PLAYERS);
          const winners = rows.filter(
            (r) => r.verdicts && Object.values(r.verdicts).includes("better") && !Object.values(r.verdicts).includes("worse"),
          );
          const running = t.status === "running";
          return (
            <section key={t.id} className="panel p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-ink font-semibold break-words">{t.name}</h3>
                  <p className="text-ink-3 mt-1 text-xs">
                    <code className="text-ink-2">{t.key}</code>
                    {t.goal && <> · goal {t.goal}</>} ·{" "}
                    {running
                      ? `running since ${t.startedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`
                      : `stopped ${t.stoppedAt?.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}${t.winner ? `, kept ${t.winner}` : ""}`}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${running ? "bg-signal/15 text-signal-hi" : "bg-surface-2 text-ink-3"}`}
                >
                  {running ? "Running" : "Stopped"}
                </span>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="text-ink-3 text-left text-xs">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Variant</th>
                      <th className="py-2 pr-3 text-right font-medium">Players</th>
                      <th className="py-2 pr-3 text-right font-medium">Came back</th>
                      <th className="py-2 pr-3 text-right font-medium">Play time</th>
                      <th className="py-2 pr-3 text-right font-medium">Paid</th>
                      <th className="py-2 pr-3 text-right font-medium">Robux each</th>
                      {t.goal && <th className="py-2 text-right font-medium">{t.goal}</th>}
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {rows.map((r, j) => (
                      <tr key={r.name} className="border-line-soft border-t">
                        <td className="py-2.5 pr-3">
                          <span className="text-ink font-semibold">{r.name}</span>
                          <span className="text-ink-3 ml-2 font-mono text-xs">{shortJson(r.value)}</span>
                          {j === 0 && <span className="text-ink-3 ml-2 text-xs">control</span>}
                        </td>
                        <td className="text-ink-2 py-2.5 pr-3 text-right">{r.players.toLocaleString("en-US")}</td>
                        <td className="text-ink py-2.5 pr-3 text-right">
                          {pct(r.eligible ? r.returned / r.eligible : null)}
                          <Mark v={r.verdicts?.returned} />
                        </td>
                        <td className="text-ink py-2.5 pr-3 text-right">
                          {r.players ? duration(Math.round(r.playSeconds)) : "-"}
                          <Mark v={r.verdicts?.play} />
                        </td>
                        <td className="text-ink py-2.5 pr-3 text-right">
                          {pct(r.players ? r.payers / r.players : null)}
                          <Mark v={r.verdicts?.payers} />
                        </td>
                        <td className="text-ink py-2.5 pr-3 text-right">
                          {r.players ? r.netRobux.toFixed(1) : "-"}
                          <Mark v={r.verdicts?.revenue} />
                        </td>
                        {t.goal && (
                          <td className="text-ink py-2.5 text-right">
                            {pct(r.players && r.goal !== null ? r.goal / r.players : null)}
                            <Mark v={r.verdicts?.goal} />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="text-ink-3 mt-3 text-xs leading-relaxed">
                {early
                  ? `Each variant needs ${MIN_PLAYERS} players before it can be called better or worse.`
                  : `"Better" and "worse" mean 95% sure against ${rows[0]?.name}; everything else is too close to call yet.`}{" "}
                Came back counts players who played again on a later day. Robux each is what you keep after Roblox&apos;s cut.
              </p>
              <div className="mt-4">
                <ExperimentActions
                  gameId={gameId}
                  id={t.id}
                  running={running}
                  variants={rows.map((r) => r.name)}
                  suggested={winners.length === 1 ? winners[0].name : undefined}
                />
              </div>
            </section>
          );
        })}
      </div>
      <div className="h-fit max-w-xl xl:sticky xl:top-6">
        <ExperimentForm gameId={gameId} env={env} config={config.values} keys={configPaths(config.values)} markers={markers} />
      </div>
    </div>
  );
}

function Setup({ sdkKey, gameId, name }: { sdkKey: string; gameId: string; name: string }) {
  const bootstrap = `local ServerScriptService = game:GetService("ServerScriptService")
local Analytics = require(ServerScriptService.RoClicksAnalytics)

Analytics.Setup({ key = "${sdkKey}" })`;
  const usage = `-- Anywhere on the server, after Setup:
Analytics.Track(player, "ShopOpened")
Analytics.Track(player, "Purchase", { item = "Sword", robux = 99 })
Analytics.Track(nil, "RoundStarted", { map = "Desert" })  -- not tied to a player

-- Remote config (edit it on the Remote config tab):
Analytics.Config.WaitForLoad()  -- optional, yields up to 10 s
local coins = Analytics.Config.Get("starterCoins", 50)  -- 50 if unset
local price = Analytics.Config.Get("shop.swordPrice", 120)
-- Pass the player to take part in A/B tests (A/B tests tab):
local coinsFor = Analytics.Config.Get("starterCoins", 50, player)
Analytics.Config.Changed:Connect(function(values, version)
	print("config is now version", version)
end)`;
  const revenue = `local MarketplaceService = game:GetService("MarketplaceService")

MarketplaceService.ProcessReceipt = Analytics.WrapProcessReceipt(function(receipt)
	local player = game.Players:GetPlayerByUserId(receipt.PlayerId)
	if not player then
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end
	-- give the item here
	return Enum.ProductPurchaseDecision.PurchaseGranted
end)

-- Sales the SDK can't see on its own (robux = what the player paid):
Analytics.TrackPurchase(player, { kind = "subscription", robux = 299, name = "VIP Monthly" })
Analytics.TrackPurchase(player, { kind = "private_server", robux = 100 })
Analytics.TrackPurchase(player, { kind = "avatar_item", robux = 75, name = "Cool Hat" })`;

  return (
    <div className="mt-8 max-w-3xl space-y-8">
      <section>
        <h2 className="text-ink text-lg font-bold">1. Add the module</h2>
        <p className="text-ink-2 mt-2 leading-relaxed">
          Download the model and drag it into <b className="text-ink">ServerScriptService</b>{" "}in Studio. It&apos;s one
          ModuleScript, no other dependencies.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          <a className="btn-primary" href="/api/analytics/sdk?format=rbxmx" download>
            Download RoClicksAnalytics.rbxmx
          </a>
          <a className="btn-ghost" href="/api/analytics/sdk?format=luau" download>
            Source (.luau)
          </a>
        </div>
      </section>

      <section>
        <h2 className="text-ink text-lg font-bold">2. Turn on HTTP requests</h2>
        <p className="text-ink-2 mt-2 leading-relaxed">
          Home &gt; Game Settings &gt; Security &gt; <b className="text-ink">Allow HTTP Requests</b>. The game has to be
          published for this setting to save.
        </p>
      </section>

      <section>
        <h2 className="text-ink text-lg font-bold">3. Start it from a server Script</h2>
        <p className="text-ink-2 mt-2 mb-3 leading-relaxed">
          This key only lets a game send data to <b className="text-ink">{name}</b>{" "}and read its config, so it&apos;s
          safe to keep in your scripts.
        </p>
        <CopyText text={bootstrap} />
        <p className="text-ink-3 mt-3 text-sm leading-relaxed">
          That&apos;s all it takes for players, sessions and retention. Playtests in Studio go to the separate Studio data
          (switch at the top of this page), so they never mix with live numbers.
        </p>
      </section>

      <section>
        <h2 className="text-ink text-lg font-bold">4. Track what matters</h2>
        <p className="text-ink-2 mt-2 mb-3 leading-relaxed">
          Marker names are up to 64 letters, digits, spaces or <code>_ . : / -</code>. Values can be numbers, strings or
          tables. Player markers also save where the character was standing.
        </p>
        <CopyText text={usage} />
      </section>

      <section>
        <h2 className="text-ink text-lg font-bold">5. Record sales</h2>
        <p className="text-ink-2 mt-2 mb-3 leading-relaxed">
          Game passes are recorded on their own. For developer products, wrap your ProcessReceipt so only purchases you
          grant are counted, with the exact Robux the player paid. The Revenue tab subtracts Roblox&apos;s cut for you.
        </p>
        <CopyText text={revenue} />
      </section>

      <section>
        <h2 className="text-ink text-lg font-bold">6. Devices (optional)</h2>
        <p className="text-ink-2 mt-2 leading-relaxed">
          A game server can&apos;t tell a phone from a computer. Drag this LocalScript into{" "}
          <b className="text-ink">StarterPlayer › StarterPlayerScripts</b> and the Overview tab splits players by phone,
          tablet, computer, console and VR. It sends one word per visit and needs no setup.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <a className="btn-ghost" href="/api/analytics/sdk?file=client&format=rbxmx" download>
            Download RoClicksAnalyticsClient.rbxmx
          </a>
        </div>
      </section>

      <section className="border-line-soft border-t pt-8">
        <h2 className="text-ink text-lg font-bold">Key and game</h2>
        <p className="text-ink-2 mt-2 mb-3 text-sm">SDK key</p>
        <CopyText text={sdkKey} />
        <div className="mt-5">
          <GameDanger gameId={gameId} name={name} />
        </div>
      </section>
    </div>
  );
}

export default async function GamePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; env?: string; marker?: string; days?: string; s?: string | string[] }>;
}) {
  const [{ id }, sp, session] = await Promise.all([params, searchParams, auth()]);
  if (!session?.user) redirect(`/signin?callbackUrl=/analytics/${id}`);
  const game = await prisma.analyticsGame.findFirst({ where: { id, ownerId: session.user.id } });
  if (!game) notFound();

  const tab: Tab = TABS.some((t) => t.id === sp.tab) ? (sp.tab as Tab) : "overview";
  const env = readEnv(sp.env);
  const href = (t: Tab, e: Env = env) => `/analytics/${id}?tab=${t}${e === "studio" ? "&env=studio" : ""}`;
  const config = tab === "config" ? await readConfig(id, env) : null;

  return (
    <>
      <Header />
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 pt-10 pb-20">
        <Link href="/analytics" className="text-ink-3 hover:text-ink text-sm transition-colors">
          ← All games
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <h1 className="display text-[clamp(1.75rem,4vw,2.75rem)]">{game.name}</h1>
          {tab !== "setup" && (
            <div className="panel flex p-1 text-sm" role="group" aria-label="Data source">
              {(["prod", "studio"] as Env[]).map((e) => (
                <Link
                  key={e}
                  href={href(tab, e)}
                  aria-current={env === e ? "true" : undefined}
                  className={`rounded-md px-3 py-1.5 font-semibold transition-colors ${env === e ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink"}`}
                >
                  {e === "prod" ? "Live" : "Studio"}
                </Link>
              ))}
            </div>
          )}
        </div>

        <nav className="border-line-soft mt-6 flex gap-1 overflow-x-auto border-b" aria-label="Sections">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={href(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={`-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors ${tab === t.id ? "border-signal text-ink" : "text-ink-3 hover:text-ink border-transparent"}`}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        {tab === "overview" && <Overview gameId={id} env={env} />}
        {tab === "revenue" && <Revenue gameId={id} env={env} devexRate={game.devexRate} />}
        {tab === "heatmap" && <HeatmapTab gameId={id} env={env} marker={sp.marker} days={readRange(sp.days)} />}
        {tab === "funnels" && <FunnelsTab gameId={id} env={env} rawSteps={sp.s} days={readFunnelRange(sp.days)} />}
        {tab === "config" && config && (
          <div className="mt-8 max-w-3xl">
            <p className="text-ink-2 mb-4 leading-relaxed">
              JSON your game reads with <code className="text-ink">Analytics.Config.Get(&quot;key&quot;)</code>. Saving
              reaches every running {env === "studio" ? "Studio playtest" : "live server"} within about 15 seconds, no
              update needed. Live and Studio each have their own config.
            </p>
            <ConfigEditor key={`${env}-${config.version}`} gameId={id} env={env} initial={config.values} version={config.version} />
          </div>
        )}
        {tab === "tests" && <TestsTab gameId={id} env={env} />}
        {tab === "setup" && <Setup sdkKey={game.sdkKey} gameId={id} name={game.name} />}
      </main>
    </>
  );
}
