/**
 * The presentation kit this settings section is built from.
 *
 * Two rules hold the visual design together and both live here rather than in
 * the screens:
 *
 * 1. Every colour is one of bb's own semantic tokens — `success`, `warning`,
 *    `destructive-text`, `surface-*`, `subtle-foreground`. Hand-picked palette
 *    colours (amber-500, emerald-600, …) are what made this section read as a
 *    foreign page pasted into bb; the tokens track both themes for free.
 * 2. Meaning is carried by one small set of shapes — a status dot, a badge, a
 *    note, a row, a panel — so a user learns the surface once. A screen that
 *    needs to say something new reaches for an existing shape with a different
 *    tone rather than inventing a box.
 *
 * Nothing here knows anything about providers; the domain lives in atoms.tsx.
 */
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { AlertIcon, CheckIcon, ChevronDownIcon, CloseIcon, InfoIcon } from "./icons.js";

/** The whole section speaks in five tones and nothing else. */
export type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

export const TEXT_TONE: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  ok: "text-success",
  warn: "text-warning-text",
  danger: "text-destructive-text",
  accent: "text-foreground",
};

const DOT_TONE: Record<Tone, string> = {
  neutral: "bg-subtle-foreground/60",
  ok: "bg-success",
  warn: "bg-warning",
  danger: "bg-destructive",
  accent: "bg-primary",
};

const BADGE_TONE: Record<Tone, string> = {
  neutral: "border-border text-subtle-foreground",
  ok: "border-success/40 text-success",
  warn: "border-warning/45 text-warning-text",
  danger: "border-surface-destructive-border text-destructive-text",
  accent: "border-surface-selected-border bg-surface-selected text-foreground",
};

/* -- text ------------------------------------------------------------------ */

/** Coloured status wording, e.g. "in models.json" or a probe failure. */
export function ToneText({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return <span className={cn("font-medium", TEXT_TONE[tone], className)}>{children}</span>;
}

/** Identifiers, paths and key references: never prose, always monospace. */
export function Mono({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("font-mono text-2xs", className)}>{children}</span>;
}

/**
 * A single dot-separated line of secondary facts. Each item truncates on its
 * own so a long base URL cannot push the model count off the row.
 */
export function MetaLine({ items, className }: { items: ReactNode[]; className?: string }) {
  const shown = items.filter((item) => item !== undefined && item !== null && item !== false && item !== "");
  if (shown.length === 0) return null;
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground", className)}>
      {shown.map((item, index) => (
        <span key={index} className="flex min-w-0 items-center gap-1.5">
          {index > 0 && <span aria-hidden="true" className="text-border">·</span>}
          <span className="min-w-0 truncate">{item}</span>
        </span>
      ))}
    </div>
  );
}

/* -- markers --------------------------------------------------------------- */

export function Dot({ tone = "neutral", className }: { tone?: Tone; className?: string }) {
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_TONE[tone], className)} />;
}

/**
 * A badge is for a state a row is *in*, not for a fact about it — facts belong
 * in the meta line. Sentence case, never uppercase tracking: this sits inside
 * bb's chrome, which does not shout.
 */
export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-2xs leading-4 font-medium whitespace-nowrap",
        BADGE_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* -- messages -------------------------------------------------------------- */

const NOTE_SURFACE: Record<Tone, string> = {
  neutral: "border-border bg-surface-recessed",
  ok: "border-success/30 bg-success/8",
  warn: "border-warning/35 bg-warning/8",
  danger: "border-surface-destructive-border bg-surface-destructive",
  accent: "border-surface-selected-border bg-surface-selected",
};

/**
 * One line of explanation attached to a control.
 *
 * The default is unboxed: an icon and muted text sitting under whatever it
 * explains, which is how bb annotates its own settings. `boxed` is reserved for
 * a condition the user must act on — drift, a blocked save — where a tinted
 * band is the point rather than decoration.
 */
export function Note({
  tone = "neutral",
  boxed = false,
  icon = true,
  onDismiss,
  className,
  children,
}: {
  tone?: Tone;
  boxed?: boolean;
  icon?: boolean;
  onDismiss?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const Glyph = tone === "warn" || tone === "danger" ? AlertIcon : InfoIcon;
  return (
    <div
      className={cn(
        "flex items-start gap-2 text-xs leading-relaxed",
        boxed ? cn("rounded-md border px-3 py-2", NOTE_SURFACE[tone]) : undefined,
        className,
      )}
    >
      {icon && <Glyph className={cn("mt-0.5 size-3.5", TEXT_TONE[tone])} />}
      <div className={cn("min-w-0 flex-1", boxed ? "text-foreground" : "text-muted-foreground")}>{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-muted-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground hover:duration-0"
        >
          <CloseIcon className="size-3" />
        </button>
      )}
    </div>
  );
}

/* -- structure ------------------------------------------------------------- */

/**
 * The heading above a group of rows: a name, how many rows it holds, and a
 * one-line reason the group exists. The reason truncates rather than wrapping —
 * it is orientation, not documentation, and the full text stays in the tooltip.
 */
export function GroupHeading({ title, count, hint }: { title: string; count?: number; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2 px-0.5">
      <h3 className="shrink-0 text-xs font-semibold text-foreground">{title}</h3>
      {count !== undefined && <span className="shrink-0 text-2xs tabular-nums text-subtle-foreground">{count}</span>}
      {hint && (
        <p className="min-w-0 flex-1 truncate text-2xs text-subtle-foreground" title={hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * The surface an editing flow lives on — adding, adopting, or the expanded
 * detail of a row. One border, one header, generous inner rhythm; anything it
 * contains uses `Block`, never another card.
 */
export function Panel({
  title,
  subtitle,
  badges,
  actions,
  onClose,
  className,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("overflow-hidden rounded-lg border border-border bg-card", className)}>
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-border-hairline px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</h3>
            {badges}
          </div>
          {subtitle && <div className="mt-1 min-w-0">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground hover:duration-0"
            >
              <CloseIcon />
            </button>
          )}
        </div>
      </header>
      <div className="space-y-5 px-4 py-4">{children}</div>
    </section>
  );
}

/**
 * A titled stretch inside a panel. Deliberately borderless: nesting boxes is
 * what turned the old layout into a stack of frames, so separation here is
 * whitespace and a small heading.
 */
export function Block({
  title,
  actions,
  className,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("space-y-2.5", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title && <h4 className="text-xs font-semibold text-foreground">{title}</h4>}
          {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** The row of buttons that closes a flow. Primary first, quiet ones after. */
export function ActionBar({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2 border-t border-border-hairline pt-3.5", className)}>
      {children}
    </div>
  );
}

/** Pushes whatever follows it to the far end of an ActionBar. */
export function Spacer() {
  return <div className="flex-1" />;
}

export function EmptyState({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-md border border-dashed border-border px-3 py-4 text-center text-xs leading-relaxed text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* -- form controls --------------------------------------------------------- */

/** Label above, control below, optional hint under it. The only field shape. */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="text-2xs leading-relaxed text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** A native select wearing the same shell as Input, chevron included. */
export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className="relative min-w-0">
      <select
        className={cn(
          "h-9 w-full appearance-none rounded-md border border-input bg-transparent pl-3 pr-8 text-sm transition-colors duration-150 hover:duration-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 max-md:pointer-coarse:h-10",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

/**
 * A tick with a title and, when the consequence is not obvious, a sentence
 * under it. Radios and checkboxes look identical apart from the input, because
 * to the reader they are the same gesture: choose this.
 */
export function Choice({
  type = "radio",
  checked,
  onSelect,
  disabled,
  title,
  description,
  tone,
  className,
}: {
  type?: "radio" | "checkbox";
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  title: ReactNode;
  description?: ReactNode;
  /** Colours the description when the choice carries a real consequence. */
  tone?: Tone;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "-mx-2 flex items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-150 hover:duration-0",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-state-hover",
        className,
      )}
    >
      <input
        type={type}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="mt-0.5 size-3.5 shrink-0 accent-primary"
      />
      <span className="min-w-0 text-xs leading-relaxed">
        <span className="block font-medium text-foreground">{title}</span>
        {description && (
          <span className={cn("mt-0.5 block", tone ? TEXT_TONE[tone] : "text-muted-foreground")}>{description}</span>
        )}
      </span>
    </label>
  );
}

/**
 * A selectable card for one of a handful of starting points. Selection is a
 * tinted surface plus a tick — colour alone is not a state anyone can see at a
 * glance in a dense grid.
 */
export function ChoiceTile({
  selected,
  title,
  description,
  onSelect,
  disabled,
}: {
  selected: boolean;
  title: ReactNode;
  description?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-1 rounded-md border px-3 py-2.5 text-left transition-colors duration-150 hover:duration-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-surface-selected-border bg-surface-selected"
          : "border-border bg-transparent hover:bg-state-hover",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
        <span className="min-w-0 truncate">{title}</span>
        {selected && <CheckIcon className="size-3 shrink-0 text-primary" />}
      </span>
      {description && <span className="line-clamp-2 text-2xs leading-snug text-muted-foreground">{description}</span>}
    </button>
  );
}

/**
 * A two-or-three way switch for a setting whose options are short words. Used
 * where radios would cost three lines to say one thing.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex items-center gap-0.5 rounded-md bg-surface-recessed p-0.5", className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "cursor-pointer rounded-sm px-2.5 py-1 text-xs font-medium transition-colors duration-150 hover:duration-0 disabled:cursor-not-allowed disabled:opacity-50",
              active
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* -- lists ----------------------------------------------------------------- */

export interface ModelPickerRow {
  id: string;
  /** Context/output summary, already formatted. */
  size?: string;
  /** Right-aligned pricing chip. */
  price?: ReactNode;
  /** Extra state wording, e.g. "delisted" or "new". */
  tags?: ReactNode;
}

/**
 * The catalogue picker, shared by adding and by editing an existing provider.
 * It scrolls inside a recessed well so a hundred model ids never push the
 * buttons that act on them off the screen.
 */
export function ModelPicker({
  rows,
  selected,
  onToggle,
  disabled,
  empty,
  className,
}: {
  rows: ModelPickerRow[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  disabled?: boolean;
  empty: ReactNode;
  className?: string;
}) {
  if (rows.length === 0) {
    return <EmptyState className={className}>{empty}</EmptyState>;
  }
  return (
    <div
      className={cn(
        "max-h-64 overflow-y-auto rounded-md border border-border bg-surface-recessed p-1",
        className,
      )}
    >
      {rows.map((row) => (
        <label
          key={row.id}
          className={cn(
            "flex items-center gap-2 rounded-sm px-2 py-1 text-xs transition-none",
            disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-state-hover",
          )}
        >
          <input
            type="checkbox"
            disabled={disabled}
            checked={selected.has(row.id)}
            onChange={() => onToggle(row.id)}
            className="size-3.5 shrink-0 accent-primary"
          />
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground">{row.id}</span>
          {row.size && <span className="shrink-0 text-2xs whitespace-nowrap text-subtle-foreground">{row.size}</span>}
          {row.tags}
          {row.price}
        </label>
      ))}
    </div>
  );
}
