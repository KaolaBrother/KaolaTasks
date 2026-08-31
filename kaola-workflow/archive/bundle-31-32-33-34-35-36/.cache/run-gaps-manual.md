# Hand-written run gaps for bundle-31-32-33-34-35-36

gap: deferred-hardening — forge adapter has zero fetch timeouts (0 AbortSignal, 0 timeout, 2 fetch call sites at bc8b01f); explicitly named a non-goal by both #36 and #31 as a separate small hardening.
gap: deferred-hardening — submitPr still awaits attemptWriteback on the response path while claimTask no longer does, so a hung forge has no bounded effect on the submit response.
gap: external-capability — Kaola Workflow 10.2.1 / 7e93763e refuses issue-less projects with no_target, so native Tasks get an advisory-unavailable Workflow target and have no direct Workflow execution path.
gap: unexecuted-acceptance — live-provider smoke for GitLab, Gitea and GitHub was not executed: no GITLAB_TOKEN or GITEA_TOKEN and no .env exists in this environment, and scripts/forge-smoke.ts exits for github by design.
gap: untested-edge — an imported task with a missing or empty source.issue_url falls back to the advisory issueless_project variant; the behavior is deliberate and conservative but no test pins it.
gap: test-shaped-production — the #36 claim CAS UPDATE issues through the outer db handle rather than tx so the race test's monkey-patch can observe it; still inside the transaction and independently proven atomic by three failure-injection tests, but production shape accommodating a stub seam.
