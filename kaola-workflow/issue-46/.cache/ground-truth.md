# Ground truth — issue #46

Measured 2026-09-01 from this Grok session. Commit `b6856e4` (`workflow/issue-46` worktree). Default TLS verification only (no `-k`, no `NODE_TLS_REJECT_UNAUTHORIZED`, no extra CA).

Real public host, HTTPS port, IP, certificate identity, and SSH/tunnel aliases are **not recorded here** (owner git-hygiene rule). Operators keep those in ignored local config.

## Live public HTTPS endpoint

Shape: `https://<public-host>:<https-port>/` (values not in git).

| Measurement | Command shape | Result | Exit |
|-------------|----------------|--------|------|
| Default curl | `curl -sS -v --max-time 20 https://<public-host>:<https-port>/` | `SSL certificate problem: self signed certificate`; handshake reached Certificate then closed | 60 |
| openssl s_client | `openssl s_client -connect <public-host>:<https-port> -servername <public-host> -showcerts` | `Verify return code: 18 (self-signed certificate)`; 1 PEM in handshake | 0 (connects; verify fails) |
| leaf identity | `openssl x509 -noout -subject -issuer -dates -ext subjectAltName -fingerprint -sha256` | subject = issuer; **no SAN** (`No extensions in certificate`); long-lived self-signed leaf | 0 |
| default `openssl verify` | `openssl verify <leaf.pem>` | `error 18 at 0 depth lookup: self-signed certificate` | 2 |
| Node default `fetch` | `fetch('https://<public-host>:<https-port>/')` | `DEPTH_ZERO_SELF_SIGNED_CERT` / `fetch failed` | 0 (caught) |

Environment: macOS curl with SecureTransport; OpenSSL 3.x; Node 24. Diagnostic `-k` / extra-CA paths were **not** used.

Inference: the failure boundary is public TLS trust. The leaf is self-signed, sends no intermediate chain, and has no SAN. Application-layer device proof was not re-probed because default TLS did not complete.

## Repository contract (HEAD `b6856e4` before this run's docs)

- `docs/DESIGN.md` §12: intranet + public entry; host reverse-proxy → `127.0.0.1:31415`; `PUBLIC_URL` may be `https://…`. Did **not** require a default-trusted full chain, SAN, ACME DNS-01, or two-mode debug/stable split.
- README 「生产向部署」: `PUBLIC_URL` HTTPS, overlay `X-Forwarded-Proto`, `kaola-mcp --url ${PUBLIC_URL}`. Did not mention certificate trust modes.
- `apps/mcp/src/main.ts` `performMcpRequest`: default `fetch` with no `rejectUnauthorized`, no `NODE_TLS_REJECT_UNAUTHORIZED`, no `--insecure`.
- `docker-compose.yml`: loopback `127.0.0.1:31415:31415` only. TLS terminator is outside compose.
- No nginx/Caddy/certbot file in the tree. No product TLS skip to fix in `kaola-mcp`.

Inference: the repository gap is the public-HTTPS trust **contract** (now two-mode). A new product test or nginx sample is not required: the bridge already uses default TLS, and compose is already loopback-only.

## Live-server access discovery (non-secret)

Inspected: `~/.ssh/config` Host/HostName/User/Port (names not recorded); `~/.ssh/known_hosts` first-field presence of the public host (absent); `~/.ssh` filenames; `ssh-add -l`; process env names matching KAOLA/PUBLIC_URL/DEPLOY/NGINX/CERTBOT/ACME; repo docs for public host / public HTTPS port / ACME.

| Fact | Observation |
|------|-------------|
| SSH Host aliases | one unrelated tunnel alias; HostName is not `<public-host>` |
| `known_hosts` | no `<public-host>`, no public A record |
| SSH key files in `~/.ssh` | none (only `config`, `known_hosts`, `authorized_keys`, `agent/`) |
| ssh-agent | `ssh-add -l` exit 1 (no identities) |
| env | no `KAOLA_*` / `PUBLIC_URL` / deploy-tool names; `SSH_AUTH_SOCK` present |
| repo docs | do not name the live host or an ACME deploy |

Not done: no SSH to unrelated aliases or the public host; no credential guessing; no access broadening.

**Blocker:** no authorized live-server access to `<public-host>` is discoverable. Live certificate replacement is not performed. HTTP-01 is also not viable (dynamic public name + no inbound port 80).
