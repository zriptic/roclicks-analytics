"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Stop (optionally keeping one variant) or delete a test. */
export function ExperimentActions({
  gameId,
  id,
  running,
  variants,
  suggested,
}: {
  gameId: string;
  id: string;
  running: boolean;
  variants: string[];
  /** Variant to preselect, e.g. the one that's winning. */
  suggested?: string;
}) {
  const router = useRouter();
  const [keep, setKeep] = useState(suggested ?? variants[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = async (method: "PATCH" | "DELETE", body?: object) => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/analytics/games/${gameId}/experiments/${id}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(out.error ?? "That didn't work.");
    router.refresh();
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {running && (
        <>
          <select className="input !w-auto !py-1.5 text-sm" value={keep} onChange={(e) => setKeep(e.target.value)} disabled={busy} aria-label="Variant to keep">
            {variants.map((v) => (
              <option key={v} value={v}>
                Keep {v}
              </option>
            ))}
          </select>
          <button
            className="btn-primary !py-1.5 text-sm"
            disabled={busy}
            onClick={() => {
              if (confirm(`Stop the test and give every player variant ${keep}? This writes its value into the config.`)) call("PATCH", { keep });
            }}
          >
            Stop and keep
          </button>
          <button
            className="btn-quiet !py-1.5 text-sm"
            disabled={busy}
            onClick={() => {
              if (confirm("Stop the test without changing the config? Players go back to the config's value.")) call("PATCH", {});
            }}
          >
            Stop only
          </button>
        </>
      )}
      <button
        className="text-ink-3 hover:text-danger px-2 py-1.5 text-sm transition-colors"
        disabled={busy}
        onClick={() => {
          if (confirm("Delete this test and its results? This can't be undone.")) call("DELETE");
        }}
      >
        Delete
      </button>
      {error && <span className="text-danger text-sm">{error}</span>}
    </div>
  );
}
