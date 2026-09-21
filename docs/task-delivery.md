# Human-confirmed task delivery

The all-project task overview exposes **Preparar entrega** on Ready cards.
Preparation is read-only and does not invoke an LLM. It requires an isolated task
worktree, a non-base branch, a persisted closeout report with documented checks
and no failed checks, and matching HEAD. `not-run` checks remain visibly declared
as such: a preview does not turn them into passing checks.

The preview shows the exact changed files declared by the closeout, other changed
files that will be excluded, the branch, HEAD, and an editable commit message.
Paths outside the worktree, symlinks, and oversized files are rejected.

## Local commit

The user checks the explicit authorization box and presses **Crear commit local**.
The desktop revalidates card revision and the content fingerprint under the task
lifecycle lock. Any running or queued task session prevents the commit. File
selection comes from the server-side report, not an arbitrary renderer path list.

Git stages only the selected paths and uses `commit --only` to exclude unrelated
staged work. Existing repository hooks still run; this is not a sandbox for
untrusted repositories. The result verifies the new parent, branch, and committed
path scope. There is no amend, reset, force operation, automatic retry, push, or
deployment in this action.

If Git fails or times out, the approval is consumed and the UI warns that a commit
or staged changes may already exist. Inspect Git before trying again. Nothing is
automatically rolled back, and existing work is never discarded.

## Push confirmation

**Preparar push** shows the current commit, task branch, and the single resolved
origin push destination. It performs no network write. A separate checkbox and
**Confirmar push** authorize that exact snapshot. HEAD, branch or URL changes
invalidate the fingerprint. Held cards and running/queued task sessions block
the write. Main/base branches, multiple push URLs and embedded HTTP credentials
are rejected.

The command pushes the approved SHA to the same named task branch, without
force, mirror, following tags or recursive submodule pushes. It then reads the
remote ref to verify the SHA. An error consumes the UI approval and reports an
uncertain result, without automatic retries. Server hooks and CI may be triggered
by a push; the user must review the destination repository's policy.

## Current limitations

A durable operation ledger now wraps desktop commit and push, and is being integrated for the mobile path. It reserves
an operation before calling Git and reuses the recorded result for duplicate
requests, even if a reconnect creates a new transport request ID. A running row
owned by a previous desktop process is reported as uncertain. No timeout or app
restart causes an automatic retry. The read-only mobile status command requires
both explicit project and task identity. Mobile mutation buttons are not yet
enabled: reconciliation and operation UI must be wired before enabling them.
Read-only preflight rejection creates no operation row. A completed duplicate is
returned before preflight, so a successful commit remains recoverable after HEAD
has changed. A genuine uncertain attempt blocks new task deliveries until its
result is reconciled; it is never automatically treated as safe to repeat.

- This implementation is not yet installed in the daily desktop instance.
- Mobile delivery actions and installed end-to-end validation are still pending.
- Checks are agent-declared evidence, not independently rerun by this button.
- External programs editing a worktree are not coordinated by the task lock.
- Successful local commit changes HEAD; a subsequent closeout needs refreshed
  evidence rather than treating the old report as current.
