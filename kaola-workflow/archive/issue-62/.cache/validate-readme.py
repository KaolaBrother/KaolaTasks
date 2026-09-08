from pathlib import Path
import re
text = Path('README.md').read_text()
links = re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', text)
local = [x.split('#')[0] for x in links if not re.match(r'[a-z]+:', x) and x.split('#')[0]]
missing = [x for x in local if not Path(x).is_file()]
assert not missing, missing
assert len(re.findall(r'^\| `(?:list_tasks|get_task_brief|claim_task|report_progress|release_task|submit_pr|get_review_feedback|post_discussion_message|submit_revision|open_review_round)`', text, re.M)) == 10
assert 'head_verified: false' in text
assert 'source.issue_url' in text
print(f'PASS: {len(local)} local README link targets exist; ten MCP entries; reviewed mechanism markers present.')
