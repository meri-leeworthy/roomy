#!/usr/bin/env python3
"""
fleet-deploy — roll the Roomy agent stack to every worker VM, unattended.

The agent stack is THREE layers, all of which must be current for an update to
actually take effect:

  1. bridge     /home/exedev/roomy-agent   (roomy-bridge: WS + mention detection)
  2. responder  /home/exedev/roomy         (packages/cli — `cli.ts respond`)
  3. sdk        /home/exedev/roomy/packages/sdk  (the bridge imports
                @roomy-space/sdk; on worker VMs this historically resolved to a
                stale npm tarball, so an SDK fix was inert until the bridge's
                node_modules was pointed at the workspace build)

A host is only updated when it is idle: an `omp` process or an active responder
queue job means live agent work, and restarting the bridge would kill it.

State is written to two files on the machine that runs the script:

  ~/.roomy/fleet-deploy.json   canonical, machine-readable (per-host, per-layer)
  ~/.roomy/fleet-deploy.md     human-readable table (what --status prints)
  ~/.roomy/fleet-deploy.log    run log (incl. remote build output)

Usage
-----
  scripts/fleet-deploy.py --status              # show current fleet state, no work
  scripts/fleet-deploy.py --dry-run             # probe every host, change nothing
  scripts/fleet-deploy.py --detach              # fire-and-forget (survives your
                                                #   own bridge restart), then exit
  scripts/fleet-deploy.py                        # run in the foreground
  scripts/fleet-deploy.py --hosts sorrel,bramble # subset
  scripts/fleet-deploy.py --once                 # a single pass, no polling

Why --detach matters
--------------------
`omp-bridge.service` uses KillMode=control-group, and an agent session's `omp`
process lives INSIDE that cgroup. Restarting the bridge therefore kills the very
process that asked for the deploy. Anything that restarts the bridge (including
the machine hosting the coordinator) must run outside that cgroup — --detach
re-execs the script as its own transient systemd unit for exactly this reason.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone

SSH_KEY = os.path.expanduser("~/.ssh/tangled_chanterelle")
ROOMY = "/home/exedev/roomy"
AGENT = "/home/exedev/roomy-agent"
STATE_JSON = os.path.expanduser("~/.roomy/fleet-deploy.json")
STATE_MD = os.path.expanduser("~/.roomy/fleet-deploy.md")
RUN_LOG = os.path.expanduser("~/.roomy/fleet-deploy.log")
UNIT_NAME = "roomy-fleet-deploy"

# host label -> ssh destination (exe ssh reaches every VM; self is run locally)
DEFAULT_FLEET: dict[str, str | None] = {
    "meri-first-agent": "meri-first-agent.exe.xyz",
    "meri-agent-2": "meri-agent-2.exe.xyz",
    "meri-agent-3": "meri-agent-3.exe.xyz",
    "meri-agent-4": None,  # the coordinator's own VM — executed locally
    "sorrel": "sorrel.exe.xyz",
    "bramble": "bramble.exe.xyz",
    "hedgehog": "hedgehog.exe.xyz",
}

# ---------------------------------------------------------------------------
# Remote payload. Runs on the target host (over ssh, or locally for self).
# argv: $1 = probe|apply.  Emits ONE line of JSON on stdout; everything else
# (fetch/build output) goes to the log file.
# ---------------------------------------------------------------------------
REMOTE = r'''
set -uo pipefail
MODE="${1:-probe}"
export PATH=/home/exedev/node/bin:/home/exedev/.local/bin:$PATH
ROOMY=/home/exedev/roomy
AGENT=/home/exedev/roomy-agent
LOG=/home/exedev/.roomy/fleet-deploy.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null
b() { "$@" >>"$LOG" 2>&1; }
note() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [$MODE] $*" >>"$LOG"; }

host=$(hostname)

# --- busy check: never restart a host doing live agent work -----------------
busy=0; reason=""
if pgrep -x omp >/dev/null 2>&1; then busy=1; reason="omp"; fi
if [ "$busy" -eq 0 ] && [ -f /home/exedev/.roomy/queue.json ]; then
  if jq -e '.active != null' /home/exedev/.roomy/queue.json >/dev/null 2>&1; then
    busy=1; reason="queue-active"
  fi
fi

fetch_remotes() {
  ( cd "$AGENT" && git fetch origin --prune -q ) >/dev/null 2>&1
  ( cd "$ROOMY" && git fetch origin --prune -q ) >/dev/null 2>&1
}

# Layer state from git ancestry + tree equality. Never equality-only: a worker
# parked on a squash-merged branch (or its own branch at the same tree) is
# current, and a worker ahead of main is already a superset of it.
#
#   current   trees identical to origin/main (or HEAD ahead of it)
#   behind    HEAD is a strict ancestor of origin/main — safe fast-forward
#   diverged  neither ancestor holds and trees differ — needs a human
layer_git() {  # $1 = repo dir
  local dir=$1 a m
  a=$(cd "$dir" 2>/dev/null && git rev-parse HEAD 2>/dev/null)
  m=$(cd "$dir" 2>/dev/null && git rev-parse origin/main 2>/dev/null)
  if [ -z "$a" ] || [ -z "$m" ]; then echo "error"; return; fi
  if [ "$a" = "$m" ]; then echo "current"; return; fi
  if (cd "$dir" && git diff --quiet "$m" "$a" -- . 2>/dev/null); then echo "current"; return; fi
  if (cd "$dir" && git merge-base --is-ancestor "$a" "$m" 2>/dev/null); then echo "behind"; return; fi
  if (cd "$dir" && git merge-base --is-ancestor "$m" "$a" 2>/dev/null); then echo "current"; return; fi
  echo "diverged"
}
layer_bridge() { layer_git "$AGENT"; }
layer_responder() { layer_git "$ROOMY"; }
# The bridge must resolve the workspace SDK, and that workspace's dist must have
# been built from the src that is checked out. mtimes are useless here — a
# checkout/pull rewrites them — so the build is stamped with the source tree
# hash at build time (scripts/fleet-deploy.py writes it) and re-verified here.
SDK_STAMP="/home/exedev/.roomy/fleet-sdk-build"
sdk_src_hash() {
  ( cd "$ROOMY/packages/sdk" && find src -type f \
      \( -name '*.ts' -o -name '*.json' -o -name '*.svelte' \) -print0 2>/dev/null \
      | sort -z | xargs -0 cat 2>/dev/null | sha256sum | cut -d' ' -f1 )
}
layer_sdk() {
  local link; link=$(readlink -f "$AGENT/node_modules/@roomy-space/sdk" 2>/dev/null)
  [ "$link" = "$ROOMY/packages/sdk" ] || { echo stale; return; }
  [ -f "$ROOMY/packages/sdk/dist/index.js" ] || { echo stale; return; }
  local want have
  want=$(sdk_src_hash)
  have=$(cat "$SDK_STAMP" 2>/dev/null)
  [ -n "$want" ] && [ "$want" = "$have" ] && echo current || echo stale
}
service_state() { systemctl is-active omp-bridge 2>/dev/null || echo unknown; }

report() {  # $1=state $2=note
  jq -cn \
    --arg host "$host" \
    --arg bridge "$(layer_bridge)" \
    --arg responder "$(layer_responder)" \
    --arg sdk "$(layer_sdk)" \
    --arg service "$(service_state)" \
    --arg state "$1" \
    --arg note "$2" \
    --argjson busy "$busy" \
    --arg busy_reason "$reason" \
    --arg checked "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    '{host:$host,layers:{bridge:$bridge,responder:$responder,sdk:$sdk},
      service:$service,state:$state,note:$note,busy:($busy==1),busyReason:$busy_reason,checkedAt:$checked}'
}

fetch_remotes

if [ "$MODE" = "probe" ]; then
  if [ "$(layer_bridge)" = current ] && [ "$(layer_responder)" = current ] && [ "$(layer_sdk)" = current ]; then
    report current ""
  elif [ "$busy" -eq 1 ]; then
    report deferred "busy: $reason"
  else
    report pending ""
  fi
  exit 0
fi

# --- MODE=apply -------------------------------------------------------------
if [ "$busy" -eq 1 ]; then report deferred "busy: $reason"; exit 0; fi

before_bridge=$(cd "$AGENT" && git rev-parse HEAD 2>/dev/null)
before_responder=$(cd "$ROOMY" && git rev-parse HEAD 2>/dev/null)
before_sdk=$(layer_sdk)
changed=0

# Bring one repo to origin/main, ff-only. Safety rules, in order:
#   - trackable local modifications are never discarded (git refuses anyway)
#   - a `diverged` checkout (squash-merged or worker branch) is only switched to
#     main when the working tree is clean AND HEAD is pushed to some remote, so
#     the branch survives on the remote; otherwise it is reported `blocked`.
# Layer state is still judged by ancestry/tree, so an already-current checkout
# on any branch costs nothing.
advance_repo() {  # $1=dir $2=label
  local dir=$1 label=$2 st br
  st=$(layer_git "$dir")
  case "$st" in
    current) return 0 ;;
    diverged)
      br=$(cd "$dir" && git rev-parse --abbrev-ref HEAD)
      if [ -n "$(cd "$dir" && git status --porcelain 2>/dev/null | grep -v '^??')" ]; then
        report blocked "$label: '$br' diverged with local changes — manual"; return 1
      fi
      if [ -z "$(cd "$dir" && git branch -r --contains HEAD 2>/dev/null)" ]; then
        report blocked "$label: '$br' diverged and not pushed — manual"; return 1
      fi
      note "$label: '$br' diverged but clean+pushed; switching to main"
      ;;
  esac
  br=$(cd "$dir" && git rev-parse --abbrev-ref HEAD)
  if [ "$br" != "main" ]; then
    if ! ( cd "$dir" && git checkout main -q ) >>"$LOG" 2>&1; then
      report blocked "$label: cannot switch '$br' -> main"; return 1
    fi
  fi
  if ! ( cd "$dir" && git merge --ff-only origin/main -q ) >>"$LOG" 2>&1; then
    report blocked "$label: ff-only merge refused (local changes)"; return 1
  fi
  note "$label -> $(cd "$dir" && git rev-parse --short HEAD)"
  changed=1
  return 0
}

advance_repo "$ROOMY" responder || exit 0

# SDK dist rebuilds from the (possibly new) src, then is stamped with the source
# hash so later probes can tell a real build from mtime noise. Compare dist
# before/after: if the bytes changed, the running bridge holds the old module
# and must be restarted; if not, a rebuild is free and needs no restart.
if [ "$changed" -eq 1 ] || [ "$(layer_sdk)" != current ]; then
  dist_before=$(sha256sum "$ROOMY/packages/sdk/dist/index.js" 2>/dev/null | cut -d' ' -f1)
  if ! ( cd "$ROOMY" && pnpm --filter @roomy-space/sdk build ) >>"$LOG" 2>&1; then
    report blocked "sdk build failed (see $LOG)"; exit 0
  fi
  sdk_src_hash > "$SDK_STAMP" 2>/dev/null
  dist_after=$(sha256sum "$ROOMY/packages/sdk/dist/index.js" 2>/dev/null | cut -d' ' -f1)
  if [ "$dist_before" != "$dist_after" ]; then
    changed=1; note "sdk dist changed; restart required"
  fi
fi
# The bridge resolves @roomy-space/sdk; point it at the workspace build so SDK
# fixes are not shadowed by a stale npm tarball. Repointing the module the
# bridge already loaded also requires a restart.
if [ "$(readlink "$AGENT/node_modules/@roomy-space/sdk" 2>/dev/null)" != "$ROOMY/packages/sdk" ]; then
  if [ -e "$AGENT/node_modules/@roomy-space/sdk" ] && [ ! -L "$AGENT/node_modules/@roomy-space/sdk" ]; then
    rm -rf "$AGENT/node_modules/@roomy-space/sdk.npm.bak" 2>/dev/null
    mv "$AGENT/node_modules/@roomy-space/sdk" "$AGENT/node_modules/@roomy-space/sdk.npm.bak" 2>/dev/null
  fi
  ln -sfn "$ROOMY/packages/sdk" "$AGENT/node_modules/@roomy-space/sdk"
  changed=1; note "bridge sdk -> workspace build"
fi

advance_repo "$AGENT" bridge || exit 0

if [ "$changed" -eq 0 ]; then
  report current "no change needed"
  exit 0
fi

# Restart only when something actually changed; the responder reads its code at
# process start, so a responder-only update needs the restart too.
if sudo -n systemctl restart omp-bridge >>"$LOG" 2>&1; then
  sleep 6
  report updated "restarted (bridge=$(cd "$AGENT" && git rev-parse --short HEAD) responder=$(cd "$ROOMY" && git rev-parse --short HEAD))"
else
  report error "systemctl restart failed"
fi
'''


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    """Single writer for the run log. The detached systemd unit deliberately
    does NOT redirect stdout to this file — it goes to the journal — so lines
    are never duplicated."""
    line = f"{now_iso()} {msg}"
    print(line, flush=True)
    try:
        with open(RUN_LOG, "a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def run_on(host: str, dest: str | None, mode: str, timeout: int = 600) -> dict:
    """Run the remote payload on one host and return its JSON report."""
    if dest is None:  # local (the coordinator's own VM)
        argv = ["bash", "-s", "--", mode]
    else:
        argv = [
            "ssh", "-i", SSH_KEY,
            "-o", "StrictHostKeyChecking=no",
            "-o", "ConnectTimeout=15",
            "-o", "BatchMode=yes",
            f"exedev@{dest}", f"bash -s -- {mode}",
        ]
    try:
        p = subprocess.run(argv, input=REMOTE, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"host": host, "state": "error", "note": f"timeout after {timeout}s", "checkedAt": now_iso()}
    out = (p.stdout or "").strip().splitlines()
    for line in reversed(out):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                break
    return {
        "host": host,
        "state": "error",
        "note": (p.stderr or p.stdout or "no report").strip().splitlines()[-1][:200] if (p.stderr or p.stdout) else "no report",
        "checkedAt": now_iso(),
    }


def load_state() -> dict:
    try:
        with open(STATE_JSON) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {"round": 0, "targets": {}}


def write_state(state: dict) -> None:
    os.makedirs(os.path.dirname(STATE_JSON), exist_ok=True)
    tmp = STATE_JSON + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, STATE_JSON)
    with open(STATE_MD, "w") as fh:
        fh.write(render_md(state))
    os.chmod(STATE_MD, 0o644)
    os.chmod(STATE_JSON, 0o644)


SYMBOL = {"current": "ok", "updated": "UPDATED", "pending": "pending",
          "deferred": "deferred", "blocked": "BLOCKED", "error": "ERROR"}


def render_md(state: dict) -> str:
    t = state.get("targets", {})
    lines = [
        "# Fleet deploy state",
        "",
        f"- started:  {state.get('startedAt', '-')}",
        f"- updated:  {state.get('updatedAt', '-')}",
        f"- round:    {state.get('round', 0)}",
        f"- finished: {state.get('finished', False)}"
        + (f" at {state['finishedAt']}" if state.get("finishedAt") else ""),
        f"- command:  {state.get('command', '-')}",
        "",
        "| host | bridge | responder | sdk | service | state | note |",
        "|---|---|---|---|---|---|---|",
    ]
    for host in sorted(t):
        r = t[host]
        L = r.get("layers", {})
        lines.append(
            f"| {host} | {L.get('bridge','?')} | {L.get('responder','?')} | {L.get('sdk','?')} "
            f"| {r.get('service','?')} | {SYMBOL.get(r.get('state'), r.get('state','?'))} "
            f"| {r.get('note','') or ''} |"
        )
    lines.append("")
    return "\n".join(lines)


def fleet_targets(hosts_arg: str | None) -> dict[str, str | None]:
    if not hosts_arg:
        return dict(DEFAULT_FLEET)
    want = [h.strip() for h in hosts_arg.split(",") if h.strip()]
    unknown = [h for h in want if h not in DEFAULT_FLEET]
    if unknown:
        sys.exit(f"unknown host(s): {', '.join(unknown)} (known: {', '.join(DEFAULT_FLEET)})")
    return {h: DEFAULT_FLEET[h] for h in want}


def is_done(r: dict) -> bool:
    return r.get("state") in ("current", "updated")


def main() -> int:
    ap = argparse.ArgumentParser(description="Roll the Roomy agent stack to all workers.")
    ap.add_argument("--status", action="store_true", help="print current state and exit")
    ap.add_argument("--json", action="store_true", help="with --status: print the raw JSON")
    ap.add_argument("--dry-run", action="store_true", help="probe only; change nothing")
    ap.add_argument("--once", action="store_true", help="single pass, do not poll")
    ap.add_argument("--detach", action="store_true", help="re-exec as a transient systemd unit and exit")
    ap.add_argument("--hosts", default=None, help="comma-separated subset (default: whole fleet)")
    ap.add_argument("--interval", type=int, default=300, help="seconds between rounds (default 300)")
    ap.add_argument("--max-rounds", type=int, default=0, help="stop after N rounds (0 = until done)")
    ap.add_argument("--max-hours", type=float, default=24.0, help="give up after this long (default 24)")
    args = ap.parse_args()

    if args.status:
        state = load_state()
        if args.json:
            print(json.dumps(state, indent=2, sort_keys=True))
        elif state.get("targets"):
            sys.stdout.write(render_md(state))
        else:
            print(f"no state yet ({STATE_JSON} does not exist)")
        return 0

    if args.detach:
        if os.environ.get("FLEET_DEPLOY_DETACHED"):
            sys.exit("already detached (FLEET_DEPLOY_DETACHED set)")
        cmd = [
            "sudo", "-n", "systemd-run", "--unit", UNIT_NAME, "--collect",
            "--property=User=exedev",
            "--property=Type=simple",
            f"--property=WorkingDirectory={os.getcwd()}",
            f"--property=Environment=HOME=/home/exedev",
            f"--property=Environment=FLEET_DEPLOY_DETACHED=1",
            f"--property=Environment=FLEET_DEPLOY_LOG_BY_UNIT=1",
            sys.executable, os.path.abspath(__file__),
        ]
        if args.dry_run:
            cmd.append("--dry-run")
        if args.once:
            cmd.append("--once")
        if args.hosts:
            cmd += ["--hosts", args.hosts]
        cmd += ["--interval", str(args.interval), "--max-hours", str(args.max_hours)]
        if args.max_rounds:
            cmd += ["--max-rounds", str(args.max_rounds)]
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode != 0:
            sys.stderr.write(p.stderr)
            return p.returncode
        sys.stdout.write(p.stdout)
        print(f"detached as {UNIT_NAME}.service")
        print(f"  status:  {sys.argv[0]} --status")
        print(f"  state:   {STATE_JSON}")
        print(f"  log:     journalctl -u {UNIT_NAME} -f   |   {RUN_LOG}")
        return 0

    targets = fleet_targets(args.hosts)
    mode = "probe" if args.dry_run else "apply"
    started = time.time()
    state = load_state()
    state.update({
        "startedAt": now_iso(),
        "updatedAt": now_iso(),
        "round": 0,
        "finished": False,
        "finishedAt": None,
        "command": " ".join(["fleet-deploy.py"] + [a for a in sys.argv[1:]]),
        "dryRun": bool(args.dry_run),
        "targets": {h: state.get("targets", {}).get(h, {}) for h in targets},
    })
    write_state(state)

    # Order matters: the local host (dest None) goes last. Restarting the bridge
    # on this VM kills every process in omp-bridge's cgroup, including the agent
    # session that started this run (KillMode=control-group). Under --detach the
    # script lives in its own unit and survives, but in the foreground it would
    # die — so every remote host is updated before the local bridge is touched.
    order = [h for h, d in targets.items() if d is not None]
    if any(d is None for d in targets.values()):
        order += [h for h, d in targets.items() if d is None]

    round_no = 0
    while True:
        round_no += 1
        state["round"] = round_no
        log(f"round {round_no}: probing {len(targets)} host(s) [mode={mode}]")
        pending = 0
        for host in order:
            r = run_on(host, targets[host], mode)
            r.setdefault("host", host)
            state["targets"][host] = r
            st = r.get("state", "error")
            L = r.get("layers", {})
            log(f"  {host:18s} {SYMBOL.get(st, st):8s} "
                f"bridge={L.get('bridge','?'):7s} responder={L.get('responder','?'):7s} "
                f"sdk={L.get('sdk','?'):7s} {r.get('note','')}")
            if not is_done(r):
                pending += 1
            state["updatedAt"] = now_iso()
            write_state(state)

        exhausted = bool(args.max_rounds and round_no >= args.max_rounds)
        timed_out = (time.time() - started) > args.max_hours * 3600
        if pending == 0:
            state["finished"] = True
            state["finishedAt"] = now_iso()
            write_state(state)
            log(f"done: all {len(targets)} host(s) current after {round_no} round(s)")
            return 0
        if args.once or exhausted or timed_out:
            state["finished"] = False
            state["finishedAt"] = now_iso()
            state["note"] = ("single pass" if args.once else
                             "round limit reached" if exhausted else "time limit reached")
            write_state(state)
            log(f"stopping: {pending} host(s) not current ({state['note']}); "
                f"re-run or inspect {STATE_MD}")
            return 1
        log(f"{pending} host(s) not current; re-checking in {args.interval}s")
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
