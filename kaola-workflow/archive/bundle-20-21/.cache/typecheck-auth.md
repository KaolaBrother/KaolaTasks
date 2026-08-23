TS2554 at auth.ts:251 was the local OAuth2Decorator (1-arg only), not a missing package API.
Installed @fastify/oauth2@8.3.0 types already declare (request, reply); no package upgrade.
Minimal fix: optional FastifyReply on OAuth2Decorator; 2-arg PKCE call kept.
Verified: `pnpm --filter @kaola/server typecheck` exit 0. Tests not edited, no commit.
auth.test.ts still excluded from tsc (tsconfig exclude); OAuth behavior unchanged.
