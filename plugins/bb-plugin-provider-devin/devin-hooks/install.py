#!/usr/bin/env python3
"""Подключает хуки Devin из этого каталога к ~/.config/devin/config.json текущего
пользователя. Один источник хуков для всех пользователей хоста: у владельца —
каталог плагина в bb-addons, у второго инстанса — копия из bb-addons-ornella-sync.

    python3 -I devin-hooks/install.py          # записать
    python3 -I devin-hooks/install.py --check  # показать, что будет, не писать

Что ставит (идемпотентно, с резервной копией config.json.bak-hooks-<время>):
  - bb_subagents.py  : PreToolUse(exec/write/edit/...) — spawn скрытым и привязанным,
                       защита конфигов; PostToolUse(exec) — привязка после dispatch
  - bb_instructions.py: SessionStart/PostCompaction/PostToolUse/UserPromptSubmit —
                       правила bb и CLAUDE.md возвращаются после сжатия и при resume
  - no_blocking_wait.py: PreToolUse(exec) — только если у пользователя есть
                       ~/.claude/hooks/no-blocking-wait.py (это правило его Claude)
  - read_config_from.claude = true  (Devin читает ~/.claude/CLAUDE.md, как Claude)
  - subagents_enabled = false       (субагенты — только треды bb)
"""
import datetime
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.expanduser("~/.config/devin/config.json")


def cmd(script, timeout):
    return {"type": "command", "command": f"/usr/bin/python3 -I {os.path.join(HERE, script)}", "timeout": timeout}


def desired_hooks():
    pre = [{"matcher": "^(exec|write|edit|apply_patch|notebook_edit)$", "hooks": [cmd("bb_subagents.py", 10)]}]
    if os.path.exists(os.path.expanduser("~/.claude/hooks/no-blocking-wait.py")):
        pre.append({"matcher": "^exec$", "hooks": [cmd("no_blocking_wait.py", 10)]})
    ins = [cmd("bb_instructions.py", 10)]
    return {
        "PreToolUse": pre,
        "PostToolUse": [
            {"matcher": "^exec$", "hooks": [cmd("bb_subagents.py", 120)]},
            {"matcher": "", "hooks": ins},
        ],
        "PostCompaction": [{"matcher": "", "hooks": ins}],
        "SessionStart": [{"matcher": "", "hooks": ins}],
        "UserPromptSubmit": [{"matcher": "", "hooks": ins}],
    }


def main():
    check = "--check" in sys.argv[1:]
    with open(CONFIG, encoding="utf-8") as f:
        config = json.load(f)
    new = dict(config)
    new["hooks"] = desired_hooks()
    new["subagents_enabled"] = False
    rcf = dict(new.get("read_config_from") or {})
    rcf["claude"] = True
    rcf.setdefault("agents_standard", True)
    new["read_config_from"] = rcf
    if new == config:
        print("уже настроено, менять нечего")
        return 0
    print(json.dumps({k: new[k] for k in ("hooks", "subagents_enabled", "read_config_from")}, ensure_ascii=False, indent=1))
    if check:
        print("--check: не записано")
        return 0
    stamp = datetime.datetime.now().strftime("%Y%m%dT%H%M%S")
    shutil.copy2(CONFIG, f"{CONFIG}.bak-hooks-{stamp}")
    tmp = CONFIG + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(new, f, indent=2, ensure_ascii=False)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CONFIG)
    print(f"записано: {CONFIG} (копия {CONFIG}.bak-hooks-{stamp})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
