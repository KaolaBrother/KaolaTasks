# Identifier redaction — issue #46

Owner rule: real domain names, server/host names, public HTTPS ports, IPs, deployment URLs, DNS provider identifiers, and certificate identity/details must not be in git.

This file lists **locations** that previously held those values. It does **not** repeat the values.

## Removed from tracked files (unpushed commit `34577f2` and working copies)

| Path | Kind removed |
|------|----------------|
| `kaola-workflow/issue-46/mission-list.md` item 1 | public host + public HTTPS port in live URL |
| `kaola-workflow/issue-46/mission-list.md` item 4 result | public host + public IP |
| `kaola-workflow/issue-46/.cache/ground-truth.md` | public host, public HTTPS port, public IP, leaf CN, SHA-256 fingerprint, notBefore/notAfter, SSH/tunnel Host alias, tunnel hostname, tunnel port, LAN IP |
| `kaola-workflow/issue-46/.cache/live-access.md` | same classes as ground-truth |

Product docs (`docs/DESIGN.md`, README, architecture, api, smoke-test, CHANGELOG, `.env.example`) in that commit used generic `https://…` and product port `31415` only; they did not name the live host. They are still rewritten for the two-mode contract.

## Also scrubbed in untracked main-root copies

| Path | Kind |
|------|------|
| `/Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-46/mission-list.md` | same as tracked |
| `/Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-46/.cache/ground-truth.md` | same as tracked |
| `/Users/ylpromax5/Workspace/KaolaTasks/kaola-workflow/issue-46/.cache/live-access.md` | same as tracked |

## Not in git (and not added)

- `.env` / operator config: still the only place real `PUBLIC_URL` / host / port / DNS provider may live (gitignored).
- `.env.example`: remains empty placeholders; no real host or port.
- No nginx/certbot/deploy script added.
