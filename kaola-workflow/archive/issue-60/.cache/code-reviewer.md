candidate: 8b49640ece7c7967bd47817d4f336b2edc712cc3
surface: apps/server/src/auth.ts, apps/server/src/auth.test.ts, docs/DESIGN.md, docs/api.md, docs/smoke-test.md

Reviewed the complete five-file candidate diff against base 6ba97d6. The checked-out HEAD matches the dispatched candidate. No candidate-caused defect met the admission threshold.

Traced the two HTML forms through Fastify plugin registration, scoped content-type parsing, preValidation Origin rejection, existing setup uniqueness and password validation, session persistence, redirects, and GET /api/v1/me. Checked the unchanged Vue JSON callers, public-user serialization, session cookie and trusted-proxy handling, relevant identity tests, and auth test helpers. The parser remains confined to setup/login; successful form requests select 303 while JSON retains its previous response. Foreign and null Origins are rejected before user insertion or login. Missing Origin remains allowed as explicitly documented.

The four new tests cover encoded special characters, established sessions after 303, one-time setup, failed login, cross-origin rejection without users or cookies, and parser isolation. Existing identity tests cover JSON statuses, malformed fields, concurrent setup, and secret exclusion; cookie tests cover HTTPS and untrusted peers. No expensive suite was rerun during this review. The dispatch supplies auth/cookie 25/25 and Linux Node 1053/1053 evidence; the existing Linux final regression log independently confirms 1053 passing Node tests and the initial Web 165/166 failure. The dispatch supplies subsequent unchanged-file 11/11 and full Web 166/166 passes plus two successful PR checks.

The Web task-message failure is an existing, separately tracked observation under issue #61, not an admitted defect of this candidate. The smoke-test additions preserve the initial failure and later passes, distinguish VPS from local Linux and browser evidence, and retain Windows/public-CA and unexecuted fault-scenario limitations. Historical UAT is reported evidence, not a newly executed review check or an invented earlier Workflow dispatch.

verdict: pass
findings_blocking: 0
review_conclusion: The complete dispatched candidate has no admitted correctness or regression defects; its scoped form handling and documented acceptance boundaries are consistent with the reviewed code and supplied evidence.
