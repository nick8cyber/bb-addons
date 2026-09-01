/**
 * The provider's standing notice, rendered as a settings section.
 *
 * Two facts a user of this provider is entitled to before a turn runs, and
 * neither is discoverable from the picker: threads on agy execute tools with
 * no approval step, and the bridge keeps a local log. Both are consequences
 * of agy's stream-json dialect rather than choices this plugin could undo, so
 * they are stated where the provider is configured instead of buried in the
 * README of a repository most users will never open.
 *
 * No controls: there is nothing here to toggle. A section that only tells the
 * truth is still the right surface — it is the one place bb renders a
 * plugin's own copy next to the provider it describes.
 */

function AlertGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function InfoGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

export function AgySafetySection() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed">
        <AlertGlyph className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="min-w-0 flex-1 text-foreground">
          <span className="font-medium">Turns run without approval prompts.</span>{" "}
          agy's stream-json has no approval back channel — there is no message
          the bridge could answer a permission request with — so it declares a
          single permission mode, <code className="font-mono">full</code>, and
          starts agy with{" "}
          <code className="font-mono">--dangerously-skip-permissions</code>. A
          thread on this provider reads, writes and runs commands in its
          workspace directory without asking first. Give it a directory you
          would let an unattended process edit.
        </div>
      </div>
      <div className="flex items-start gap-2 text-xs leading-relaxed">
        <InfoGlyph className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 text-muted-foreground">
          <span className="font-medium text-foreground">What the bridge writes down.</span>{" "}
          <code className="font-mono">bridge.log</code>, in this plugin's data
          directory, records the agy command line,{" "}
          <code className="font-mono">HOME</code>,{" "}
          <code className="font-mono">PATH</code> and agy's stderr. The values
          of environment variables passed to a thread are never written to it.
          The log stays on the machine that ran the turn.
        </div>
      </div>
    </div>
  );
}
