# Kaola Project Runner — Capability Measurement (for Issue #34)

Read-only measurement of `/Volumes/WorkspaceA/ylminiserver/workspace/kaola-project-runner`
(GitHub `KaolaBrother/kaola-project-runner`). Target repo was NOT modified. Only this file
was written.

## Setup

- Commit measured: `fa19c63dc7f24bc60790aa705bd4678379a7b159`, dated `2026-08-31 16:27:15 +0800`,
  message `chore: archive issue-10 [sink]` (`git log -1 --format='%H %ad %s'`).
- Branch: `main`, tracking `origin/main`, working tree clean (`git status`).
- No git tags (`git tag -l` → empty). No `VERSION` file anywhere in the tree
  (`find . -iname "VERSION*"` → empty). No `package.json` anywhere under the repo
  (`find . -maxdepth 3 -name package.json` → empty) — **this is not an npm-distributed CLI**;
  it is a bash + Python tool tree plus generated Codex "Skill" directories.
- Commands run are quoted verbatim in each section below.

---

## 1. Public inventory

The Runner has three separate command surfaces. All are shell scripts under `scripts/`, none
are installed as a system PATH binary (`command -v kaola-tmux.sh` and `command -v kaola-tmux`
both returned nothing in this environment).

**A. Session/control core** — `scripts/kaola-tmux.sh` (`/Volumes/WorkspaceA/ylminiserver/workspace/kaola-project-runner/scripts/kaola-tmux.sh:20-33`, usage banner, verified live by running `./scripts/kaola-tmux.sh` with no args → prints identical banner, exit code `2`):

```
kaola-tmux.sh PLATFORM preflight --repo ABS_PATH --session NAME
kaola-tmux.sh PLATFORM start     --repo ABS_PATH --session NAME [--continue | --resume ID] [--model ID --effort LEVEL]
kaola-tmux.sh PLATFORM observe   --repo ABS_PATH --session NAME
kaola-tmux.sh PLATFORM status    --repo ABS_PATH --session NAME
kaola-tmux.sh PLATFORM capture   --repo ABS_PATH --session NAME [--lines N]
kaola-tmux.sh PLATFORM send      --repo ABS_PATH --session NAME [--if-snapshot ID] [--text TEXT]
kaola-tmux.sh PLATFORM key       --repo ABS_PATH --session NAME [--if-snapshot ID] --key NAME
kaola-tmux.sh PLATFORM answer    --repo ABS_PATH --session NAME [--decision-id ID] [--if-snapshot ID] --replace-editor [--text TEXT]
kaola-tmux.sh PLATFORM stop      --repo ABS_PATH --session NAME [--if-snapshot ID] [--force]
```

Command names are enforced by a whitelist case statement:
`case "$command_name" in preflight|start|observe|status|capture|send|key|answer|stop) ;; *) die "unknown command: $command_name" ;; esac`
(`scripts/kaola-tmux.sh:60`). PLATFORM is likewise whitelisted:
`case "$platform" in grok|claude-code|opencode|kimi-cli|cursor-cli) ;; *) die "unknown platform: $platform" ;; esac`
(`scripts/kaola-tmux.sh:51`).

**B. Per-platform thin wrappers** — each installed Codex Skill embeds a copy of the whole
`scripts/` tree plus a generated `runtime-tmux.sh` that pre-binds PLATFORM and `exec`s into
`kaola-tmux.sh`. Verbatim content, e.g. Grok
(`skills/grok-kaola-project-runner/scripts/runtime-tmux.sh:1-4`):
```
#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$script_dir/kaola-tmux.sh" grok "$@"
```
Confirmed identical pattern (only the platform token differs, plus one extra `export
KAOLA_CLAUDE_PROFILE_REQUIRED=true` line for Claude) in
`skills/claude-code-kaola-project-runner/scripts/runtime-tmux.sh`,
`skills/opencode-kaola-project-runner/scripts/runtime-tmux.sh`,
`skills/kimi-cli-kaola-project-runner/scripts/runtime-tmux.sh`,
`skills/cursor-cli-kaola-project-runner/scripts/runtime-tmux.sh`.
Literal invocation form seen from these wrappers: `scripts/runtime-tmux.sh preflight --repo
"$REPO" --session "$SESSION"` (`skills/grok-kaola-project-runner/SKILL.md:16-20`).

**C. `$name-kaola-project-runner` "bare invocation"** — this is NOT a shell command a human
types; it is a Codex **Skill** name (agent-instruction markdown at
`skills/<platform>-kaola-project-runner/SKILL.md`), documented in `README.md:53-61` as:
```
$grok-kaola-project-runner
$claude-code-kaola-project-runner
$opencode-kaola-project-runner
$kimi-cli-kaola-project-runner
$cursor-cli-kaola-project-runner
```
It is resolved by a Codex agent that has this repo's `scripts/install-local.sh` symlinks
installed under `${CODEX_HOME:-$HOME/.codex}/skills/<skill-name>`, which then reads the
SKILL.md and drives it by literally invoking form B above. **There is no standalone Runner
daemon/server binary and no argv the Runner itself parses for this "bare" form** — it only
exists as agent-followed prose plus the same `scripts/runtime-tmux.sh`/`scripts/kaola-tmux.sh`
argv described above.

**Two other maintenance-only entry points** (not session lifecycle verbs):
- `scripts/render-skills.py --write` / `--check` — regenerates/verifies the five Skill
  directories from templates (`README.md:34-38`, `docs/api.md:5-12`).
- `scripts/install-local.sh [--platform ID[,ID...]] [--uninstall]` — creates/removes the
  `~/.codex/skills/*` symlinks (`README.md:40-51`, `docs/api.md:16-24`).
- `scripts/grok-tmux.sh` — a frozen compatibility wrapper, "equivalent to `scripts/kaola-tmux.sh
  grok ...`" (`README.md:123-124`), not verified byte-for-byte in this pass (see Gaps).
- `./scripts/validate.sh` — offline validator, not a session-lifecycle command
  (`README.md:149-156`).

---

## 2. PINNED RUNTIME VARIANT LIST

Canonical enum, verified at the single source-of-truth gate
(`scripts/kaola-tmux.sh:51`):

```
grok | claude-code | opencode | kimi-cli | cursor-cli
```

Each value is independently confirmed as the adapter's own `ADAPTER_ID` self-check
(`scripts/kaola-tmux.sh:56`: `[[ "${ADAPTER_ID:-}" == "$platform" ]] || die "adapter identity mismatch"`)
against the literal assignments:

| Enum value (canonical identifier) | `path:line` | Display name | Default CLI binary | `path:line` |
|---|---|---|---|---|
| `grok` | `scripts/adapters/grok.sh:5` (`ADAPTER_ID="grok"`) | `Grok CLI` | `grok` | `scripts/adapters/grok.sh:6-7` |
| `claude-code` | `scripts/adapters/claude-code.sh:5` | `Claude Code` | `claude` | `scripts/adapters/claude-code.sh:6-7` |
| `opencode` | `scripts/adapters/opencode.sh:5` | `OpenCode` | `opencode` | `scripts/adapters/opencode.sh:6-7` |
| `kimi-cli` | `scripts/adapters/kimi-cli.sh:5` | `Kimi CLI` | `kimi` | `scripts/adapters/kimi-cli.sh:6-7` |
| `cursor-cli` | `scripts/adapters/cursor-cli.sh:5` | `Cursor CLI` | `cursor-agent` | `scripts/adapters/cursor-cli.sh:6-7` |

Runner default main model per adapter (per-run parameter, not global config —
`scripts/kaola-tmux.sh:117-127`, `resolve_model_policy`):

| Enum value | Default model name | Default model id | Default effort | Recurring |
|---|---|---|---|---|
| `grok` | Grok 4.6 Extra High | `grok-4.6` | `xhigh` | `supported` (`scripts/adapters/grok.sh:9`) |
| `claude-code` | Opus 5 High | `opus` | `high` | `unsupported` |
| `opencode` | GLM 5.3 Max | `zhipuai-coding-plan/glm-5.3` | `max` | `unsupported` |
| `kimi-cli` | Kimi K3 Max | `kimi-code/k3` | `max` | `unsupported` |
| `cursor-cli` | Grok 4.6 Extra High (Cursor-hosted) | `cursor-grok-4.6-xhigh` | `xhigh` | `unsupported` |

This exactly matches `README.md:18-26`'s support table (Grok CLI/`grok`, Claude Code/`claude`,
OpenCode/`opencode`, Kimi CLI/`kimi`, Cursor CLI/`cursor-agent`); the source is the
authoritative spelling because README could drift, source cannot without breaking
`ADAPTER_ID` self-check.

**Version / snapshot identity**: there is no semver "Runner version" field anywhere (no
`package.json`, no `VERSION` file, no git tag). The only reproducible snapshot identity is the
git commit: `fa19c63dc7f24bc60790aa705bd4678379a7b159` (2026-08-31 16:27:15 +0800). Kaola Tasks
fixtures should pin to this commit hash, not to a version string.

---

## 3. Session model

The session locator a caller must record to re-attach is the **literal pair
`(--repo ABS_PATH, --session NAME)`** passed to every command
(`scripts/kaola-tmux.sh:23-31` usage banner; enforced at `scripts/kaola-tmux.sh:83-88`).

- `--session NAME` becomes an actual **tmux session name**, validated by
  `[[ "$session" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$ ]] || die "invalid session name"`
  (`scripts/kaola-tmux.sh:87`), and targeted as `TMUX_SESSION_TARGET="=$session"`
  (`scripts/kaola-tmux.sh:88`, the `=` prefix requests tmux's exact-name match).
- `--repo ABS_PATH` must be an absolute, existing directory that IS the git top-level:
  `[[ "$repo" == /* && -d "$repo" ]] || die "--repo must be an existing absolute path"`
  then `git_root="$(git -C "$repo" rev-parse --show-toplevel ...)"` then
  `[[ "$git_root" == "$repo" ]] || die "--repo must name the Git root: $git_root"`
  (`scripts/kaola-tmux.sh:83-86`). Ownership of a session is proved, not just named: tmux
  session-scoped environment variables `KAOLA_PROJECT_RUNNER=1`,
  `KAOLA_PROJECT_RUNNER_PLATFORM=<platform>`, `KAOLA_PROJECT_RUNNER_REPO=<repo>` are set at
  `start` (`scripts/kaola-tmux.sh:399`) and re-checked on every subsequent command via
  `load_session_identity()` (`scripts/kaola-tmux.sh:239-263`), which requires pane count == 1,
  the owner/platform/repo tmux-env markers to match, the relay process to match by PGID/PID
  fingerprint, etc. There is also a separate **CLI-native session id**
  (`STATE_RUNTIME_SESSION_ID`, per-adapter regex extraction, e.g. Claude Code:
  `sed -nE 's/.*Session ID: ([0-9a-fA-F-]{16,}).*/\1/p'` at
  `scripts/adapters/claude-code.sh:138`) — this is evidence only, used to populate `--resume ID`
  on a later `start`; it is not itself the tmux locator.

**Stability across Runner restart**: the Runner has no daemon/server process of its own — each
`kaola-tmux.sh` invocation is a discrete, short-lived script. The durable state is the **tmux
server** (holding the session) plus a per-session **nested-PTY relay** process that is the tmux
pane's leader (spawned at `start`, `scripts/kaola-tmux.sh:401-402` via
`"$PYTHON_BIN" "$RELAY" ...`) and its Unix-domain control socket at
`$TMPDIR/kpr-<uid>/<epoch>.sock` (`scripts/kaola-tmux.sh:213-215`,
`cleanup_terminal_socket()`). So: the session locator IS stable across repeated invocations of
`kaola-tmux.sh` (i.e., "Runner restarts" in the sense of re-running the script), because the
script carries no in-process state — but it is NOT stable across a tmux-server restart/reboot or
`kill-session`, since that is where the actual session lives. This is a measured architectural
fact, not a documented guarantee; the docs never use the words "restart" or "daemon" for the
Runner itself (`docs/architecture.md`, `docs/api.md` searched, no matches for those terms
describing the Runner process).

---

## 4. Lifecycle verbs

All nine exist as literal subcommands of `kaola-tmux.sh` (dispatch table
`scripts/kaola-tmux.sh:366-477`). Mapped to the requested taxonomy:

| Requested verb | Exists? | Exact command | Returns | `path:line` |
|---|---|---|---|---|
| start | Yes | `kaola-tmux.sh PLATFORM start --repo P --session S [--continue\|--resume ID] [--model ID --effort LVL]` | JSON status view with `result` one of `started`/`already-running`/`existing-session-not-reusable`/`start-exited`/`start-pending` | `scripts/kaola-tmux.sh:380-402` |
| observe (read output) | Yes | `kaola-tmux.sh PLATFORM observe --repo P --session S` | schema-v2 JSON: `raw_current_frame`, `hard_evidence`, relay byte revisions, `snapshot_id`/`based_on_snapshot`, process/approval/decision facts | `scripts/kaola-tmux.sh:377`, `observe_managed()` at `:288-300`, schema doc `docs/architecture.md` §Observation |
| send (inject input) | Yes | `kaola-tmux.sh PLATFORM send --repo P --session S [--if-snapshot ID] [--text TEXT]` (or stdin) | JSON `result:sent`, `mutation_performed:true`, `payload_fingerprint:sha256:...` | `scripts/kaola-tmux.sh:432-441` |
| capture (screenshot/frame dump) | Yes, but text-only | `kaola-tmux.sh PLATFORM capture --repo P --session S [--lines N (1..5000, default 120)]` | raw `tmux capture-pane -p` text output (NOT an image/PNG — it is a plain-text terminal scrollback dump) | `scripts/kaola-tmux.sh:379` |
| stop | Yes | `kaola-tmux.sh PLATFORM stop --repo P --session S [--if-snapshot ID] [--force]` | Graceful: sends adapter quit text, polls up to 10s, `result:stopped`/`quit-pending`. Forced (`--force`): `force_stop_exact()`, kills the exact tmux session, reports `result:stopped`/`termination-uncertain` with `final_state` object | `scripts/kaola-tmux.sh:460-477`, `force_stop_exact()` at `:311-354` |

Two additional verbs exist beyond the requested five (also part of the same whitelist,
`scripts/kaola-tmux.sh:60`):
- `preflight` — dry-run readiness check + model policy resolution, no session mutation
  (`scripts/kaola-tmux.sh:367-373`).
- `status` — reports `present`/`absent`/`already-stopped` plus the same observation status view,
  read-only (`scripts/kaola-tmux.sh:378`).
- `key` — Agent-selected native key transport (`--key up|down|left|right|enter|escape|tab|backtab|space`), distinct from `send` (no literal text, terminal control bytes only) (`scripts/kaola-tmux.sh:446-459`).
- `answer --replace-editor` — whole-editor-replace transport, **verified to exist for only one
  platform**: `[[ "$ADAPTER_ANSWER_MODE" == claude-clear-v1 ]] || { emit_transport_result
  answer-unsupported answer false; exit 1; }` (`scripts/kaola-tmux.sh:416`). Confirmed
  `ADAPTER_ANSWER_MODE` values: `claude-code.sh:11 → claude-clear-v1`; all of `opencode.sh:11`,
  `cursor-cli.sh:11`, `kimi-cli.sh:11`, `grok.sh:11` → `unsupported`.

**What does NOT exist**: there is no true screenshot/image capture (capture is `tmux
capture-pane -p`, plain text only, no bitmap/PNG option anywhere in the script or its `--help`).
There is no `list`/`ls` verb to enumerate existing sessions — a caller must already know
`--session NAME` (or independently query tmux itself, outside the Runner's own surface). There
is no `restart` verb — recovery is `start` again (with `already-running` detection) or explicit
`stop --force` then `start`.

---

## 5. Repository ownership

**The Runner does not clone.** It requires a pre-existing checkout and validates it is exactly
the git top-level, refusing anything else. Exact quoted requirement
(`scripts/kaola-tmux.sh:83-86`):
```
[[ "$repo" == /* && -d "$repo" ]] || die "--repo must be an existing absolute path"
PUBLIC_REPO="$repo"
repo="$(canonical_dir "$repo")"; git_root="$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null)" || die "not a Git repository: $repo"
git_root="$(canonical_dir "$git_root")"; [[ "$git_root" == "$repo" ]] || die "--repo must name the Git root: $git_root"
```
Confirmed in docs too: "`--repo` must resolve to the exact Git top-level." (`docs/api.md:41`).
No `git clone`, `git init`, `git remote`, or `git checkout` invocation exists anywhere in
`scripts/`, `platforms/`, `docs/`, or `README.md` — verified by
`grep -rn "clone\|git remote\|git init\|git checkout" scripts/ platforms/ docs/ README.md` →
no matches. `git -C "$repo" rev-parse --show-toplevel` is git-worktree-aware (a worktree's own
root satisfies the check), so a Kaola Workflow worktree is acceptable as `--repo`, but it must
already exist before any `kaola-tmux.sh ... start` call — **Kaola Tasks must clone/establish the
Workflow worktree before invoking the Runner.**

---

## 6. Credential/secret surfaces

Enumerated exact mechanisms found (all in `scripts/kaola-tmux.sh` unless noted):

1. **Environment passthrough to the child tmux session** — the invoking process's OWN
   environment is scanned and selectively forwarded into the new tmux session at `start`:
   ```
   session_env_args=(); while IFS='=' read -r name value; do case "$name" in CLAUDE_*|GROK_*|OPENCODE_*|KIMI_*|CURSOR_*|FAKE_*) session_env_args+=(-e "$name=$value") ;; esac; done < <(env)
   ```
   (`scripts/kaola-tmux.sh:403`). Any variable in the calling Agent's environment matching those
   five prefixes (e.g. a hypothetical `CLAUDE_API_KEY`) is copied verbatim into the tmux
   session's environment via `tmux new-session -e NAME=VALUE`, then visible to anyone who can run
   `tmux show-environment -t <session>` against that tmux server. This is the single largest
   named leak surface Kaola Tasks should scan for before invoking `start`.
2. **`OPENCODE_CONFIG_CONTENT`** — the OpenCode adapter's
   `adapter_prepare_model_environment()` builds a merged JSON config string
   (`scripts/adapters/opencode.sh:52-67`) and injects it the same way, via
   `ADAPTER_MODEL_ENV+=(...)` folded into the same `-e` args at `scripts/kaola-tmux.sh:406-408`
   — same tmux-environment exposure as above, and it is a JSON blob that could carry
   provider keys if present in the caller's config source.
3. **`KIMI_MODEL_THINKING_EFFORT`** — cosmetic effort param, not a secret
   (`scripts/adapters/kimi-cli.sh:50`), listed only to be exhaustive.
2. **Transient frame file** — every `observe`/`status`/`start` polling loop writes the current
   raw terminal frame (which can include anything visible on screen, e.g. an operator pasting a
   token) to `mktemp "${TMPDIR:-/tmp}/kpr-frame.XXXXXX"` (`scripts/kaola-tmux.sh:277`), passes
   the path to `kaola-model-policy.py verify` and `kaola-observation.py build`, then deletes it
   at the end of the same call: `rm -f "$temporary"` (`scripts/kaola-tmux.sh:283`). Narrow
   window of on-disk exposure, not a persistent log.
3. **Relay request/reply FIFOs** — `open_relay_channel()` creates
   `mktemp -d "${TMPDIR:-/tmp}/kpr-channel.XXXXXX"` with `mkfifo request reply`
   (`scripts/kaola-tmux.sh:212`), used to pass the JSON-RPC-like relay protocol (including
   `payload_hex` of whatever was sent/answered) between the shell and the relay client; removed
   in `close_relay_channel()`: `rm -rf "$RELAY_DIR"` (`scripts/kaola-tmux.sh:211`). Same
   transient-file caveat as above.
4. **Relay control-plane Unix socket** — `$TMPDIR/kpr-<uid>/<epoch>.sock`
   (`scripts/kaola-tmux.sh:213-215`, `cleanup_terminal_socket()`), a live control channel (not a
   readable log), scoped by directory to the invoking uid; removed on confirmed stop.
5. **All command output (stdout)** — `capture` and `observe`/`status` print the raw terminal
   frame / scrollback (`"$TMUX_BIN" capture-pane -p ...`, `scripts/kaola-tmux.sh:379`) to
   **stdout of the caller**, i.e. whatever secret text is visible in the target CLI's terminal
   (a pasted token, an interactive login prompt, etc.) is returned directly in the JSON/text
   response. This is not a Runner-owned log file, but it is the primary place secrets would
   surface to any caller/log-capturing wrapper around `kaola-tmux.sh`.
6. **tmux server scrollback itself** — `capture-pane -S -100`/`-S -$lines` reads tmux's own
   in-memory pane history (`scripts/kaola-tmux.sh:246`, `:379`); this history persists in the
   tmux server's memory (not on disk) for as long as the session lives, and is readable by
   anyone able to attach to or query that tmux server/socket.
7. **No outbound network calls** found in any Python helper —
   `grep -n "AF_INET\|requests\.\|urllib\|http://\|https://" scripts/*.py` → no matches; the
   only sockets opened are `AF_UNIX` to the local relay (`kaola-pane-relay.py`,
   `kaola-relay-client.py`).

---

## 7. Availability in THIS environment

Measured, no session-starting or state-mutating command executed:

| Tool | Command | Result |
|---|---|---|
| tmux | `command -v tmux && tmux -V` | `/opt/homebrew/bin/tmux`, `tmux 3.7b` — installed |
| python3 | `command -v python3 && python3 --version` | `/opt/homebrew/bin/python3`, `Python 3.14.3` — installed |
| claude | `command -v claude` | `/opt/homebrew/bin/claude` — installed |
| grok | `command -v grok` | `/opt/homebrew/bin/grok` — installed |
| opencode | `command -v opencode` | `/opt/homebrew/bin/opencode` — installed |
| kimi | `command -v kimi` | `/Users/ylminiserver/.kimi-code/bin/kimi` — installed |
| cursor-agent | `command -v cursor-agent` | `/Users/ylminiserver/.local/bin/cursor-agent` — installed |
| Runner global binary | `command -v kaola-tmux.sh`, `command -v kaola-tmux` | both empty — **no global PATH binary**; only the in-repo script and the installed Skill symlinks exist |
| Skill installation | `ls "${CODEX_HOME:-$HOME/.codex}/skills"` | All five `*-kaola-project-runner` entries present as symlinks into this repo's `skills/` dir, e.g. `grok-kaola-project-runner -> /Volumes/WorkspaceA/ylminiserver/workspace/kaola-project-runner/skills/grok-kaola-project-runner` — installed via `scripts/install-local.sh` at some earlier point |
| Side-effect-free run | `./scripts/kaola-tmux.sh` (no args) | Printed the exact usage banner shown in §1, exit code `2` — this only exercises argument parsing (`platform="${1:-}"; [[ -n "$platform" ]] || { usage; exit 2; }` at `scripts/kaola-tmux.sh:50`) before any tmux/session/adapter code runs; confirmed **no tmux session, socket, or file was created** by this invocation |

**No `preflight`, `start`, or any session-mutating/session-observing subcommand was executed** —
those would create a real tmux session and spawn the target CLI's live process, which is outside
this read-only measurement's mandate. So: the Runner's toolchain (tmux, python3, all five
target CLI binaries) IS present and runnable in this environment, and the Runner's own script
IS installed as Codex Skills here, but **no live session start/stop was performed or observed**;
Kaola Tasks must not record "session lifecycle verified end-to-end" from this measurement — only
"dependencies present, `--help`-equivalent usage confirmed."

---

## 8. Gaps — not determinable from this pass

- **`scripts/grok-tmux.sh` byte-level equivalence** to `kaola-tmux.sh grok ...` was not diffed;
  README's claim (`README.md:123-124`) was not independently verified.
- **Actual `start`→`observe`→`send`→`stop` round trip** was not executed for any of the five
  platforms in this environment (out of scope for a read-only, non-mutating measurement — doing
  so would spawn real tmux sessions and real CLI child processes, which is a mutation of
  session/process state, not of the repository, but was excluded because the task explicitly
  said not to run anything that "starts a session or mutates state"). This means the JSON
  response *shapes* documented in §4 are sourced from code and `docs/architecture.md`/`docs/api.md`,
  not from a captured live response in this pass. Prior live-smoke evidence exists in-repo
  (`docs/live-smoke-2026-08-29.md`, `docs/live-smoke-evidence-first-2026-08-30.md`,
  `docs/live-smoke-model-policy-2026-08-30.md`, `docs/live-smoke-issue-9-2026-08-31.md`) but
  was not re-verified or re-executed here; treat those as the Runner project's own prior
  self-reported evidence, not this measurement's evidence.
- **Whether the caller's actual shell environment on a real Kaola Tasks execution host would
  contain any `CLAUDE_*/GROK_*/OPENCODE_*/KIMI_*/CURSOR_*/FAKE_*` secret** was not evaluated —
  that depends on Kaola Tasks' own deployment environment, not on the Runner's source, and is
  therefore explicitly out of scope for a Runner-only measurement.
- **tmux-server persistence across a host reboot** was inferred from code structure (relay is a
  child of tmux, no separate Runner daemon), not measured by actually rebooting or restarting
  the tmux server.
