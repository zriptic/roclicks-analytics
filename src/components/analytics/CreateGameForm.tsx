"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function CreateGameForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-3 sm:flex-row"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const res = await fetch("/api/analytics/games", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const body = await res.json().catch(() => ({}));
        setBusy(false);
        if (!res.ok) return setError(body.error ?? "Couldn't create the game.");
        router.push(`/analytics/${body.id}?tab=setup`);
      }}
    >
      <label className="sr-only" htmlFor="game-name">Game name</label>
      <input
        id="game-name"
        className="input sm:max-w-sm"
        placeholder="Game name, e.g. Mega Obby"
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
      />
      <button className="btn-primary" disabled={busy || !name.trim()}>
        {busy ? "Adding..." : "Add game"}
      </button>
      {error && <p className="text-danger self-center text-sm">{error}</p>}
    </form>
  );
}
