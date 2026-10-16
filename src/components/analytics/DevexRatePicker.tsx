"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DevexRatePicker({
  gameId,
  rate,
  options,
}: {
  gameId: string;
  rate: number;
  options: readonly { rate: number; label: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const known = options.some((o) => o.rate === rate);

  return (
    <label className="text-ink-2 flex flex-wrap items-center gap-2 text-sm">
      USD at
      <select
        className="input !w-auto !py-1.5"
        value={rate}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          await fetch(`/api/analytics/games/${gameId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ devexRate: Number(e.target.value) }),
          });
          setBusy(false);
          router.refresh();
        }}
      >
        {!known && <option value={rate}>${rate} per Robux</option>}
        {options.map((o) => (
          <option key={o.rate} value={o.rate}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
