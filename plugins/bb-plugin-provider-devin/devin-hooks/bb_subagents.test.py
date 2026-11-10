#!/usr/bin/env python3
"""Тесты хука bb_subagents.py и его установки в install.py.

Запуск:
    python3 devin-hooks/bb_subagents.test.py
    python3 -I devin-hooks/bb_subagents.test.py

Проверяет:
1. `bb thread spawn …` проходит без изменений (PreToolUse не дописывает флаги).
2. `bb tasks dispatch …` не вызывает никаких `bb thread update` (ни в PreToolUse, ни в PostToolUse).
3. Запись в `~/.config/devin/config.json` (через exec и write/edit) по-прежнему блокируется.
4. Защита других конфигов (~/.claude/CLAUDE.md, settings.json, хуки) работает, чтение разрешено.
4b. Упоминание пути в СОДЕРЖИМОМ файла не блокирует (ложные срабатывания убраны);
    путь назначения по-прежнему блокируется.
5. `install.py`: повторная установка поверх старой убирает старую регистрацию PostToolUse.
6. DEVIN_BB_LOG перенаправляет журнал во временный файл; реальный ~/.local/state/devin-bb-hooks.log не изменяется.
"""
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "bb_subagents.py")
INSTALL = os.path.join(HERE, "install.py")

REAL_LOG = os.path.expanduser("~/.local/state/devin-bb-hooks.log")
real_log_before = open(REAL_LOG, "rb").read() if os.path.exists(REAL_LOG) else None
real_log_mtime_before = os.path.getmtime(REAL_LOG) if os.path.exists(REAL_LOG) else None

TEMP_DIR = tempfile.TemporaryDirectory()
TEST_LOG = os.path.join(TEMP_DIR.name, "devin-hooks-test.log")

fails = 0


def report(ok, title, details=""):
    global fails
    fails += not ok
    status = "ok  " if ok else "FAIL"
    msg = f"{status} {title}"
    if details:
        msg += f" ({details})"
    print(msg)


def run_hook(event, tool_name, tool_input, env_extra=None):
    payload = json.dumps({
        "hook_event_name": event,
        "tool_name": tool_name,
        "tool_input": tool_input,
    })
    env = os.environ.copy()
    env["DEVIN_BB_LOG"] = TEST_LOG
    if env_extra:
        env.update(env_extra)
    p = subprocess.run([sys.executable, "-I", HOOK], input=payload, capture_output=True, text=True, env=env)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


print("=== 1. Проверка: bb thread spawn проходит без изменений ===")
spawn_cases = [
    "bb thread spawn --preset complex",
    "bb thread create --preset medium",
    "bb thread spawn --preset simple-alt --instructions 'test'",
    "echo hello; bb thread spawn --preset complex",
    "/usr/local/bin/bb thread spawn --preset complex",
]
for cmd in spawn_cases:
    rc, stdout, _ = run_hook("PreToolUse", "exec", {"command": cmd}, env_extra={"BB_THREAD_ID": "thr_coord123"})
    # Не должно быть кода 2 (block) и не должно быть rewrite (updatedInput)
    passed_unchanged = (rc == 0) and ("updatedInput" not in stdout) and ("decision" not in stdout)
    report(passed_unchanged, f"spawn unchanged: {cmd[:40]}", f"rc={rc}, out={stdout!r}")


print("\n=== 2. Проверка: bb tasks dispatch не вызывает bb thread update ===")
with tempfile.TemporaryDirectory() as tmpdir:
    bb_log = os.path.join(tmpdir, "bb_calls.log")
    spy_bb = os.path.join(tmpdir, "bb")
    with open(spy_bb, "w", encoding="utf-8") as f:
        f.write(f"""#!/bin/sh
echo "$@" >> "{bb_log}"
exit 0
""")
    os.chmod(spy_bb, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP)

    test_env = {
        "BB_CLI": spy_bb,
        "PATH": f"{tmpdir}:{os.environ.get('PATH', '')}",
        "BB_THREAD_ID": "thr_coordinator",
    }

    dispatch_cmd = "bb tasks dispatch PLUG-151 --preset complex"

    # PreToolUse
    rc_pre, out_pre, _ = run_hook("PreToolUse", "exec", {"command": dispatch_cmd}, env_extra=test_env)
    report(rc_pre == 0 and "decision" not in out_pre, "dispatch PreToolUse passes through", f"rc={rc_pre}")

    # PostToolUse
    rc_post, out_post, _ = run_hook("PostToolUse", "exec", {"command": dispatch_cmd}, env_extra=test_env)
    report(rc_post == 0 and "hookSpecificOutput" not in out_post, "dispatch PostToolUse produces no extra context", f"rc={rc_post}")

    # Проверка, что бинарник bb вообще не вызывался (и тем более bb thread update)
    bb_called = os.path.exists(bb_log)
    bb_calls = open(bb_log).read() if bb_called else ""
    update_called = "thread update" in bb_calls
    report(not update_called and not bb_called, "no bb CLI / bb thread update invoked", f"calls: {bb_calls.strip()!r}")


print("\n=== 3. Проверка: запись в ~/.config/devin/config.json блокируется ===")
block_cases = [
    # exec write variants
    ("exec", {"command": "echo '{}' > ~/.config/devin/config.json"}),
    ("exec", {"command": "cat foo | tee ~/.config/devin/config.json"}),
    ("exec", {"command": "rm ~/.config/devin/config.json"}),
    ("exec", {"command": "sed -i 's/a/b/' ~/.config/devin/config.json"}),
    ("exec", {"command": "mv new.json ~/.config/devin/config.json"}),
    ("exec", {"command": "cp new.json ~/.config/devin/config.json"}),
    ("exec", {"command": "python3 -c \"open('~/.config/devin/config.json', 'w').write('{}')\""}),
    # structured tools
    ("write", {"file_path": "/home/ubuntu/.config/devin/config.json", "content": "{}"}),
    ("edit", {"file_path": "/home/ubuntu/.config/devin/config.json", "old_string": "a", "new_string": "b"}),
    ("apply_patch", {"patch": "--- ~/.config/devin/config.json\n+++ ~/.config/devin/config.json\n@@ -1 +1 @@\n-old\n+new"}),
]

for tool_name, tool_input in block_cases:
    rc, stdout, _ = run_hook("PreToolUse", tool_name, tool_input)
    blocked = (rc == 2)
    try:
        data = json.loads(stdout)
        has_decision = data.get("decision") == "block"
        has_reason = bool(data.get("reason"))
    except Exception:
        has_decision = False
        has_reason = False
    ok = blocked and has_decision and has_reason
    cmd_desc = tool_input.get("command") or tool_input.get("file_path") or tool_input.get("patch")[:30]
    report(ok, f"blocked write ({tool_name}): {cmd_desc}", f"rc={rc}")


print("\n=== 4. Проверка: защита других конфигов и разрешение безопасного чтения ===")
other_blocked = [
    ("exec", {"command": "echo 'rule' > ~/.claude/CLAUDE.md"}),
    ("exec", {"command": "echo '{}' > ~/.claude/settings.json"}),
    ("exec", {"command": "echo 'pass' > ~/.claude/hooks/guard.py"}),
    ("exec", {"command": "echo 'x' > plugins/bb-plugin-provider-devin/devin-hooks/bb_subagents.py"}),
    ("exec", {"command": "echo 'x' > ~/.local/share/bb-devin/hooks/bb_subagents.py"}),
]
for tool_name, tool_input in other_blocked:
    rc, stdout, _ = run_hook("PreToolUse", tool_name, tool_input)
    ok = (rc == 2 and '"decision": "block"' in stdout)
    report(ok, f"blocked protected file ({tool_input['command'][:40]})", f"rc={rc}")

allowed_reads = [
    "cat ~/.config/devin/config.json",
    "cat ~/.config/devin/config.json 2>/dev/null",
    "ls -la ~/.config/devin/",
    "cat ~/.claude/CLAUDE.md",
    "grep foo plugins/bb-plugin-provider-devin/devin-hooks/bb_subagents.py",
    "git status",
]
for cmd in allowed_reads:
    rc, stdout, _ = run_hook("PreToolUse", "exec", {"command": cmd})
    ok = (rc == 0 and "decision" not in stdout)
    report(ok, f"allowed read/exec: {cmd[:40]}", f"rc={rc}")

print("\n=== 4b. Регрессия: упоминание пути в содержимом не блокирует; назначение блокирует ===")
# Ложное срабатывание 11.11: исходник плагина ссылается на конфиг — write/edit
# раньше блокировались по содержимому. Теперь проверяется только путь назначения.
content_mention_cases = [
    ("write", {"file_path": "/home/ubuntu/work/bb/bb-addons/plugins/bb-plugin-provider-devin/src/x.mjs",
               "content": "// обновляет ~/.config/devin/config.json\nconst a = 1"}),
    ("edit", {"file_path": "/home/ubuntu/work/bb/bb-addons/plugins/bb-plugin-provider-devin/src/x.mjs",
              "old_string": "a", "new_string": "смотри ~/.config/devin/config.json"}),
    ("edit", {"file_path": "/home/ubuntu/work/bb/bb-addons/plugins/bb-plugin-provider-devin/src/subagent-gate.mjs",
              "old_string": "a", "new_string": "b"}),
    ("apply_patch", {"patch": "--- plugins/bb-plugin-provider-devin/src/x.mjs\n"
                             "+++ plugins/bb-plugin-provider-devin/src/x.mjs\n"
                             "@@ -1 +1 @@\n-// ~/.config/devin/config.json\n+// new"}),
]
for tool_name, tool_input in content_mention_cases:
    rc, stdout, _ = run_hook("PreToolUse", tool_name, tool_input)
    ok = (rc == 0 and "decision" not in stdout)
    desc = tool_input.get("file_path") or "patch-body-mention"
    report(ok, f"allowed content-mention ({tool_name}): {desc[-55:]}", f"rc={rc}")

dest_blocked = [
    ("edit", {"file_path": "~/.config/devin/config.json", "old_string": "a", "new_string": "b"}),
    ("write", {"file_path": "/home/ubuntu/.claude/settings.json", "content": "{}"}),
    ("edit", {"file_path": "/home/ubuntu/work/bb/bb-addons/plugins/bb-plugin-provider-devin/devin-hooks/x.py",
              "old_string": "a", "new_string": "b"}),
]
for tool_name, tool_input in dest_blocked:
    rc, stdout, _ = run_hook("PreToolUse", tool_name, tool_input)
    ok = (rc == 2 and '"decision": "block"' in stdout)
    report(ok, f"blocked dest ({tool_input['file_path'][:60]})", f"rc={rc}")

print("\n=== 5. Проверка install.py: очистка старой PostToolUse регистрации ===")
spec = importlib.util.spec_from_file_location("devin_install", INSTALL)
install_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install_mod)

# Имитируем старый config.json, где bb_subagents был зарегистрирован и в PreToolUse, и в PostToolUse
old_hooks_config = {
    "PreToolUse": [
        {"matcher": "^(exec|write|edit|apply_patch|notebook_edit)$",
         "hooks": [{"type": "command", "command": "/usr/bin/python3 -I /home/ubuntu/.local/share/bb-devin/hooks/bb_subagents.py", "timeout": 10}]},
        {"matcher": "^exec$",
         "hooks": [{"type": "command", "command": "/usr/bin/python3 -I /home/ubuntu/.local/share/bb-devin/hooks/no_blocking_wait.py", "timeout": 10}]},
    ],
    "PostToolUse": [
        {"matcher": "^exec$",
         "hooks": [{"type": "command", "command": "/usr/bin/python3 -I /home/ubuntu/.local/share/bb-devin/hooks/bb_subagents.py", "timeout": 120}]},
        {"matcher": "",
         "hooks": [{"type": "command", "command": "/usr/bin/python3 -I /home/ubuntu/.local/share/bb-devin/hooks/bb_instructions.py", "timeout": 10}]},
    ],
    "PostCompaction": [
        {"matcher": "",
         "hooks": [{"type": "command", "command": "/usr/bin/python3 -I /home/ubuntu/.local/share/bb-devin/hooks/bb_instructions.py", "timeout": 10}]},
    ],
    "SessionStart": [
        {"matcher": "",
         "hooks": [{"type": "command", "command": "/usr/bin/python3 -I /home/ubuntu/.local/share/bb-devin/hooks/bb_instructions.py", "timeout": 10}]},
    ],
    "UserPromptSubmit": [
        {"matcher": "",
         "hooks": [{"type": "command", "command": "/usr/bin/python3 -I /home/ubuntu/.local/share/bb-devin/hooks/bb_instructions.py", "timeout": 10}]},
    ],
}

new_hooks = install_mod.merged_hooks(old_hooks_config)

# Проверяем, что bb_subagents.py остался в PreToolUse
pre_has_subagents = any(
    any("bb_subagents.py" in str(h.get("command", "")) for h in entry.get("hooks", []))
    for entry in new_hooks.get("PreToolUse", [])
)
report(pre_has_subagents, "install.py keeps bb_subagents in PreToolUse")

# Проверяем, что bb_subagents.py УДАЛЁН из PostToolUse
post_has_subagents = any(
    any("bb_subagents.py" in str(h.get("command", "")) for h in entry.get("hooks", []))
    for entry in new_hooks.get("PostToolUse", [])
)
report(not post_has_subagents, "install.py removes bb_subagents from PostToolUse")

# Проверяем, что bb_instructions остался в PostToolUse
post_has_instructions = any(
    any("bb_instructions.py" in str(h.get("command", "")) for h in entry.get("hooks", []))
    for entry in new_hooks.get("PostToolUse", [])
)
report(post_has_instructions, "install.py keeps bb_instructions in PostToolUse")

# Проверяем идемпотентность повторного запуска поверх new_hooks
repeated_hooks = install_mod.merged_hooks(new_hooks)
report(repeated_hooks == new_hooks, "install.py repeated run is idempotent")


print("\n=== 6. Проверка: реальный лог не изменился, лог теста записан во временный файл ===")
real_log_after = open(REAL_LOG, "rb").read() if os.path.exists(REAL_LOG) else None
real_log_mtime_after = os.path.getmtime(REAL_LOG) if os.path.exists(REAL_LOG) else None

report(real_log_after == real_log_before and real_log_mtime_after == real_log_mtime_before,
       "real devin-bb-hooks.log was not modified")
report(os.path.exists(TEST_LOG) and os.path.getsize(TEST_LOG) > 0,
       "test log received blocked events",
       f"size={os.path.getsize(TEST_LOG) if os.path.exists(TEST_LOG) else 0}")

TEMP_DIR.cleanup()

print(f"\nИтог: fails={fails}")
sys.exit(1 if fails else 0)
