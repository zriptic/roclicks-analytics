"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function GameDanger({ gameId, name }: { gameId: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex flex-wrap gap-3">
      <button
        className="btn-ghost"
        disabled={busy}
        onClick={async () => {
          if (!confirm("Make a new SDK key? The old key stops working within a minute, so update your game first or right after.")) return;
          setBusy(true);
          await fetch(`/api/analytics/games/${gameId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rotateKey: true }),
          });
          setBusy(false);
          router.refresh();
        }}
      >
        Rotate SDK key
      </button>
      <button
        className="btn-ghost !text-danger"
        disabled={busy}
        onClick={async () => {
          if (prompt(`This deletes every session, marker and config for this game. Type ${name} to confirm.`) !== name) return;
          setBusy(true);
          await fetch(`/api/analytics/games/${gameId}`, { method: "DELETE" });
          router.push("/analytics");
          router.refresh();
        }}
      >
        Delete game
      </button>
    </div>
  );
}
