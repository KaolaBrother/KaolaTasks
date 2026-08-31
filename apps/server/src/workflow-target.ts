import type { TaskBrief } from '@kaola/shared'

// Issue #33 — pure mapping from a Task brief to the Kaola Workflow target the current Agent should
// use for the default direct-Workflow path. No I/O, no forge calls, no DB, no network: this module
// only reads the already-loaded TaskBrief and returns a plain, JSON-serializable description.
//
// Kaola Workflow issue-less-project support was measured read-only against the real repository
// (Kaola Workflow 10.2.1, commit 7e93763e): `cmdStartup` refuses with `no_target` when given no
// `--target-issue`/`--target-issues`, so a native Task's target is reported as an unavailable,
// advisory-only project rather than assumed to work or given a fabricated `issue-<N>` name.

const WORKFLOW_MEASURED_VERSION = '10.2.1'
const WORKFLOW_MEASURED_COMMIT = '7e93763e'
const WORKFLOW_NO_TARGET_REASON =
  "Kaola Workflow cmdStartup refuses with 'no_target' when given no --target-issue/--target-issues; " +
  'an issue-less project is not currently supported, so this Workflow target is advisory-unavailable ' +
  'rather than assumed.'

export type WorkflowAdvisory = {
  reason: string
  workflow_version: string
  workflow_commit: string
}

export type WorkflowTarget =
  | {
      target_kind: 'issue'
      available: true
      issue_url: string
      project_name: null
      advisory: null
    }
  | {
      target_kind: 'issueless_project'
      available: false
      issue_url: null
      project_name: string
      advisory: WorkflowAdvisory
    }

function issuelessProjectTarget(brief: TaskBrief): WorkflowTarget {
  return {
    target_kind: 'issueless_project',
    available: false,
    issue_url: null,
    project_name: brief.id,
    advisory: {
      reason: WORKFLOW_NO_TARGET_REASON,
      workflow_version: WORKFLOW_MEASURED_VERSION,
      workflow_commit: WORKFLOW_MEASURED_COMMIT,
    },
  }
}

export function workflowTargetForTask(brief: TaskBrief): WorkflowTarget {
  if (brief.source.type === 'imported' && brief.source.issue_url !== '') {
    return {
      target_kind: 'issue',
      available: true,
      issue_url: brief.source.issue_url,
      project_name: null,
      advisory: null,
    }
  }
  // Native Task, or an imported Task whose issue_url is missing/empty: Kaola Tasks never fabricates
  // a forge Issue, so both fall back to the measured issue-less-project advisory.
  return issuelessProjectTarget(brief)
}
