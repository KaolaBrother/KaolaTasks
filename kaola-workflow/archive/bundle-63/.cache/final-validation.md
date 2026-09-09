verdict: pass
validation_command: PATH="/opt/homebrew/opt/openssl@3/bin:$PATH" openssl version && pnpm lint && pnpm typecheck && pnpm test && pnpm build && git diff --check origin/main...HEAD
validated_candidate_hash: 8f372d9609547b8349cc2451c50338dcc1f6736f7f13c88872c634eb54983552
