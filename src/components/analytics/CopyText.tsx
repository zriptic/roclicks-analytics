"use client";

import { useState } from "react";

/** A code block with a Copy button. */
export function CopyText({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="bg-bg border-line-soft text-ink-2 overflow-x-auto rounded-[var(--radius)] border p-4 pr-20 text-[13px] leading-relaxed">
        {text}
      </pre>
      <button
        type="button"
        className="btn-ghost absolute top-2 right-2 !min-h-0 !px-3 !py-1.5 text-xs"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch {
            /* clipboard refused; the text is selectable */
          }
        }}
      >
        {copied ? "Copied" : label}
      </button>
    </div>
  );
}
