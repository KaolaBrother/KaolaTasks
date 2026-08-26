# Land the locked admin identity (#28) and #27's non-UX schema foundation

- item: Measure today's login, `users` schema, and permission gates against the locked #28 table (latest comment = body) and #27 本轮 schema list
  status: done
  dispatched: self; write kaola-workflow/bundle-27-28/.cache/ground-truth.md
  result: Current HEAD still empty-DB OAuth bootstrap + `full` as one gate for publish AND devices; no `local`/`admin`/`password_hash`. Recorded in `.cache/ground-truth.md`. End state of this run is #28 (not #27-alone).

- item: Rewrite DESIGN D6 / D8 / §3 / §11 to the #28 identity model before production code; #27 remaining hardening candidates stay out
  status: done
  dispatched: self; docs/DESIGN.md
  result: v0.3 — wizard local admin, GitLab/Gitea publishers, GitHub login gone, split 发布 vs 电脑 gates. Committed on cursor/bundle-27-28-7976.

- item: Author failing acceptance tests for setup, password login, promote, GitHub-login 404, publisher vs admin gates, password hashing, and `GET /api/v1/me` never leaking a hash
  status: done
  dispatched: tdd-guide; tests under apps/server/src and apps/web/src; RED log at kaola-workflow/bundle-27-28/.cache/tdd-red.log
  result: RED on 86354f1. Representative 404 setup, 302 github, missing password.ts. Tests committed.

- item: Implement the identity model so those tests pass without changing Task Brief, MCP tools, or the two token reveal channels
  status: done
  dispatched: implementer; production only
  result: GREEN identity oracle then full pnpm test after fixture repair (tdd-green.log). HEAD 6d90488 then later R1 + promote UI.

- item: Review correctness and security of password storage, session issuance, and the split between 发布 and 电脑 gates
  status: done
  dispatched: security-reviewer + code-reviewer; reports in kaola-workflow/bundle-27-28/.cache/
  result: First security review FAIL R1 (setup/login omit skipUntrusted). Re-review PASS after persistSession skipUntrusted + trusted-peer conjunct. Code review 0 blocking.

- item: Dock api.md, README closed-join, smoke-test, CHANGELOG, and CLAUDE.md Commands/snapshot to the new login; smoke must start with setup
  status: done
  dispatched: doc-updater
  result: a226c24 plus later skipUntrusted + 升级入口 docking (9338fed).

- item: Fix R1 untrusted-peer session cookies on setup/login and add admin 升级入口
  status: done
  dispatched: tdd-guide + implementer
  result: auth-cookie untrusted tests GREEN; App.devices promote widget GREEN. Browser: wizard → 管理员; 电脑页升级 张伟 full → admin.
