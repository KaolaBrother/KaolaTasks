# Live-server access — issue #46

Date: 2026-09-01. No credentials guessed. No private keys, tokens, secret values, public host, IP, or certificate identity recorded.

## Blocker

**No authorized live-server access to `<public-host>` is discoverable.** Live certificate replacement, reverse-proxy reload, and ACME issuance were not performed.

Also missing for any later live mutation: selected `<production-subdomain>` and `<acme-dns-provider>` details.

## What was inspected (non-secret)

- `~/.ssh/config`: one Host alias whose HostName is a third-party tunnel, not `<public-host>`. Not used.
- `~/.ssh/known_hosts` first fields: no `<public-host>`, no public A record.
- `~/.ssh` filenames: no private key files (`id_*` / `*.pem` absent).
- `ssh-add -l`: exit 1 (no agent identities).
- Process env names: no `KAOLA_*`, `PUBLIC_URL`, or deploy-tool variables.
- Repository docs / compose: no host inventory, no certbot/ACME operator identity, no SSH target for this endpoint.

## What was not done

- No SSH to tunnel aliases, LAN addresses, or `<public-host>`.
- No password / key guess.
- No `curl -k` as a product workaround.
- No certificate install, nginx reload, or ACME issuance on the live host.

## Residual live work (operator with existing access + chosen mode)

Not this session. Requires proven server authorization, and for `STABLE_PUBLIC_CA` also `<production-subdomain>` plus `<acme-dns-provider>`. Then: replace the CN-only self-signed leaf with the mode's cert (debug: root-signed leaf with SAN = `<public-host>`; stable: publicly trusted fullchain on `<https-port>` via DNS-01); keep rollback; test reverse-proxy config before reload; prove renewal. HTTP-01 / standalone webroot is not viable.
