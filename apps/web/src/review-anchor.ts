// 代码锚点解析（#53）。
//
// 评审者在「代码锚点」里粘贴一条 forge 的文件链接，前端把它解析成 `{ path, line, head_sha, url }`
// 再随讨论消息发出去。考拉自己不渲染 diff，所以这里只认三家 forge 已经写进 docs/api.md 的
// 单文件链接形态；GitHub 的 PR diff 锚点（`…/pull/N/files#diff-…R42`）带不出 path，落到只留 url
// 的兜底分支。
//
// 三种可解析形态（`<path>` 可以含 `/`）：
//   GitHub  https://host/<owner>/<repo>/blob/<sha>/<path>#L42
//   GitLab  https://host/<group…>/<project>/-/blob/<sha>/<path>#L42
//   Gitea   https://host/<owner>/<repo>/src/commit/<sha>/<path>#L42

export type ParsedAnchor = {
  path?: string
  line?: number
  head_sha?: string
  url: string
}

const LINE_HASH_PATTERN = /^#L(\d+)/

function parseLine(hash: string): number | undefined {
  const matched = LINE_HASH_PATTERN.exec(hash)
  if (matched == null) return undefined
  const line = Number.parseInt(matched[1], 10)
  if (!Number.isSafeInteger(line) || line <= 0) return undefined
  return line
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

// Index of the `<sha>` segment, or -1 when the path is not one of the three known shapes.
// GitLab is probed before GitHub because `/-/blob/` also contains a bare `blob` segment.
function shaIndex(segments: string[]): number {
  for (let i = 0; i + 2 < segments.length; i += 1) {
    if (segments[i] === '-' && segments[i + 1] === 'blob') return i + 2
    if (segments[i] === 'src' && segments[i + 1] === 'commit') return i + 2
  }
  for (let i = 0; i + 1 < segments.length; i += 1) {
    if (segments[i] === 'blob') return i + 1
  }
  return -1
}

export function parseAnchorLink(url: string): ParsedAnchor {
  const raw = url.trim()
  const fallback: ParsedAnchor = { url: raw }
  if (raw === '') return fallback

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return fallback
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback

  const segments = parsed.pathname.split('/').filter((segment) => segment !== '')
  const index = shaIndex(segments)
  if (index < 0 || index + 1 >= segments.length) return fallback

  const headSha = decodeSegment(segments[index])
  const path = segments
    .slice(index + 1)
    .map(decodeSegment)
    .join('/')
  if (headSha === '' || path === '') return fallback

  const anchor: ParsedAnchor = { url: raw, path, head_sha: headSha }
  const line = parseLine(parsed.hash)
  if (line != null) anchor.line = line
  return anchor
}
