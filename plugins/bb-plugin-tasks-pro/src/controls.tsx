/** Small toolbar controls: dropdown shell, multi-select, date-range select. */
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DateRange } from "./query";

export function Dropdown({
  label,
  active,
  children,
}: {
  label: ReactNode;
  active?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-xs font-medium whitespace-nowrap ${
          active
            ? "border-primary bg-primary/10 text-primary"
            : "border-border bg-card text-foreground hover:bg-accent"
        }`}
      >
        {label}
        <span aria-hidden className="text-[9px]">
          ▼
        </span>
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-80 min-w-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export interface MultiSelectOption {
  value: string;
  label: string;
  hint?: string;
}

export function MultiSelect({
  label,
  options,
  values,
  onChange,
}: {
  label: string;
  options: MultiSelectOption[];
  values: string[] | undefined;
  onChange(next: string[] | undefined): void;
}) {
  const selected = values ?? [];
  const [filter, setFilter] = useState("");
  const filtered = filter
    ? options.filter((o) =>
        `${o.label} ${o.hint ?? ""}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
      )
    : options;
  const toggle = (value: string) => {
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    onChange(next.length === 0 ? undefined : next);
  };
  return (
    <Dropdown
      active={selected.length > 0}
      label={
        selected.length > 0 ? `${label} · ${selected.length}` : label
      }
    >
      {() => (
        <div>
          {options.length > 8 ? (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              className="mb-1 h-7 w-full rounded border border-border bg-background px-2 text-xs outline-none focus:border-primary"
            />
          ) : null}
          {filtered.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
            >
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={() => toggle(option.value)}
                className="size-3.5 shrink-0 accent-primary"
              />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.hint ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {option.hint}
                </span>
              ) : null}
            </label>
          ))}
          {filtered.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No options
            </div>
          ) : null}
        </div>
      )}
    </Dropdown>
  );
}

type DatePreset = "any" | "today" | "last7d" | "last30d" | "overdue" | "none" | "range";

const DATE_PRESET_LABEL: Record<Exclude<DatePreset, "any">, string> = {
  today: "Today",
  last7d: "Last 7 days",
  last30d: "Last 30 days",
  overdue: "Overdue",
  none: "No date",
  range: "Custom range…",
};

export function DateRangeSelect({
  label,
  value,
  onChange,
  allowOverdue = true,
}: {
  label: string;
  value: DateRange | undefined;
  onChange(next: DateRange | undefined): void;
  allowOverdue?: boolean;
}) {
  const preset: DatePreset =
    value === undefined
      ? "any"
      : value.kind === "range"
        ? "range"
        : value.kind;
  const rangeValue =
    value?.kind === "range" ? value : { from: "", to: "" };
  return (
    <Dropdown
      active={value !== undefined}
      label={
        value === undefined
          ? label
          : value.kind === "range"
            ? `${label}: ${value.from}→${value.to}`
            : `${label}: ${DATE_PRESET_LABEL[value.kind]}`
      }
    >
      {() => (
        <div className="space-y-1 p-1">
          {(
            [
              "any",
              "today",
              "last7d",
              "last30d",
              ...(allowOverdue ? (["overdue"] as const) : []),
              "none",
              "range",
            ] as DatePreset[]
          ).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() =>
                onChange(
                  option === "any"
                    ? undefined
                    : option === "range"
                      ? { kind: "range", from: "", to: "" }
                      : { kind: option },
                )
              }
              className={`block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent ${
                preset === option ? "bg-accent font-medium" : ""
              }`}
            >
              {option === "any" ? "Any" : DATE_PRESET_LABEL[option]}
            </button>
          ))}
          {preset === "range" ? (
            <div className="flex items-center gap-1 px-1 pt-1">
              <input
                type="date"
                value={rangeValue.from}
                onChange={(e) =>
                  onChange({
                    kind: "range",
                    from: e.target.value,
                    to: rangeValue.to,
                  })
                }
                className="h-7 w-full rounded border border-border bg-background px-1 text-xs"
              />
              <span className="text-xs text-muted-foreground">→</span>
              <input
                type="date"
                value={rangeValue.to}
                onChange={(e) =>
                  onChange({
                    kind: "range",
                    from: rangeValue.from,
                    to: e.target.value,
                  })
                }
                className="h-7 w-full rounded border border-border bg-background px-1 text-xs"
              />
            </div>
          ) : null}
        </div>
      )}
    </Dropdown>
  );
}

export function SimpleSelect<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label?: string;
  options: { value: T; label: string }[];
  value: T;
  onChange(next: T): void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-8 rounded-md border border-border bg-card px-2 text-xs text-foreground outline-none focus:border-primary"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
