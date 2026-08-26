# RED: skipUntrusted on POST /setup and POST /login

baseline: `a226c24746f7c16b95106f4b7a4035c066cd4558`

command: `node --experimental-strip-types --test apps/server/src/auth-cookie.test.ts`  
cwd: `/workspace/.kw/worktrees/bundle-27-28`

tests: 7, pass 5, fail 2 (expected)

Existing GitLab untrusted-peer case still passes. Loopback `POST /api/v1/setup` with `PUBLIC_URL=https` still asserts Secure `sessionId`. Production `auth.ts` was not edited.

## Failure signatures

RED: setup from untrusted public peer does not Set-Cookie sessionId — AssertionError: untrusted public peer must not receive sessionId Set-Cookie: sessionId=…; Path=/; HttpOnly; Secure; SameSite=Lax — true !== false

RED: login from untrusted public peer does not Set-Cookie sessionId — AssertionError: untrusted public peer must not receive sessionId Set-Cookie: sessionId=…; Path=/; HttpOnly; Secure; SameSite=Lax — true !== false
