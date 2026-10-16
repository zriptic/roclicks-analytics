"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

/**
 * Raw JSON editor for one env's config. Saving bumps the version, and every
 * running server picks it up on its next flush (15 s live, 5 s in Studio).
 */
export function ConfigEditor({
  gameId,
  env,
  initial,
  version,
}: {
  gameId: string;
  env: "prod" | "studio";
  initial: unknown;
  version: number;
}) {
  const router = useRouter();
  const start = useMemo(() => JSON.stringify(initial ?? {}, null, 2), [initial]);
  const [text, setText] = useState(start);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  let parseError: string | null = null;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) parseError = "The top level must be an object: { ... }";
  } catch (e) {
    parseError = (e as Error).message;
  }
  const dirty = text !== start;

  return (
    <div className="space-y-3">
      <textarea
        aria-label={`${env} config JSON`}
        className="input min-h-[22rem] font-mono text-[13px] leading-relaxed"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setMessage(null);
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn-primary"
          disabled={busy || !dirty || parseError !== null}
          onClick={async () => {
            setBusy(true);
            const res = await fetch(`/api/analytics/games/${gameId}/config`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ env, values: JSON.parse(text), baseVersion: version }),
            });
            const body = await res.json().catch(() => ({}));
            setBusy(false);
            if (!res.ok) return setMessage({ ok: false, text: body.error ?? "Save failed." });
            setMessage({ ok: true, text: `Saved as version ${body.version}. Servers pick it up on their next flush.` });
            router.refresh();
          }}
        >
          {busy ? "Saving..." : `Save ${env === "prod" ? "live" : "Studio"} config`}
        </button>
        {dirty && (
          <button className="btn-quiet" onClick={() => setText(start)} disabled={busy}>
            Discard changes
          </button>
        )}
        <span className="text-ink-3 text-sm tabular-nums">Version {version}</span>
        {parseError && dirty && <span className="text-danger text-sm">{parseError}</span>}
        {message && <span className={message.ok ? "text-ok text-sm" : "text-danger text-sm"}>{message.text}</span>}
      </div>
    </div>
  );
}
