# Issue #19 — 三家 forge「列出 open Issues」官方事实

Source: [knowledge-lookup](ad4a5eca-65e0-4006-89b7-3c2b58a460b2). Retrieval date: 2026-08-23.

## Pinned fetch URLs

| kind | GET URL |
| --- | --- |
| github | `https://api.github.com/repos/OWNER/REPO/issues?state=open&per_page=50&sort=created&direction=desc` |
| gitlab | `{BASE}/api/v4/projects/{urlencoded NAMESPACE}/issues?state=opened&per_page=50&order_by=created_at&sort=desc` |
| gitea | `{BASE}/api/v1/repos/OWNER/REPO/issues?state=open&type=issues&limit=50` |

- GitHub `state=open` (not `opened`); `per_page` max 100; no official exclude-PR query — drop items with `pull_request` key.
- GitLab `state=opened` (not `open`); omit state = all states; map **`iid`** not `id`; never return `web_url`.
- Gitea `limit=50` not `per_page`; `type=issues` required or PRs mix in; no sort query (server SortByCreatedDesc); default MAX_RESPONSE_ITEMS=50.

Auth unchanged: GitHub Bearer + User-Agent KaolaTasks + Accept application/vnd.github+json; GitLab PRIVATE-TOKEN; Gitea `Authorization: token`.

Response: top-level JSON array for all three.

`issue_url` constructed from `repo.base_url`:
- GH/Gitea `{base_url}/{full_name}/issues/{number}`
- GitLab `{base_url}/{namespace}/-/issues/{iid}`

Throw `listIssues: ${kind} responded ${status}`.

Fixtures:
- GitHub must include a `pull_request` object item that is dropped; `html_url` host must be wrong so copying it fails.
- GitLab must have `id` ≠ `iid` and `web_url` with `/-/work_items/` so copying web_url or using id fails.
- Gitea pin `type=issues`; misleading `id`/`html_url`.

Sources (2026-08-23):
- https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28#list-repository-issues
- https://docs.gitlab.com/18.6/api/issues/
- https://docs.gitlab.com/api/rest/
- https://docs.gitea.com/api/1.25/operations/issue-list-issues/
- https://docs.gitea.com/development/api-usage/
- https://github.com/go-gitea/gitea/blob/v1.27.2/routers/api/v1/repo/issue.go
