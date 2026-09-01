/**
 * The provider's settings section: how to make agy work, then what it is
 * allowed to do once it does.
 *
 * Installing this plugin does not install the CLI, and bb cannot sign in on
 * the user's behalf — the credential belongs to the machine that runs the
 * turn. Without those two steps the picker simply has no models, which looks
 * like a broken plugin and is not, so the steps come first and name the
 * machine explicitly.
 *
 * Then two facts a user is entitled to before a turn runs, neither of them
 * visible from the picker: threads on agy execute tools with no approval
 * step, and the bridge keeps a local log. Both follow from agy's stream-json
 * dialect rather than from choices this plugin could undo.
 *
 * No controls anywhere: there is nothing here to toggle. A section that only
 * tells the truth is still the right surface — it is the one place bb renders
 * a plugin's own copy next to the provider it describes.
 */

import type { ReactNode } from "react";

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

function Cmd({ children }: { children: string }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] break-all">
      {children}
    </code>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium text-muted-foreground">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="font-medium text-foreground">{title}</div>
        <div className="text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

export function AgySafetySection() {
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-3 text-xs leading-relaxed">
        <Step n={1} title="Install the agy CLI on the machine that runs your threads">
          <p>
            <Cmd>curl -fsSL https://antigravity.google/cli/install.sh | bash</Cmd>{" "}
            — Windows uses the PowerShell installer from the same page. It
            lands at <Cmd>~/.local/bin/agy</Cmd>, which this provider checks
            before it checks <Cmd>PATH</Cmd>; set <Cmd>AGY_PATH</Cmd> to point
            it somewhere else.
          </p>
        </Step>
        <Step n={2} title="Sign in, on that same machine">
          <p>
            Run <Cmd>agy</Cmd> once. There is no login subcommand: the first
            run opens a browser, and over SSH it prints a URL and takes the
            code you paste back. It needs a Google account with Antigravity
            access, and the credential is kept by the machine's keyring — bb
            never sees it. For a headless host, agy also accepts{" "}
            <Cmd>GEMINI_API_KEY</Cmd> with{" "}
            <Cmd>"modelProvider": "gemini"</Cmd> in{" "}
            <Cmd>~/.gemini/antigravity-cli/settings.json</Cmd>.
          </p>
        </Step>
        <Step n={3} title="Check it took">
          <p>
            <Cmd>agy models</Cmd> on that machine lists the models; the same
            list is what this provider offers in the picker. An empty picker
            here means one of the two steps above has not happened on the
            machine bb is asking.
          </p>
        </Step>
      </ol>
      <div className="border-t" />
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
