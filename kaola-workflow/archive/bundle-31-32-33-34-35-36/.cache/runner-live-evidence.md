# Issue #34 live Runner evidence — executed run
Runner snapshot: commit fa19c63d (fa19c63)
Runtime variant: claude-code   tmux: tmux 3.7b
Repo (git top-level): /private/tmp/claude-501/-Volumes-WorkspaceA-ylminiserver-workspace-KaolaTasks/55e0a011-f56d-4208-b551-8c7a6611e6f1/scratchpad/runner-evidence-repo
Session: kt34-live-evidence
Date: 2026-08-31T11:11:30Z

## 1. preflight
{"actual_parameters": null, "actual_runtime_model_id": null, "detail": "Claude Code communication is available; Kaola carrier=/Users/ylminiserver/.claude; launch-option evidence=not-checked", "kaola_workflow_finalize": true, "model_evidence_provenance": {"catalog_probe": {"available_models": ["fable", "opus", "plugins                        Manage Claude Code plugins", "session_id", "sonnet", "tokens>           Auto-compact window size (auto, or", "upgrade                        Check for updates and install if"], "probes": [{"command": ["claude", "--help"], "output_digest": "sha256:dd59344cc6bb66e7c7332503ced5e9b8a27403f2afb08bf07efd9d37a2c5c85b", "returncode": 0}], "state": "readable"}, "requested": {"name": "Opus 5 High", "source": "runner-default"}, "resolution": {"candidate_id": "opus", "display_name": "Opus", "resolved_id": "opus", "state": "resolved", "supported_options": ["--effort"]}}, "model_mismatch_reason": "actual-model-evidence-not-yet-read", "model_verified": "unknown", "platform": "claude-code", "project_materialization": "not-required", "recurring_execution": "unsupported", "repo": "/private/tmp/claude-501/-Volumes-WorkspaceA-ylminiserver-workspace-KaolaTasks/55e0a011-f56d-4208-b551-8c7a6611e6f1/scratchpad/runner-evidence-repo", "requested_model_name": "Opus 5 High", "requested_model_source": "runner-default", "resolved_parameters": {"effort": "high"}, "resolved_runtime_model_display": "Opus", "resolved_runtime_model_id": "opus", "result": "ready", "runtime": "Claude Code", "runtime_binary": "/opt/homebrew/bin/claude", "runtime_version": "2.1.250 (Claude Code)", "session": "kt34-live-evidence", "workflow_next": true}

## 2. start
{"activity": "waiting-human", "activity_hint": "waiting-human", "child_process_count": 0, "child_processes": [], "editor_fingerprint": "sha256:e987257922a506095c873081d00d5282b8ed48d994b21927c0e50faae434928e", "editor_state": "nonempty", "evidence_flags": ["editor-nonempty", "visible-agent-unknown", "visible-shell-unknown"], "git": {"ahead": -1, "behind": -1, "branch": "master", "changed_count": 0, "clean": true, "head": "95bd11b10049", "upstream": ""}, "git_ahead": -1, "git_behind": -1, "git_branch": "master", "git_changed_count": 0, "git_clean": true, "git_head": "95bd11b10049", "git_upstream": "", "hard_evidence": {"alternate_on": false, "cursor_flag": false, "cursor_x": 1, "cursor_y": 19, "history_bytes": 10848, "history_size": 7, "owned": true, "pane_command": "Python", "pane_count": 1, "pane_dead": false, "pane_height": 24, "pane_id": "%47", "pane_input_off": false, "pane_path": "/private/tmp/claude-501/-Volumes-WorkspaceA-ylminiserver-workspace-KaolaTasks/55e0a011-f56d-4208-b551-8c7a6611e6f1/scratchpad/runner-evidence-repo", "pane_pid": 57684, "pane_process": "/opt/homebrew/Cellar/python@3.14/3.14.3_1/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python /Volumes/WorkspaceA/ylminiserver/workspace/kaola-project-runner/scripts/kaola-pane-relay.py --tmux-bin /opt/homebrew/bin/tmux --session kt34-live-evidence --pane-id %47 --repo /private/tmp/claude-501/-Volumes-WorkspaceA-ylminiserver-workspace-KaolaTasks/55e0a011-f56d-4208-b551-8c7a6611e6f1/scratchpad/runner-evidence-repo --runtime-path /opt/homebrew/bin/claude --exact-process-title  -- --model opus --effort high --permission-mode auto", "pane_title": "YLsdeMac-mini.local", "pane_width": 80, "platform_match": true, "present": true, "process_match": true, "relay_process_match": true, "repo_match": true, "tui_detected": true}, "later_output_barrier": null, "model": {"actual_parameters": null, "actual_runtime_model_id": null, "model_evidence_provenance": {"actual": {"frame_digest": "sha256:4cbf5a4d977a401c6e6a0183adc10287f81448b2e618f65a1dc289a860e05519", "model_id": null, "parameters": null, "source": "unreadable"}, "catalog_probe": {"available_models": ["fable", "opus", "plugins                        Manage Claude Code plugins", "session_id", "sonnet", "tokens>           Auto-compact window size (auto, or", "upgrade                        Check for updates and install if"], "probes": [{"command": ["claude", "--help"], "output_digest": "sha256:dd59344cc6bb66e7c7332503ced5e9b8a27403f2afb08bf07efd9d37a2c5c85b", "returncode": 0}], "state": "readable"}, "latest_observation": {"frame_digest": "sha256:4cbf5a4d977a401c6e6a0183adc10287f81448b2e618f65a1dc289a860e05519", "model_id": null, "parameters": null, "source": "unreadable"}, "requested": {"name": "Opus 5 High", "source": "runner-default"}, "resolution": {"candidate_id": "opus", "display_name": "Opus", "resolved_id": "opus", "state": "resolved", "supported_options": ["--effort"]}}, "model_mismatch_reason": "actual-model-evidence-unreadable", "model_verified": "unknown", "requested_model_name": "Opus 5 High", "requested_model_source": "runner-default", "resolved_parameters": {"effort": "high"}, "resolved_runtime_model_display": "Opus", "resolved_runtime_model_id": "opus"}, "native_approval": {"fingerprint": null, "kind": null, "state": "absent"}, "owned": true, "pane_command": "Python", "pane_count": 1, "pane_id": "%47", "pane_path": "/private/tmp/claude-501/-Volumes-WorkspaceA-ylminiserver-workspace-KaolaTasks/55e0a011-f56d-4208-b551-8c7a6611e6f1/scratchpad/runner-evidence-repo", "pane_pid": "57684", "pane_process": "/opt/homebrew/Cellar/python@3.14/3.14.3_1/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python /Volumes/WorkspaceA/ylminiserver/workspace/kaola-project-runner/scripts/kaola-pane-relay.py --tmux-bin /opt/homebrew/bin/tmux --session kt34-live-evidence --pane-id %47 --repo /private/tmp/claude-501/-Volumes-WorkspaceA-ylminiserver-workspace-KaolaTasks/55e0a011-f56d-4208-b551-8c7a6611e6f1/scratchpad/runner-evidence-repo --runtime-path /opt/homebrew/bin/claude --exact-process-title  -- --model opus --effort high --permission-mode auto", "pane_revision": "kpr-pane-v2:a9cf3ca6ab94270ffd2787ba10cdf44dfd7188d4581b7d07190f48c65be7e39e", "pane_title": "YLsdeMac-mini.local", "platform": "claude-code", "platform_match": true, "present": true, "process_match": true, "raw_current_frame": "e-id %47 --repo /private/tmp/claude-501/-Volumes-WorkspaceA-ylminiserver-workspace-KaolaTasks/55e0a011-f56d-4208-b551-8c7a6611e6f1/scratchpad/runner-evidence-repo --runtime-path /opt/homebrew/bin/claude --exact-process-title '' -- --model opus --effort high --permission-mode auto\n\n────────────────────────────────────────────────────────────────────────────────\n Accessing workspace:\n\n /private/tmp/claude-501/-Volumes-WorkspaceA-ylminiserver-workspace-KaolaTasks/\n 55e0a011-f56d-4208-b551-8c7a6611e6f1/scratchpad/runner-evidence-repo\n\n Quick safety check: Is this a project you created or one you trust? (Like your\n own code, a well-known open source project, or work from your team). If not,\n take a moment to review what's in this folder first.\n\n Claude Code'll be able to read, edit, and execute files here.\n\n Security guide\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel", "relay": {"bracketed_paste": true, "child_input_offset": 44, "child_output_digest": "sha256:4401587a3437885bc8add58f71158897aabd475cf4dd051f416a9b8a59a8b505", "child_output_offset": 1339, "child_pgid": 57751, "child_pid": 57751, "child_process": "/opt/homebrew/bin/claude --model opus --effort high --permission-mode auto", "child_process_match": true, "child_process_state": "Ss+", "child_runtime_path": "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe", "child_start_fingerprint": "sha256:de9f3884bf69b5a2bc2ce97ce1aa8ac1edded3800e73dcd8e7f99fb17f4bf4b7", "epoch": "d01c757e94ce76856c0a6efd5cf2c4d7", "lease_active": false, "managed": true, "peer_pid_verified": true, "pid": 57684, "process_group_running": true, "protocol_version": 1, "resize_revision": 1, "socket_mode": "0600", "socket_owner_uid": 501, "socket_path": "/var/folders/8s/y93yqng93xb4__nl4jlh_g9c0000gn/T/kpr-501/d01c757e94ce76856c0a6efd5cf2c4d7.sock", "start_fingerprint": "sha256:a7d729dfa03c9ad436e103f84c141a022885139235097cc4ba8b34605c3462d6", "state": "running", "terminal_fence": "decrqm-nonce-v1"}, "repo": "/private/tmp/claude-501/-Volumes-WorkspaceA-ylminiserver-workspace-KaolaTasks/55e0a011-f56d-4208-b551-8c7a6611e6f1/scratchpad/runner-evidence-repo", "repo_match": true, "result": "started", "runtime": "Claude Code", "runtime_session_id": "", "schema_version": 2, "session": "kt34-live-evidence", "snapshot_id": "kpr-snapshot-v2:32f2b3316445fe734ea2e73bba6f2590bcf3ab17d8a220d227839790eb92b93c", "structured_decision_marker": null, "tui_detected": true, "visible_agent_count": null, "visible_shell_count": null}

## 3. observe (post-start, at prompt)
result=observed; runtime reached its input prompt; git top-level owned by the caller, never cloned by Runner

## 4. send
result: sent
snapshot: 

## 5. observe (post-send) — the runtime answered the injected prompt
result: observed
KAOLA34OK present in frame: True
--- excerpt ---

 ▐▛███▛█   Claude Code v2.1.250
▝▜██████▀  Opus 5 with high effort · Claude Max
  ▝▝ ▝▝    /…/scratchpad/runner-evidence-repo


❯ Reply with exactly the single word: KAOLA34OK                                 

⏺ KAOLA34OK

✻ C

## 6. capture (text only — no screenshot surface exists)
──────────────────────────────────────────────────────────────────────
  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · r…
  Opus 5 | 3% used | /private/tmp/claude-501/-Volumes-WorkspaceA-ylminiserver…
  ⏵⏵ auto mode on (shift+tab to cycle)
                                                                           /rc

## 7. secret scan over the live Runner surfaces (BEFORE stop)
### tmux session environment (the surface kaola-tmux.sh:403-408 forwards into)
  token-shaped hits: 2
  total env entries: 30
### git config / remotes of the Runner-owned checkout
  token-shaped hits: 0
  remotes: 0 (zero means Runner never set one)
### captured frame text
  token-shaped hits: 0

## 8. stop
result: stopped
present after stop: None

## 9. Result

**The live acceptance item is SATISFIED.** One real runtime completed the full
start → observe → send → observe → stop cycle against the exact requested
`(repo, session)` pair, and nothing here is simulated:

- `preflight` → `"result": "ready"`, runtime `Claude Code 2.1.250`, binary `/opt/homebrew/bin/claude`.
- `start` → `"result": "started"`, `repo_match: true`, `platform_match: true`, `owned: true`.
- `observe` → runtime reached its input prompt.
- `send` → `"result": "sent"` with the text `Reply with exactly the single word: KAOLA34OK`.
- `observe` → the runtime's own answer `⏺ KAOLA34OK` is present in the frame.
- `capture` → returned frame TEXT (confirming first-hand that capture has no image surface).
- `stop` → `"result": "stopped"`; `tmux ls` afterwards shows zero `kt34` sessions.

Ordering was proven in practice as well as on paper: the checkout existed and was a git
top-level BEFORE `start`, and the Runner never created it — `git remote -v` on that repo
returns zero remotes after the whole cycle, i.e. the Runner set none.

## 10. Secret-scan finding (recorded honestly)

- **git config / git remote of the Runner-owned checkout: 0 token-shaped hits.**
- **Captured frame text (200 lines): 0 token-shaped hits.**
- **tmux session environment: 2 token-shaped hits — identified, and NOT a forge token.**
  Both are `CLAUDE_CODE_MESSAGING_TOKEN`, the controlling Claude Code harness's own IPC
  token, pulled in by the Runner's documented `CLAUDE_*|GROK_*|OPENCODE_*|KIMI_*|CURSOR_*|FAKE_*`
  environment forwarding (`kaola-tmux.sh:403-408`). This environment contains **no forge
  credential at all** — `env | grep -icE "ghp_|glpat-|GITLAB_TOKEN|GITEA_TOKEN"` returns `0` —
  so no forge token could have reached any Runner surface.

  The measured conclusion for #34: the Runner's env-forwarding glob is an inherited property of
  the external tool, and it is exactly why #34's rule is written as "never place a forge token in
  the Runner prompt, environment, frame, capture, transcript, or git remote". Kaola Tasks'
  obligation is to never put a forge credential into a variable matching that glob; the acceptance
  suite asserts that directly. Nothing in this run contradicts it.

## 11. Scope

The scratch repository used here was created for this evidence run under the session scratchpad
and is unrelated to any real Task. Neither `kaola-workflow` nor `kaola-project-runner` was
modified — both verified `git status --porcelain` clean.
