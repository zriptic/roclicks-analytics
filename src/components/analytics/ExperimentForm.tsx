"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Row = { name: string; value: string; weight: string };

function lookup(config: unknown, path: string): unknown {
  let node = config;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/**
 * Start an A/B test. Values are typed as JSON (50, "red", true, {"a":1}); a
 * bare word that isn't JSON is taken as a string, so `red` works too.
 */
export function ExperimentForm({
  gameId,
  env,
  config,
  keys,
  markers,
}: {
  gameId: string;
  env: "prod" | "studio";
  config: unknown;
  keys: string[];
  markers: string[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [goal, setGoal] = useState("");
  const [rows, setRows] = useState<Row[]>([
    { name: "A", value: "", weight: "1" },
    { name: "B", value: "", weight: "1" },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parse = (text: string): unknown => {
    const t = text.trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  };
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <form
      className="panel space-y-4 p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const res = await fetch(`/api/analytics/games/${gameId}/experiments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            env,
            name,
            key,
            goal,
            variants: rows.map((r) => ({ name: r.name, value: parse(r.value), weight: Number(r.weight) })),
          }),
        });
        const body = await res.json().catch(() => ({}));
        setBusy(false);
        if (!res.ok) return setError(body.error ?? "Couldn't start the test.");
        setName("");
        setKey("");
        setGoal("");
        setRows([
          { name: "A", value: "", weight: "1" },
          { name: "B", value: "", weight: "1" },
        ]);
        router.refresh();
      }}
    >
      <p className="text-ink font-semibold">New test</p>
      <label className="block space-y-1.5">
        <span className="text-ink-2 text-sm">Name</span>
        <input className="input py-2 text-sm" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="More starter coins" required />
      </label>
      <label className="block space-y-1.5">
        <span className="text-ink-2 text-sm">Config key it changes</span>
        <input
          className="input py-2 font-mono text-sm"
          value={key}
          list="exp-keys"
          placeholder="starterCoins"
          required
          onChange={(e) => {
            const k = e.target.value.trim();
            setKey(e.target.value);
            // Start the control from what the config says today.
            const current = lookup(config, k);
            if (current !== undefined && typeof current !== "object") {
              setRows((rs) => (rs[0].value ? rs : rs.map((r, i) => (i === 0 ? { ...r, value: JSON.stringify(current) } : r))));
            }
          }}
        />
        <datalist id="exp-keys">
          {keys.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-ink-2 mb-1.5 text-sm">Variants (the first is the control)</legend>
        <div className="text-ink-3 grid grid-cols-[4.5rem_minmax(0,1fr)_3.5rem_1.5rem] gap-2 text-xs">
          <span>Name</span>
          <span>Value</span>
          <span>Weight</span>
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[4.5rem_minmax(0,1fr)_3.5rem_1.5rem] items-center gap-2">
            <input className="input px-2 py-2 text-sm" value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} maxLength={20} aria-label={`Variant ${i + 1} name`} required />
            <input className="input px-2 py-2 font-mono text-sm" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder={i === 0 ? "50" : "150"} aria-label={`Variant ${i + 1} value`} required />
            <input className="input px-2 py-2 text-sm tabular-nums" value={r.weight} onChange={(e) => setRow(i, { weight: e.target.value })} inputMode="numeric" aria-label={`Variant ${i + 1} weight`} required />
            {rows.length > 2 ? (
              <button type="button" className="text-ink-3 hover:text-ink text-lg leading-none" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove variant ${r.name}`}>
                ×
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
        {rows.length < 4 && (
          <button
            type="button"
            className="btn-quiet text-sm"
            onClick={() => setRows((rs) => [...rs, { name: String.fromCharCode(65 + rs.length), value: "", weight: "1" }])}
          >
            Add a variant
          </button>
        )}
      </fieldset>

      <label className="block space-y-1.5">
        <span className="text-ink-2 text-sm">Goal marker (optional)</span>
        <input className="input py-2 text-sm" value={goal} onChange={(e) => setGoal(e.target.value)} list="exp-markers" placeholder="LevelUp" />
        <datalist id="exp-markers">
          {markers.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>

      <button type="submit" className="btn-primary w-full justify-center" disabled={busy}>
        {busy ? "Starting..." : "Start test"}
      </button>
      {error && <p className="text-danger text-sm">{error}</p>}
    </form>
  );
}
