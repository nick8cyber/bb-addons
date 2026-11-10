#!/usr/bin/env python3
"""Ставит хуки Devin из этого каталога текущему пользователю.

Хуки КОПИРУЮТСЯ в постоянный каталог ~/.local/share/bb-devin/hooks/ и config.json
указывает туда, а не в рабочий чекаут: чекаут переключают на другие ветки, и
хук, которого нет на диске, сломал бы Devin все команды. Обновление хуков —
повторный запуск установщика.

    python3 -I devin-hooks/install.py          # установить / обновить
    python3 -I devin-hooks/install.py --check  # показать, что будет, не писать

В ~/.config/devin/config.json (с резервной копией config.json.bak-hooks-<время>):
  - hooks: наши записи заменяются, ЧУЖИЕ хуки пользователя сохраняются
      bb_subagents.py   PreToolUse(exec/write/edit/...) — защита конфигов и правил
      bb_instructions.py SessionStart/PostCompaction/PostToolUse/UserPromptSubmit
      no_blocking_wait.py PreToolUse(exec) — только если у пользователя есть
                        ~/.claude/hooks/no-blocking-wait.py (это правило его Claude)
  - read_config_from.claude = true  (Devin читает ~/.claude/CLAUDE.md, как Claude)
  - subagents_enabled = false       только при первом запуске (ключа нет);
      дальше ключом управляет центральная настройка bb subagentsDisabled
      (host-gate плагина provider-devin)
~/.config/devin/hooks — ссылка на постоянный каталог (старые сессии держат этот путь).
"""
import datetime
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.expanduser("~/.local/share/bb-devin/hooks")
CONFIG = os.path.expanduser("~/.config/devin/config.json")
LEGACY = os.path.expanduser("~/.config/devin/hooks")
SCRIPTS = ("bb_subagents.py", "bb_instructions.py", "no_blocking_wait.py")
# Признаки наших записей в hooks — по ним старые версии заменяются, чужое не трогается.
OURS = tuple(f"/{name}" for name in SCRIPTS)


def cmd(script, timeout):
    return {"type": "command", "command": f"/usr/bin/python3 -I {os.path.join(DEST, script)}", "timeout": timeout}


def our_hooks():
    pre = [{"matcher": "^(exec|write|edit|apply_patch|notebook_edit)$", "hooks": [cmd("bb_subagents.py", 10)]}]
    if os.path.exists(os.path.expanduser("~/.claude/hooks/no-blocking-wait.py")):
        pre.append({"matcher": "^exec$", "hooks": [cmd("no_blocking_wait.py", 10)]})
    ins = [cmd("bb_instructions.py", 10)]
    return {
        "PreToolUse": pre,
        "PostToolUse": [
            {"matcher": "", "hooks": ins},
        ],
        "PostCompaction": [{"matcher": "", "hooks": ins}],
        "SessionStart": [{"matcher": "", "hooks": ins}],
        "UserPromptSubmit": [{"matcher": "", "hooks": ins}],
    }


def is_ours(entry):
    return any(any(mark in str(h.get("command", "")) for mark in OURS) for h in entry.get("hooks") or [])


def merged_hooks(existing):
    result = {}
    for event, entries in (existing or {}).items():
        kept = [e for e in entries if not is_ours(e)]
        if kept:
            result[event] = kept
    for event, entries in our_hooks().items():
        result[event] = result.get(event, []) + entries
    return result


def copy_scripts(check):
    changed = []
    for name in SCRIPTS:
        src, dst = os.path.join(HERE, name), os.path.join(DEST, name)
        with open(src, "rb") as f:
            data = f.read()
        if os.path.exists(dst) and open(dst, "rb").read() == data:
            continue
        changed.append(name)
        if not check:
            os.makedirs(DEST, mode=0o755, exist_ok=True)
            tmp = dst + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.chmod(tmp, 0o644)
            os.replace(tmp, dst)
    return changed


def fix_legacy_link(check):
    if os.path.islink(LEGACY) and os.path.realpath(LEGACY) == os.path.realpath(DEST):
        return False
    if check:
        return True
    if os.path.islink(LEGACY):
        os.remove(LEGACY)
    elif os.path.isdir(LEGACY):
        shutil.move(LEGACY, LEGACY + ".bak-" + datetime.datetime.now().strftime("%Y%m%dT%H%M%S"))
    os.symlink(DEST, LEGACY)
    return True


def main():
    check = "--check" in sys.argv[1:]
    changed = copy_scripts(check)
    print(f"хуки в {DEST}: {'обновить ' + ', '.join(changed) if changed else 'актуальны'}")
    if fix_legacy_link(check):
        print(f"{LEGACY} -> {DEST}")

    with open(CONFIG, encoding="utf-8") as f:
        config = json.load(f)
    new = dict(config)
    new["hooks"] = merged_hooks(config.get("hooks"))
    new.setdefault("subagents_enabled", False)  # первый запуск — выкл;
    # дальше ключом управляет настройка subagentsDisabled (см. host.ts)
    rcf = dict(new.get("read_config_from") or {})
    rcf["claude"] = True
    rcf.setdefault("agents_standard", True)
    new["read_config_from"] = rcf
    if new == config:
        print("config.json уже настроен")
        return 0
    if check:
        print(json.dumps({k: new[k] for k in ("hooks", "subagents_enabled", "read_config_from")}, ensure_ascii=False, indent=1))
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
