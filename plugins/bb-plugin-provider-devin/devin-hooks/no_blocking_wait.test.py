#!/usr/bin/env python3
"""python3 -I devin-hooks/no_blocking_wait.test.py"""
import json
import os
import subprocess
import sys

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "no_blocking_wait.py")
W = "wa" + "it"
S = "sle" + "ep"
CASES = [
    ({"command": f"bb thread {W} thr_x --timeout 600"}, True),
    ({"command": f"{S} 30; ls"}, True),
    ({"command": "tail -" + "f /var/log/x"}, True),
    ({"command": f"bb thread {W} thr_x", "timeout": 0}, False),
    ({"command": "bb thread output thr_x | tail -5"}, False),
    ({"command": f"cat > f.md <<EOF\nnever {S} 5 here\nEOF"}, False),
]
fails = 0
for tool_input, should_block in CASES:
    payload = json.dumps({"hook_event_name": "PreToolUse", "tool_name": "exec", "tool_input": tool_input})
    p = subprocess.run([sys.executable, "-I", HOOK], input=payload, capture_output=True, text=True)
    blocked = p.returncode == 2 and '"decision": "block"' in p.stdout
    ok = blocked == should_block
    fails += not ok
    print("ok  " if ok else "FAIL", "block" if blocked else "allow", repr(tool_input["command"][:40]))
    if blocked and ok and "timeout: 0" not in p.stdout:
        print("FAIL reason not adapted for Devin"); fails += 1
print("fails:", fails)
sys.exit(1 if fails else 0)
