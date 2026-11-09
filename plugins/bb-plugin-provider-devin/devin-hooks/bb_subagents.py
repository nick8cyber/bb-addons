#!/usr/bin/env python3
"""Хук Devin CLI: защита конфигурации Devin, хуков и общих правил от перезаписи.

Зачем: Deny Write(...) в config.json не останавливает команды exec (Devin может
переписать config.json или хуки через shell-команды вроде `>`, sed, mv, tee и т.п.).
Хук проверяет PreToolUse для exec и файловых инструментов write/edit/apply_patch/notebook_edit.

Раздача задач и привязка исполнителей теперь выполняются плагином orchestrator
(`bb orchestrator delegate`), поэтому хук больше не переписывает `bb thread spawn`
и не обрабатывает `bb tasks dispatch`.

PreToolUse(exec|write|edit|...): блокирует попытки модификации ~/.config/devin,
                                 ~/.claude (CLAUDE.md, settings.json, hooks)
                                 и хуков плагина provider-devin.

Журнал: ~/.local/state/devin-bb-hooks.log. Любая ошибка -> exit 0 (не мешаем
агенту работать).
"""
import datetime
import json
import os
import re
import sys

LOG = os.environ.get("DEVIN_BB_LOG") or os.path.expanduser("~/.local/state/devin-bb-hooks.log")
# Защита своих файлов: конфиг Devin, хуки, глобальные правила. Deny Write(...) в
# config.json команды exec не останавливает (06.11 Devin так переписал config.json).
GUARD_RE = re.compile(
    r"\.config/devin(?:/|\b)|\.claude/(?:CLAUDE\.md|hooks\b|settings(?:\.local)?\.json)"
    r"|bb-plugin-provider-devin/devin-hooks\b|\.local/share/bb-devin/hooks\b")
WRITE_RE = re.compile(
    r">|\btee\b|\bsed\s+(?:-\w*\s+)*-i|\bmv\b|\bcp\b|\brm\b|\bchmod\b|\bchown\b|\btruncate\b|\bln\b"
    r"|\binstall\b|\bdd\b|open\([^)]*['\"][wax+]|write_text|write_bytes|json\.dump|\bperl\s+-\w*i")
GUARD_REASON = ("Файлы ~/.config/devin (config.json, hooks, AGENTS.md) и общие правила агентов "
                "~/.claude (CLAUDE.md, hooks, settings.json), хуки плагина provider-devin правит только владелец. "
                "Нужна правка — опиши её владельцу.")


def log(msg):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now().isoformat(timespec='seconds')} "
                    f"[{os.environ.get('BB_THREAD_ID', '-')}] {msg}\n")
    except OSError:
        pass


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return 0
    event = data.get("hook_event_name")
    if event != "PreToolUse":
        return 0

    tool = data.get("tool_name")
    tool_input = data.get("tool_input") or {}
    cmd = tool_input.get("command") or ""

    if tool == "exec":
        # Убираем перенаправления в /dev/null, чтобы чтение с `2>/dev/null` не считалось записью.
        probe = re.sub(r"\d?>>?\s*/dev/null|\d?>&\d", " ", cmd)
        guarded = bool(GUARD_RE.search(probe) and WRITE_RE.search(probe))
    else:
        guarded = tool in ("write", "edit", "apply_patch", "notebook_edit") and \
            bool(GUARD_RE.search(json.dumps(tool_input, ensure_ascii=False)))

    if guarded:
        log(f"guard blocked {tool}: {(cmd or json.dumps(tool_input))[:200]!r}")
        print(json.dumps({"decision": "block", "reason": GUARD_REASON}, ensure_ascii=False))
        return 2

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # хук никогда не ломает агенту ход
        log(f"error: {exc!r}")
        sys.exit(0)
