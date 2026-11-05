---
description: Drive local Herdr panes — inventory, read, srun/GPU shells — without colliding with pi-herdr-agents
argument-hint: "[instruction]"
---

Drive local Herdr panes for: ${@:-inventory srun/GPU and shell panes, then wait}

This session is already inside Herdr. Use the `herdr` CLI via `bash`. There is no pane-control tool besides `subagent` / `herdr_workflow`.

## Gate

```bash
test "${HERDR_ENV:-}" = 1 && command -v herdr
```

If either fails: stop. You are not in a Herdr pane; do not invent pane ids. Remote cluster tmux/Herdr is `tmux_pi`, not this template.

Never: `herdr --remote` wrapping a subcommand (`--remote` is TUI attach only). Never `tmux attach`. Never `herdr server stop`. Never `herdr pane run` / `send-text` into `$HERDR_PANE_ID` (this session).

## Which surface

| Want | Use |
|---|---|
| New child Pi (scout/worker/review) | `subagent` / `/plan` `/iterate` `/btw` `/worktree` |
| Approved multi-agent review | `herdr_workflow` + `/skill:orchestrate` |
| Existing **shell or srun** pane | `herdr pane …` below |
| Existing **other Pi** the user named | `herdr agent prompt <pane\|name>` |
| SSH to another cluster's tmux/Herdr | `tmux_pi` |

Do **not** `pane split` + launch `pi` by hand. That bypasses `pi-herdr-agents` (no widget, no result delivery, no worktree contract). After `subagent(…)`, end the turn — do not poll, sleep, or tail session files.

## Inventory (do this first)

Parse JSON. `pane list` / `get` / `process-info` / `layout` are JSON (`{id, result}`). **`pane read` is plain text**, not JSON.

```bash
echo "me=$HERDR_PANE_ID tab=$HERDR_TAB_ID ws=$HERDR_WORKSPACE_ID"
herdr pane list
herdr agent list
```

Classify each pane from `process-info --pane <id>` + the `agent` / `agent_status` fields:

| Kind | How you know | Drive with |
|---|---|---|
| **this session** | `pane_id == $HERDR_PANE_ID` | never inject |
| **pi-herdr-agents child** | `agent` set, or title is a `subagent` name | `subagent_*` tools only — no `pane run` / `send-text` / `agent prompt` |
| **other Pi** | fg `name=pi`, user owns it | `herdr agent prompt` only if asked |
| **srun / GPU** | fg `name=srun` or cmdline starts `srun --jobid … --nodelist …` | `herdr pane run` / `read` / `wait-output` |
| **idle shell** | fg bash/zsh, no srun, no pi | `herdr pane run` |

One-shot classifier:

```bash
python3 - <<'PY'
import json, subprocess
def j(*a):
    return json.loads(subprocess.check_output(["herdr", *a]))["result"]
me = __import__("os").environ.get("HERDR_PANE_ID")
for p in j("pane", "list")["panes"]:
    pid = p["pane_id"]
    info = j("pane", "process-info", "--pane", pid)["process_info"]
    procs = info.get("foreground_processes") or []
    cmd = (procs[0].get("cmdline") or "") if procs else ""
    names = ",".join(x.get("name") or "?" for x in procs) or "-"
    kind = "SELF" if pid == me else (
        "SRUN" if any((x.get("name")=="srun") or "srun" in (x.get("cmdline") or "") for x in procs) else
        "PI" if p.get("agent") or "pi" in names.split(",") else "SHELL")
    print(f"{pid}\t{kind}\t{p.get('agent_status')}\t{p.get('terminal_title_stripped')}\t{cmd[:140]}")
PY
```

Report `pane_id`, kind, title, and for SRUN: `--jobid` + `--nodelist` from argv. Then do the user instruction.

## Read / run / wait

```bash
herdr pane read <id> --source recent-unwrapped --lines 80 --format text
herdr pane run <id> '<cmd>'                          # text + Enter
herdr pane send-text <id> '<text>'                   # no Enter
herdr pane send-keys <id> enter                      # also: esc, ctrl+c
herdr pane wait-output <id> --match '<substr>' --source recent-unwrapped --timeout 15000
```

`--source recent-unwrapped` for logs. `visible` for what's on screen now. Read **before** injecting. If the pane is mid-command (not a prompt), do not send extra Enter; interrupt only if the user asked (`send-keys <id> ctrl+c`).

Splits you create: `--no-focus`, keep `$PWD`. Close only panes **you** opened this turn.

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
# new pane_id is .result.pane.pane_id
```

## srun / Slurm GPU panes

The login-node PTY **is** the job. `pane run` / `send-text` go to the GPU shell. Do **not** append to the slurm `StdOut` file — that is a log, not stdin.

Identify from `process-info` argv, e.g.

```
srun --jobid 12345 --nodelist compute-node --overlap --pty bash -i
```

`pane read` prompt hostname (`🌐 compute-node`) is the compute node. After `pane run`, `wait-output` for that hostname or the shell prompt before the next command.

Do **not** `scancel`, `srun` a new allocation, or `attach_gpunode` / `gpunode` unless the user asked. No SRUN pane + user wants GPU → say so, wait.

Weka: never `find` / `ls` / `grep -r` / `du` on `/mnt/projects`, `/mnt/data`, `/mnt/shared`, `/home`. Job dirs like `~/train_logs/<id>/` are fine.

## Other Pi sessions

`herdr agent prompt <pane_id> '<text>'` — rejected if that agent is `blocked`. Do not `--wait` a long turn unless asked. Do not `agent prompt` a `pi-herdr-agents` child (breaks parent delivery). `subagent_interrupt` is Escape for a child turn; it does not kill the pane.
