export type CollectorOptions = {
  userHome?: string | (() => string);
  fetch?: typeof fetch;
  execFile?: (file: string, args: string[], options?: any) => string | Buffer;
  spawn?: (command: string, args: string[], options?: any) => any;
  runner?: (command: string, args: string[], options?: any) => any;
  agyPath?: string | (() => string);
  now?: () => number;
  prewarm?: boolean;
};

export const STALE_USAGE_WARNING = "Usage could not be refreshed. Showing last known data.";

export function getStaleWarning(): string {
  return STALE_USAGE_WARNING;
}
