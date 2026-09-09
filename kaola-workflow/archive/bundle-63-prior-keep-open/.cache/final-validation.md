verdict: pass
validation_command: pnpm lint && pnpm typecheck && PATH=/opt/homebrew/opt/openssl@3/bin:$PATH pnpm test && pnpm build && git diff --check
validated_candidate_hash: 18b8d38d5f48083c1e7acca630764935b5232a2760445eedd4baa890b806ba52
