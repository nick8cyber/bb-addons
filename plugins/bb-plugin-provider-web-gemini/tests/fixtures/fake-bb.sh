#!/bin/sh
# Test double for the bb CLI used by inner-context.mjs taskThread().
# Answers `thread show <id> --json` with the DTO from FAKE_BB_THREAD_JSON;
# every other command exits non-zero (fixture tests never reach them).
if [ "$1" = "thread" ] && [ "$2" = "show" ]; then
  printf '%s\n' "$FAKE_BB_THREAD_JSON"
  exit 0
fi
exit 1
