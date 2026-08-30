/**
 * The icon set this section draws with.
 *
 * bb ships no icon package to plugin frontends, so these are hand-drawn on the
 * same 16-unit grid lucide uses and inherit `currentColor` plus the host's
 * `--icon-stroke-width`, which is what keeps them visually identical to the
 * icons bb draws around them in both themes.
 */
import type { SVGProps } from "react";

import { cn } from "../../lib/utils";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ className, children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="var(--icon-stroke-width, 1.5)"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-3.5 shrink-0", className)}
      {...props}
    >
      {children}
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4 6 4 4 4-4" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3 8.5 3.5 3.5L13 5" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.75 14.5 13.5h-13L8 2.75Z" />
      <path d="M8 6.75v3" />
      <path d="M8 11.75h.01" />
    </Icon>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v4" />
      <path d="M8 4.75h.01" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3.25v9.5" />
      <path d="M3.25 8h9.5" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.25 8a5.25 5.25 0 1 1-1.6-3.78" />
      <path d="M13.5 2.5v3h-3" />
    </Icon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.75 4.25h10.5" />
      <path d="M6.25 4.25v-1.5h3.5v1.5" />
      <path d="M4.25 4.25 4.75 13h6.5l.5-8.75" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4 4 8 8" />
      <path d="m12 4-8 8" />
    </Icon>
  );
}

export function KeyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5.25" cy="10.75" r="2.5" />
      <path d="m7 9 6.25-6.25" />
      <path d="m10.5 5.5 1.5 1.5" />
    </Icon>
  );
}

export function BoltIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.75 1.75 3.5 9h4l-.25 5.25L12.5 7h-4l.25-5.25Z" />
    </Icon>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 9.5a2.75 2.75 0 0 0 4 .25l2-2a2.75 2.75 0 0 0-3.9-3.9l-1.1 1.1" />
      <path d="M9.5 6.5a2.75 2.75 0 0 0-4-.25l-2 2a2.75 2.75 0 0 0 3.9 3.9l1.1-1.1" />
    </Icon>
  );
}

/** A quiet spinner for probes: the only motion this section allows itself. */
export function SpinnerIcon({ className, ...props }: IconProps) {
  return (
    <Icon className={cn("animate-spin", className)} {...props}>
      <path d="M8 1.75a6.25 6.25 0 1 0 6.25 6.25" />
    </Icon>
  );
}
