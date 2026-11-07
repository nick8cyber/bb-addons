#!/usr/bin/env python3
"""Devin: тот же запрет блокирующего ожидания, что у Claude Code.

Правила (BLOCKERS, разбор heredoc, текст причины) берутся из единственного
источника ~/.claude/hooks/no-blocking-wait.py — здесь только перевод формата:
  Claude: tool_name=Bash,  фон = tool_input.run_in_background
  Devin:  tool_name=exec,  фон = tool_input.timeout == 0 (exec сразу отдаёт shell_id)
Ответ Devin: {"decision": "block", "reason": ...}.
"""
import importlib.util
import json
import os
import sys

SRC = os.path.expanduser("~/.claude/hooks/no-blocking-wait.py")


def load_rules():
    spec = importlib.util.spec_from_file_location("claude_no_blocking_wait", SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    if payload.get("tool_name") != "exec":
        return 0
    tool_input = payload.get("tool_input") or {}
    if tool_input.get("timeout") == 0:
        return 0
    rules = load_rules()
    command = rules.strip_heredocs(tool_input.get("command") or "")
    for pattern, what in rules.BLOCKERS:
        if pattern.search(command):
            reason = rules.REASON.format(what=what).replace(
                "тот же вызов с run_in_background: true",
                "тот же exec с timeout: 0 (сразу вернёт shell_id)",
            ).replace("BashOutput / bb thread output", "get_output по shell_id / bb thread output").replace(
                "используй параметр run_in_background", "используй timeout: 0")
            print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
            return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # сломанный хук не должен блокировать работу
        sys.exit(0)
