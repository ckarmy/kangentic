# Task result artifact

The task overview's result action first reads the task's persisted report from
the project database. Reports survive archiving and worktree cleanup; deleting
the task removes its report through a foreign-key cascade. For compatibility,
when no persisted report exists it reads `kangentic-result.json` from the task
worktree, or its project directory when no worktree is used. It never executes
commands from that file. The task UUID must match; an unrelated report in a shared
checkout is rejected. The file is bounded to 64 KB and must not be a symbolic link.

An agent records a report with `kangentic_record_task_result`, passing the task
UUID, `expectedRevision`, and `report` as a JSON string. Obtain the revision from
`kangentic_get_current_task` or `kangentic_find_task` immediately before recording.
Stale revisions, missing/archived tasks and agent writes to held tasks are rejected.
Recording does not approve, advance, commit, push or deploy anything. Archived
reports remain readable without comparing them against another task's checkout.

Example schema (replace the task id and HEAD with actual values):

```json
{
  "version": 1,
  "taskId": "task-uuid",
  "summary": "What changed, or what the investigation established",
  "files": ["src/example.ts"],
  "checks": [
    {"command": "npm run test:example", "result": "passed", "evidence": "Actual result and log/artifact reference"}
  ],
  "head": "0000000000000000000000000000000000000000",
  "delivery": "Commit and push status, explicitly including anything not done",
  "deployment": "Not performed",
  "nextAction": "What the person must review or approve next"
}
```

Checks accept passed, failed, or not-run. Empty evidence is rejected, but a
syntactically valid report is still an agent declaration, not a verified fact.
The reader independently observes Git HEAD and worktree dirtiness. A matching
HEAD does not validate uncommitted changes, test claims, a push, or a deployment.
Missing and invalid results are visible, never treated as successful completion.

The routed completion tool requires a persisted result at the current task
revision before the final transition to Ready (direct, review or verification
routes). At least one documented check is required and failed checks refuse
advancement. A not-run check must explain its limitation; it is not upgraded to
passed. Earlier stage transitions and idempotent retries remain unchanged.
This checks report completeness, not the truth of agent claims. Human review
and observed Git state remain necessary. The mobile task menu and edit screen
offer Ver resultado, a read-only on-demand view using board-tool-read
get_task_result with an explicit owning project. Report schema and parser live
in @kangentic/protocol, shared with desktop. Older desktops return an error;
the phone keeps that error visible and offers refresh, never a fabricated result.
Coordinated runtime installation and device verification are still pending.

Native persistence smoke check: `node scripts/verify-task-closeout.mjs` uses
Electron's SQLite ABI and an in-memory database. It applies migrations twice,
checks save/read, retains results across archival and checks deletion cascade.
It never opens a user's project database.
