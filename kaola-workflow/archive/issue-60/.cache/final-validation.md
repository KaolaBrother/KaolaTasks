verdict: pass
validation_command: pnpm lint; pnpm typecheck; pnpm build; node --experimental-strip-types --test apps/server/src/auth.test.ts apps/server/src/auth-cookie.test.ts; git diff --check
validated_candidate_hash: c1cfb1856b026bb97ee20c71f357a3e6c8861758e3e7f482887f5a227613b01b
