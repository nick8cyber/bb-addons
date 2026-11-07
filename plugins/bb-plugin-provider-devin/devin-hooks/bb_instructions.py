#!/usr/bin/env python3
"""Devin: правила bb возвращаются в контекст после сжатия — как у Claude и Codex,
у которых они в системной части каждого запроса.

Мост provider-devin отдаёт правила bb один раз текстом в первом сообщении сессии
и сохраняет их в ~/.local/state/bb-devin/instructions/<BB_THREAD_ID>.md.
  PostCompaction                    -> отметка «сжатие было» для session_id
  PostToolUse / UserPromptSubmit    -> если отметка есть: отдать правила как
                                       additionalContext и снять отметку
Ошибки -> exit 0 (хук не мешает работе).
"""
import json
import os
import re
import sys

STATE = os.path.expanduser("~/.local/state/bb-devin")
MARKS = os.path.join(STATE, "compacted")
LOG = os.path.expanduser("~/.local/state/devin-bb-hooks.log")


def log(msg):
    try:
        import datetime
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now().isoformat(timespec='seconds')} "
                    f"[{os.environ.get('BB_THREAD_ID', '-')}] {msg}\n")
    except OSError:
        pass


def instructions_from_devin_db(session_id):
    """Правила bb из базы Devin: самое свежее сообщение сессии, где текстовый блок
    НАЧИНАЕТСЯ с <system_instructions> (так их кладёт мост). Упоминания тега в
    вопросах или прочитанном коде не подходят: они не в начале блока."""
    import sqlite3
    db = os.path.expanduser("~/.local/share/devin/cli/sessions.db")
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=3)
        try:
            rows = con.execute(
                "select chat_message from message_nodes where session_id = ? "
                "and chat_message like '%<system_instructions>%' order by row_id desc limit 50",
                (session_id,),
            ).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return ""

    def strings(node):
        if isinstance(node, str):
            yield node
        elif isinstance(node, dict):
            for v in node.values():
                yield from strings(v)
        elif isinstance(node, list):
            for v in node:
                yield from strings(v)

    for (raw,) in rows:
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        for text in strings(msg):
            if text.startswith("<system_instructions>") and "</system_instructions>" in text:
                return text[len("<system_instructions>"):text.index("</system_instructions>")].strip()
    return ""


def mark_path(session_id):
    return os.path.join(MARKS, re.sub(r"[^A-Za-z0-9_.-]", "_", session_id)[:120])


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return 0
    event = data.get("hook_event_name")
    session_id = str(data.get("session_id") or "")
    thread = os.environ.get("BB_THREAD_ID", "")
    if not session_id or not re.fullmatch(r"thr_[a-z0-9]+", thread):
        return 0

    if event == "SessionStart" and data.get("source") == "resume":
        # Восстановленная сессия держит правила, снятые при её создании; новые
        # читают ~/.config/devin/AGENTS.md (= ~/.claude/CLAUDE.md) сами.
        try:
            text = open(os.path.expanduser("~/.claude/CLAUDE.md"), encoding="utf-8").read()
        except OSError:
            return 0
        log(f"resume: injected current CLAUDE.md ({len(text)} chars)")
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": (
                "Актуальные глобальные правила агентов (~/.claude/CLAUDE.md). Они заменяют "
                "глобальные правила, загруженные в эту сессию раньше:\n" + text),
        }}, ensure_ascii=False))
        return 0

    if event == "PostCompaction":
        os.makedirs(MARKS, mode=0o700, exist_ok=True)
        open(mark_path(session_id), "w").close()
        log("compaction: bb instructions will be re-injected")
        return 0

    if event in ("PostToolUse", "UserPromptSubmit") and os.path.exists(mark_path(session_id)):
        src = os.path.join(STATE, "instructions", f"{thread}.md")
        try:
            text = open(src, encoding="utf-8").read()
        except OSError:
            # Процесс моста старше provider-devin eda2dce: файла нет. Правила bb
            # всё равно лежат в базе Devin — мост отправил их первым сообщением сессии.
            text = instructions_from_devin_db(session_id)
            if not text:
                os.remove(mark_path(session_id))
                log(f"no bb instructions for session {session_id} (file and Devin DB)")
                return 0
        os.remove(mark_path(session_id))
        log(f"re-injected bb instructions ({len(text)} chars) on {event}")
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": (
                "Контекст был сжат. Правила bb для этого треда (действуют как прежде):\n"
                f"<system_instructions>\n{text}\n</system_instructions>"),
        }}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        log(f"bb_instructions error: {exc!r}")
        sys.exit(0)
