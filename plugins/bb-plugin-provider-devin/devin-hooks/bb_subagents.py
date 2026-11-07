#!/usr/bin/env python3
"""Хук Devin CLI: субагенты bb всегда привязаны к координатору и скрыты.

Зачем: ACP-мост bb отдаёт Devin инструкции один раз текстом в первом
сообщении сессии, после сжатия контекста правила теряются. Хук не зависит
от памяти модели.

PreToolUse(exec):  `bb thread spawn|create` без флагов -> дописывает
                   --parent-self --visibility hidden --parent-notifications auto.
PostToolUse(exec): после `bb tasks dispatch <KEY>` находит свежие треды задачи
                   без родителя и делает им
                   bb thread update <id> --parent-thread $BB_THREAD_ID
                   --parent-notifications auto --visibility hidden.

Журнал: ~/.local/state/devin-bb-hooks.log. Любая ошибка -> exit 0 (не мешаем
агенту работать).
"""
import datetime
import json
import os
import re
import subprocess
import sys

LOG = os.path.expanduser("~/.local/state/devin-bb-hooks.log")
# Команда bb в позиции команды: начало строки, после ; & | ( $( или перевода строки.
CMD_START = r"(?:^|[;&|(\n]\s*|\$\(\s*)"
BB = r"(?:(?:\S*/)?bb|\"?\$\{?BB_CLI\}?\"?)"
SPAWN_RE = re.compile(CMD_START + r"(" + BB + r"\s+thread\s+(?:spawn|create))(?=\s|$)")
DISPATCH_RE = re.compile(CMD_START + BB + r"\s+tasks\s+dispatch\s+([A-Za-z][A-Za-z0-9]*-\d+|[0-9A-Z]{26})\b")
FRESH_SECONDS = 15 * 60
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


def bb_cli():
    return os.environ.get("BB_CLI") or "bb"


def run_bb(args, timeout=40):
    p = subprocess.run([bb_cli(), *args], capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout


def fix_spawn(cmd):
    """Возвращает команду с дописанными флагами или None, если менять нечего."""
    have_thread = bool(os.environ.get("BB_THREAD_ID"))

    def add_flags(m):
        whole = m.group(0)
        tail = cmd[m.end():]
        # Флаги смотрим только в пределах этой команды (до ; && || | или перевода строки).
        seg = re.split(r"[;\n]|&&|\|\|?", tail, maxsplit=1)[0]
        extra = []
        if have_thread and not re.search(r"--parent-(?:self|thread)\b", seg):
            extra.append("--parent-self")
        if not re.search(r"--visibility\b", seg):
            extra.append("--visibility hidden")
        if have_thread and not re.search(r"--parent-notifications\b", seg):
            extra.append("--parent-notifications auto")
        return whole + (" " + " ".join(extra) if extra else "")

    new = SPAWN_RE.sub(add_flags, cmd)
    return new if new != cmd else None


def fix_dispatch(cmd):
    parent = os.environ.get("BB_THREAD_ID")
    if not parent:
        return []
    done = []
    now = datetime.datetime.now(datetime.timezone.utc)
    for key in dict.fromkeys(m.group(1) for m in DISPATCH_RE.finditer(cmd)):
        rc, out = run_bb(["tasks", "threads", key, "--json"])
        if rc != 0:
            log(f"dispatch {key}: tasks threads rc={rc}")
            continue
        try:
            entries = json.loads(out[out.index("{"):]).get("taskThreads") or []
        except (ValueError, AttributeError):
            log(f"dispatch {key}: unparsable tasks threads output")
            continue
        for e in entries:
            try:
                attached = datetime.datetime.fromisoformat(e["attachedAt"].replace("Z", "+00:00"))
            except (KeyError, ValueError):
                continue
            if (now - attached).total_seconds() > FRESH_SECONDS:
                continue
            tid = e.get("threadId")
            if not tid or tid == parent:
                continue
            rc, out = run_bb(["thread", "show", tid, "--json"])
            try:
                t = json.loads(out[out.index("{"):])["thread"]
            except (ValueError, KeyError):
                continue
            if t.get("parentThreadId") and t.get("visibility") == "hidden":
                continue
            args = ["thread", "update", tid, "--visibility", "hidden"]
            if not t.get("parentThreadId"):
                args += ["--parent-thread", parent, "--parent-notifications", "auto"]
            rc, _ = run_bb(args)
            log(f"dispatch {key}: {' '.join(args[2:])} rc={rc}")
            if rc == 0:
                done.append(tid)
    return done


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return 0
    event = data.get("hook_event_name")
    tool = data.get("tool_name")
    tool_input = data.get("tool_input") or {}
    cmd = tool_input.get("command") or ""

    if event == "PreToolUse":
        if tool == "exec":
            # Убираем перенаправления в /dev/null, чтобы чтение с `2>/dev/null` не считалось записью.
            probe = re.sub(r"\d?>>?\s*/dev/null|\d?>&\d", " ", cmd)
            guarded = GUARD_RE.search(probe) and WRITE_RE.search(probe)
        else:
            guarded = tool in ("write", "edit", "apply_patch", "notebook_edit") and \
                GUARD_RE.search(json.dumps(tool_input, ensure_ascii=False))
        if guarded:
            log(f"guard blocked {tool}: {(cmd or json.dumps(tool_input))[:200]!r}")
            print(json.dumps({"decision": "block", "reason": GUARD_REASON}, ensure_ascii=False))
            return 2

    if tool != "exec" or not cmd:
        return 0

    if event == "PreToolUse":
        new = fix_spawn(cmd)
        if new:
            log(f"spawn rewritten: {new[:300]!r}")
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": {"command": new},
            }}, ensure_ascii=False))
    elif event == "PostToolUse":
        done = fix_dispatch(cmd)
        if done:
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": (
                    "bb-хук: треды " + ", ".join(done) + " привязаны к твоему треду "
                    "(--parent-notifications auto) и скрыты. Итог исполнителя придёт тебе "
                    "сообщением — не жди его блокирующей командой."),
            }}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # хук никогда не ломает агенту ход
        log(f"error: {exc!r}")
        sys.exit(0)
