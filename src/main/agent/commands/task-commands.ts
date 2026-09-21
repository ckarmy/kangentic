import fs from 'node:fs';
import { TaskRepository } from '../../db/repositories/task-repository';
import { TaskCloseoutRepository } from '../../db/repositories/task-closeout-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { BacklogAttachmentRepository } from '../../db/repositories/backlog-attachment-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { readFileAsAttachment } from '../../db/repositories/attachment-utils';
import { resolveColumn } from './column-resolver';
import { resolveTask } from './task-resolver';
import {
  clampSlot,
  computeIdsWithTaskAtSlot,
  computeReorderedIds,
  resolveRawPosition,
} from './task-ordering';
import { handleCreateBacklogTask, BACKLOG_DESCRIPTION_MAX_LENGTH } from './backlog-commands';
import { resolveProfileSelector } from './profile-commands';
import { linkPRForTask } from '../../pr/pr-linking';
import { prNumberFromUrl } from '../../../shared/pr-url';
import { WorktreeManager } from '../../git/worktree-manager';
import { isGitRepo } from '../../git/git-checks';
import { isSafeBranchName } from '../../git/push-command';
import type { CommandContext, CommandHandler, CommandResponse } from './types';
import type { Task, TaskUpdateInput, PermissionMode, TaskRunMode } from '../../../shared/types';

export const TASK_DESCRIPTION_MAX_LENGTH = 50_000;
const DRAFT_PREPARATION_BLOCK_RE = /<!-- kangentic-draft:v1 source=[a-f0-9]{64} -->\r?\n[\s\S]*?\r?\n<!-- \/kangentic-draft -->/gi;

function mergeDraftPreparationBlock(current: string, block: string): DescriptionEditResult {
  const trimmed = block.trim();
  const matches = current.match(DRAFT_PREPARATION_BLOCK_RE) ?? [];
  DRAFT_PREPARATION_BLOCK_RE.lastIndex = 0;
  if (!/^<!-- kangentic-draft:v1 source=[a-f0-9]{64} -->\r?\n## Preparación Kangentic\r?\n/i.test(trimmed)
      || !trimmed.endsWith('<!-- /kangentic-draft -->')
      || (trimmed.match(/<!-- kangentic-draft:v1 source=/gi) ?? []).length !== 1
      || (trimmed.match(/<!-- \/kangentic-draft -->/gi) ?? []).length !== 1) {
    return { success: false, error: 'block must be exactly one Kangentic Draft preparation block' };
  }
  const next = matches.length === 0
    ? `${current}${current.trim() ? '\n\n' : ''}${trimmed}`
    : matches.length === 1 ? current.replace(matches[0], trimmed) : '';
  if (matches.length > 1) return { success: false, error: 'Draft contains more than one preparation block' };
  if (next.length > TASK_DESCRIPTION_MAX_LENGTH) {
    return { success: false, error: `Resulting description would exceed ${TASK_DESCRIPTION_MAX_LENGTH} characters` };
  }
  return { success: true, text: next };
}

function stripDraftPreparationBlocks(description: string): string {
  DRAFT_PREPARATION_BLOCK_RE.lastIndex = 0;
  const stripped = description.replace(DRAFT_PREPARATION_BLOCK_RE, '').trimEnd();
  DRAFT_PREPARATION_BLOCK_RE.lastIndex = 0;
  return stripped;
}

function preserveDraftPreparationBlock(baseDescription: string, currentDescription: string): string {
  DRAFT_PREPARATION_BLOCK_RE.lastIndex = 0;
  const matches = currentDescription.match(DRAFT_PREPARATION_BLOCK_RE) ?? [];
  DRAFT_PREPARATION_BLOCK_RE.lastIndex = 0;
  return matches.length === 1
    ? `${baseDescription}${baseDescription.trim() ? '\n\n' : ''}${matches[0]}`
    : baseDescription;
}

export interface DescriptionEdit {
  find: string;
  replace: string;
}

export type DescriptionEditResult =
  | { success: true; text: string }
  | { success: false; error: string };

/**
 * Render a `find` value for an error message without echoing a huge string
 * back to the caller (which would defeat the token-saving point of the edit
 * modes). Long values are truncated with their full length reported.
 */
function describeFindValue(find: string): string {
  const maxEchoLength = 200;
  if (find.length <= maxEchoLength) return JSON.stringify(find);
  return `${JSON.stringify(find.slice(0, maxEchoLength))} (truncated, ${find.length} chars total)`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Apply Edit-tool-style exact-string replacements to a description, then an
 * optional append, mirroring the file Edit tool's failure semantics: a `find`
 * that is absent or not unique fails the whole call rather than a silent
 * no-op or partial write. Edits apply sequentially against the evolving text.
 */
export function computeUpdatedDescription(
  current: string,
  options: { edits?: DescriptionEdit[] | null; append?: string | null },
): DescriptionEditResult {
  let text = current;
  const edits = options.edits ?? [];
  for (let index = 0; index < edits.length; index += 1) {
    const { find, replace } = edits[index];
    const occurrences = countOccurrences(text, find);
    if (occurrences === 0) {
      return { success: false, error: `descriptionEdits[${index}]: text to find was not present in the description: ${describeFindValue(find)}` };
    }
    if (occurrences > 1) {
      return { success: false, error: `descriptionEdits[${index}]: text to find appears ${occurrences} times in the description; it must be unique: ${describeFindValue(find)}` };
    }
    text = text.split(find).join(replace);
  }
  if (options.append) {
    text = text + options.append;
  }
  if (text.length > TASK_DESCRIPTION_MAX_LENGTH) {
    return { success: false, error: `Resulting description would be ${text.length} characters, over the ${TASK_DESCRIPTION_MAX_LENGTH} character limit.` };
  }
  return { success: true, text };
}

/**
 * The PR number a PR URL names, or null when the URL carries none.
 *
 * `pr_url` and `pr_number` must always name the SAME PR: the linker writes the
 * three PR columns atomically, and Tier 1 of the confidence ladder treats
 * `pr_number` as authoritative. A caller naturally passes `prUrl` alone (the URL
 * already encodes the number), which would otherwise leave the OLD number in the
 * row - the next non-force resolve then resolves that stale number and silently
 * overwrites the URL back to the previous PR. Deriving it here keeps the two in
 * agreement, and mirrors `buildPrFields` in the task-detail edit form, which
 * derives the number from the URL through the same shared helper.
 *
 * The implementation lives in `src/shared/pr-url.ts` so this and the renderer's
 * `buildPrFields` cannot drift apart: they used to carry separate `/pull/(\d+)`
 * regexes, which silently produced a null number for every Azure DevOps
 * `/pullrequest/<id>` URL.
 */

/**
 * Resolve a just-written PR link so its state lands immediately, instead of
 * waiting for the background sweep or the next auto-link trigger (both non-force,
 * so both are subject to the 60s per-task throttle - exactly the window a
 * PR-creating flow lands in). Without this, `create_task` / `update_task` leave
 * `pr_state` null and the board card shows a bare PR pill with no state chip.
 *
 * Fire-and-forget: `linkPRForTask` takes the task lock itself, and its `onLinked`
 * routes through `context.onTaskPrLinkChanged`, which pushes TASK_PR_LINK_CHANGED
 * and a board-changed event (see `mcp-project-context.ts`), so the card repaints
 * without the tool call awaiting a `gh` round-trip. `preserveLinkOnNotFound`
 * because a resolve fired BY a link write must never undo that write; an
 * explicit `link_pr` deliberately does not set it.
 *
 * The QUIET channel, not `onTaskUpdated`: this resolve exists only because the
 * caller just wrote a link, and that write already toasted. Routing it through
 * the loud channel meant one `update_task` produced two "Task updated by agent"
 * toasts, the second announcing a state the first had just cleared.
 */
function scheduleLinkTimeResolve(
  taskId: string,
  taskRepo: TaskRepository,
  context: CommandContext,
): void {
  void linkPRForTask(taskId, {
    tasks: taskRepo,
    projectPath: context.getProjectPath(),
    defaultBaseBranch: context.getDefaultBaseBranch?.(),
    resolveOptions: context.getPrResolveOptions?.(),
    force: true,
    preserveLinkOnNotFound: true,
    onLinked: (linked) => context.onTaskPrLinkChanged?.(linked),
  }).catch((error) => {
    console.error(`[pr-linking] link-time resolve failed for task ${taskId.slice(0, 8)}:`, error);
  });
}

/**
 * Refuse a create whose `branchName` git already has checked out somewhere,
 * returning the refusal message, or null when the branch is free.
 *
 * Git allows a branch in only ONE working tree at a time, so a task naming a
 * held branch can never build its worktree: `ensureTaskWorktree` throws, and
 * because `onTaskCreated` fires auto-spawn fire-and-forget the tool response has
 * already been sent by then. What is left is a card with a null session and a
 * null worktree, indistinguishable from a healthy one (task #538).
 *
 * This is the only point that can still tell the CALLER, which for an MCP create
 * is usually an agent in another project that will never see a desktop toast.
 * So the message has to be self-contained: what is wrong, WHERE the branch is
 * held, that nothing was created, and - because the holder is typically the
 * user's own checkout, which the calling agent cannot touch - an explicit
 * terminal state rather than a retry that would just loop.
 *
 * Two things it deliberately never suggests: dropping `branchName` (the caller
 * named that branch because the commits are on it, so an auto-generated name
 * would build a worktree disconnected from the work), and `useWorktree: false`
 * (which this same guard rejects, so it is a guaranteed loop).
 *
 * Fails OPEN. A probe that throws (git missing, corrupt repo) must never block a
 * create it cannot reason about.
 */
async function describeBranchConflict(
  projectPath: string,
  branchName: string,
): Promise<string | null> {
  if (!isGitRepo(projectPath)) return null;

  let holdingPath: string | null;
  try {
    holdingPath = await new WorktreeManager(projectPath).findWorktreeHoldingBranch(branchName);
  } catch (error) {
    console.warn(`[create_task] Could not check whether branch "${branchName}" is in use:`, error);
    return null;
  }
  if (!holdingPath) return null;

  return `Cannot create this task: branch '${branchName}' is already checked out at ${holdingPath}. `
    + `Git allows a branch in only one working tree at a time, so this task's worktree could not be `
    + `created and its agent would never start. No task was created. Retrying this same call will `
    + `fail identically: if you can free that branch, check out a different branch in ${holdingPath} `
    + `and re-run, otherwise stop and tell the user that ${holdingPath} is holding '${branchName}' `
    + `and has to move off it before this task can run. Use a different branchName only if this `
    + `task's work is not actually on that branch.`;
}

export const handleCreateTask: CommandHandler = async (
  params: Record<string, unknown>,
  context: CommandContext,
) => {
  const title = String(params.title ?? '').slice(0, 200);
  const description = stripDraftPreparationBlocks(String(params.description ?? ''))
    .slice(0, TASK_DESCRIPTION_MAX_LENGTH);
  const columnName = params.column as string | null;
  const branchName = params.branchName as string | null;
  const baseBranch = params.baseBranch as string | null;
  const useWorktree = params.useWorktree as boolean | null;
  const attachments = params.attachments as Array<{ filePath: string; filename?: string }> | null;
  const priority = params.priority as number | null;
  const rawLabels = params.labels as Array<string | { name: string; color?: string }> | null;
  const agentOverride = params.agentOverride as string | null;
  const modelOverride = params.modelOverride as string | null;
  const effortOverride = params.effortOverride as string | null;
  const permissionMode = params.permissionMode as PermissionMode | null;
  const autoCommand = params.autoCommand as string | null;
  const profileSelector = params.profile as string | null;
  const runMode = params.runMode as TaskRunMode | null;
  // Normalized to null so an omitted key reads the same as the explicit `null`
  // the MCP tool layer forwards - a direct handler call passes neither.
  const prUrl = (params.prUrl as string | null | undefined) ?? null;
  const prNumber = (params.prNumber as number | null | undefined) ?? null;

  // Observability for the "labels dropped on a large description" bug
  // (task #229). Logs what `labels` actually reached the handler. If it is
  // null/absent here while the description is large, the drop is upstream of
  // Kangentic (the MCP client never sent it). The decisive raw-byte capture
  // lives in mcp-http-server.ts.
  console.log('[create_task] received args:', {
    descriptionLength: description.length,
    labels: rawLabels,
  });

  if (!title.trim()) {
    return { success: false, error: 'Task title is required' };
  }

  // Backlog routing: column="Backlog" (case-insensitive) creates a backlog
  // item instead of a board task. The default (no column) always goes to the
  // To Do column on the active board, never the backlog.
  if (columnName && columnName.trim().toLowerCase() === 'backlog') {
    // The create_task Zod cap (TASK_DESCRIPTION_MAX_LENGTH) covers board tasks;
    // backlog items keep the lower BACKLOG_DESCRIPTION_MAX_LENGTH. Enforce it
    // here so an over-cap backlog description fails loudly rather than being
    // silently truncated by handleCreateBacklogTask's slice.
    const backlogDescriptionLength = String(params.description ?? '').length;
    if (backlogDescriptionLength > BACKLOG_DESCRIPTION_MAX_LENGTH) {
      return {
        success: false,
        error: `Backlog item description is ${backlogDescriptionLength} characters, over the ${BACKLOG_DESCRIPTION_MAX_LENGTH} character limit for backlog items (board tasks allow up to ${TASK_DESCRIPTION_MAX_LENGTH}).`,
      };
    }
    return handleCreateBacklogTask({ ...params, priority: priority ?? 0 }, context);
  }

  // Normalize labels: extract names for DB storage and colors for config
  const labelNames: string[] = [];
  const labelColorMap: Record<string, string> = {};
  if (rawLabels) {
    for (const entry of rawLabels) {
      if (typeof entry === 'string') {
        labelNames.push(entry);
      } else if (entry && typeof entry === 'object' && entry.name) {
        labelNames.push(entry.name);
        if (entry.color) {
          labelColorMap[entry.name] = entry.color;
        }
      }
    }
  }
  if (labelNames.some((label) => label.trim().toLowerCase() === 'approved')) {
    return { success: false, error: 'Agents may not grant the approved label; human action is required' };
  }

  if (priority !== null && priority !== undefined && (priority < 0 || priority > 4)) {
    return { success: false, error: 'Priority must be 0-4 (0=none, 1=low, 2=medium, 3=high, 4=urgent)' };
  }

  // Resolved BEFORE the row is written: a typoed profile name must fail the
  // create outright rather than leave a task silently running Default.
  let profileId: string | null = null;
  if (profileSelector) {
    const resolvedProfile = resolveProfileSelector(context, profileSelector);
    if (!resolvedProfile.ok) return { success: false, error: resolvedProfile.error };
    profileId = resolvedProfile.profileId;
  }

  // Same slot, same reason as the profile check above: refuse BEFORE the row is
  // written, so a branch that can never build a worktree leaves no task behind.
  //
  // NOT gated on the destination column's `auto_spawn`. The conflict bites the
  // moment the task reaches any spawning column, so one unconditional rule is
  // both simpler and correct for a task filed into a quiet column today and
  // dragged into a spawning one tomorrow. Runs after the Backlog early-return
  // above, which ignores `branchName` entirely.
  if (branchName) {
    const conflict = await describeBranchConflict(context.getProjectPath(), branchName);
    if (conflict) return { success: false, error: conflict };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);

  const resolution = resolveColumn(db, columnName, 'todo', {
    refuseDone: 'a task cannot be created there',
  });
  if ('error' in resolution) {
    return { success: false, error: resolution.error };
  }
  const { swimlane: targetSwimlane } = resolution;
  const isQuietDraft = targetSwimlane.name === 'Draft' && targetSwimlane.auto_spawn === false;
  if (targetSwimlane.role !== 'todo' && !isQuietDraft) {
    return {
      success: false,
      error: 'Agents may create board tasks only in Draft or To Do; the router is the only automatic entry to active columns',
    };
  }

  const task = taskRepo.create({
    title,
    description,
    swimlane_id: targetSwimlane.id,
    ...(baseBranch ? { baseBranch } : {}),
    ...(useWorktree !== null ? { useWorktree } : {}),
    ...(branchName ? { customBranchName: branchName } : {}),
    ...(labelNames.length > 0 ? { labels: labelNames } : {}),
    ...(priority !== null && priority !== undefined ? { priority } : {}),
    ...(agentOverride ? { agent_override: agentOverride } : {}),
    ...(modelOverride ? { model_override: modelOverride } : {}),
    ...(effortOverride ? { effort_override: effortOverride } : {}),
    ...(permissionMode ? { permission_mode: permissionMode } : {}),
    ...(autoCommand ? { auto_command: autoCommand } : {}),
    ...(profileId ? { profile_id: profileId } : {}),
    ...(runMode ? { run_mode: runMode } : {}),
  });

  // A review task names the PR it is about up front, so the linker's pr_number
  // tier resolves it (a PR URL in the DESCRIPTION is deliberately not an anchor -
  // see the ladder comment in pr-linking.ts). Applied as a follow-up update
  // rather than through TaskCreateInput on purpose: `TaskRepository.create`
  // always writes the three PR columns null, and keeping that invariant means
  // the create path has exactly one shape. pr_state stays null here and the
  // link-time resolve fired after `onTaskCreated` below fills it in.
  let createdTask = task;
  let linksPR = false;
  if (prUrl !== null || prNumber !== null) {
    // An explicit prNumber wins; otherwise derive it from the URL, so a caller
    // passing prUrl alone still lands on Tier 1 instead of producing a row that
    // shows a PR badge but has no anchor to ever resolve it.
    const linkedPrNumber = prNumber !== null ? Number(prNumber) : prNumberFromUrl(String(prUrl));
    createdTask = taskRepo.update({
      id: task.id,
      ...(prUrl !== null ? { pr_url: String(prUrl) } : {}),
      ...(linkedPrNumber !== null ? { pr_number: linkedPrNumber } : {}),
    });
    linksPR = (prUrl !== null && String(prUrl).trim() !== '') || Number.isFinite(linkedPrNumber);
  }

  // Persist label colors to config if any were provided
  if (Object.keys(labelColorMap).length > 0) {
    context.onLabelColorsChanged(labelColorMap);
  }

  // Process file attachments if provided
  if (attachments && attachments.length > 0) {
    const attachmentRepo = new AttachmentRepository(db);
    const projectPath = context.getProjectPath();
    for (const entry of attachments) {
      try {
        const fileData = readFileAsAttachment(entry.filePath, entry.filename);
        attachmentRepo.add(projectPath, task.id, fileData.filename, fileData.base64Data, fileData.mediaType);
      } catch (error) {
        console.error(`[create_task] Failed to attach file "${entry.filePath}":`, error);
      }
    }
  }

  context.onTaskCreated(createdTask, targetSwimlane.name, targetSwimlane.id);

  // After `onTaskCreated`, not inside the PR block above: `onTaskCreated` kicks
  // `autoSpawnForTask`, which takes the same per-task lock the resolve does, so
  // resolving first would park the spawn behind a `gh` round-trip.
  if (linksPR) scheduleLinkTimeResolve(createdTask.id, taskRepo, context);

  return {
    success: true,
    data: { taskId: createdTask.id, displayId: createdTask.display_id, title: createdTask.title, column: targetSwimlane.name },
    message: `Created task "${createdTask.title}" in ${targetSwimlane.name} column (#${createdTask.display_id}, id: ${createdTask.id})`,
  };
};

export const handleUpdateTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const taskId = params.taskId as string;
  // The MCP schema normally supplies explicit nulls, while the mobile bridge
  // sends a sparse patch. Normalize both shapes here so an omitted numeric
  // field never becomes Number(undefined) -> NaN -> SQLite NULL.
  const newTitle = (params.title as string | null | undefined) ?? null;
  const newDescription = (params.description as string | null | undefined) ?? null;
  const newDescriptionEdits = (params.descriptionEdits ?? null) as DescriptionEdit[] | null;
  const newAppendDescription = (params.appendDescription ?? null) as string | null;
  // Normalized to null so an omitted key reads the same as the explicit `null`
  // the MCP tool layer forwards, matching handleCreateTask. Without it a caller
  // that passes neither key (a direct handler call, or a mobile-bridge payload
  // that omits them) writes the literal string 'undefined' into pr_url and NaN
  // into pr_number, since `undefined !== null` passes the gates below.
  const newPrUrl = (params.prUrl as string | null | undefined) ?? null;
  const newPrNumber = (params.prNumber as number | null | undefined) ?? null;
  const newAgent = (params.agent as string | null | undefined) ?? null;
  const newPriority = (params.priority as number | null | undefined) ?? null;
  const newLabels = (params.labels as string[] | null | undefined) ?? null;
  const newBaseBranch = (params.baseBranch as string | null | undefined) ?? null;
  const newUseWorktree = (params.useWorktree as boolean | null | undefined) ?? null;
  const newModel = params.model as string | null | undefined;
  const newEffort = params.effort as string | null | undefined;
  const newPermissionMode = params.permissionMode as PermissionMode | null | undefined;
  const newProfileSelector = params.profile as string | null | undefined;
  const newRunMode = params.runMode as TaskRunMode | undefined;
  const newAttachments = (params.attachments as Array<{ filePath: string; filename?: string }> | null | undefined) ?? null;

  // Observability for the "labels dropped on a large description" bug
  // (task #229). See the matching note in handleCreateTask.
  console.log('[update_task] received args:', {
    descriptionLength: typeof newDescription === 'string' ? newDescription.length : null,
    descriptionEditsCount: newDescriptionEdits?.length ?? null,
    appendLength: typeof newAppendDescription === 'string' ? newAppendDescription.length : null,
    labels: newLabels,
  });

  if (!taskId) {
    return { success: false, error: 'taskId is required' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const task = resolveTask(taskRepo, taskId);
  if (!task) {
    return { success: false, error: `Task "${taskId}" not found` };
  }

  if (task.external_source === 'trello_draft') {
    return { success: false, error: 'Agents may not edit a Trello Draft mirror; promote it by human UI action first' };
  }

  const currentGuardLabels = (task.labels ?? []).map((label) => label.trim().toLowerCase());
  const isHumanAction = context.actor === 'human';
  if (!isHumanAction
      && routerGuarded(currentGuardLabels, `${task.title}\n${task.description}`)) {
    return { success: false, error: 'Agents may not mutate a held or sensitive task; human action is required' };
  }
  if (!isHumanAction && newLabels !== null) {
    const requestedLabels = newLabels.map((label) => label.trim().toLowerCase());
    if (!currentGuardLabels.includes('approved') && requestedLabels.includes('approved')) {
      return { success: false, error: 'Agents may not grant the approved label; human action is required' };
    }
    if (!currentGuardLabels.includes(HUMAN_GO_LABEL) && requestedLabels.includes(HUMAN_GO_LABEL)) {
      return { success: false, error: 'Agents may not grant the go-ck label; only CK recorded GO sets it' };
    }
  }

  const updates: Record<string, unknown> = { id: task.id };
  if (newTitle !== null) updates.title = String(newTitle).slice(0, 200);

  // `description` (full replace) is mutually exclusive with `descriptionEdits`
  // / `appendDescription`; the tool layer (task-tools.ts) rejects the two
  // together, so this if/else never sees both from the MCP path.
  let descriptionChanged = false;
  if (newDescription !== null) {
    updates.description = String(newDescription).slice(0, TASK_DESCRIPTION_MAX_LENGTH);
    descriptionChanged = true;
  } else if (newDescriptionEdits !== null || newAppendDescription !== null) {
    const editResult = computeUpdatedDescription(task.description, {
      edits: newDescriptionEdits,
      append: newAppendDescription,
    });
    if (!editResult.success) {
      return { success: false, error: editResult.error };
    }
    // Only treat this as a change when the text actually moved. An empty
    // `appendDescription` or a no-op edit (e.g. find === replace) otherwise
    // triggers a spurious DB write, an updated_at bump, and a misleading
    // "description" in changedFields.
    if (editResult.text !== task.description) {
      updates.description = editResult.text;
      descriptionChanged = true;
    }
  }

  if (newPrUrl !== null) updates.pr_url = String(newPrUrl);
  // An explicit prNumber wins; otherwise derive it from the URL. Writing the URL
  // alone would leave the OLD number behind, and the next resolve would take that
  // stale number as authoritative and revert the URL to the previous PR.
  if (newPrNumber !== null) updates.pr_number = Number(newPrNumber);
  else if (newPrUrl !== null) updates.pr_number = prNumberFromUrl(String(newPrUrl));
  // Re-pointing the link invalidates any state carried over from the old PR. The
  // four PR fields must always agree (the linker writes them atomically), and a
  // stale terminal `merged`/`closed` would otherwise short-circuit every
  // non-force resolve, freezing the task on a PR it no longer points at. The
  // link-time resolve scheduled below refills them.
  //
  // Unless the write re-points nothing. A `/pull-request` flow routinely writes
  // the link a sweep or auto-link already discovered, and nulling `pr_state`
  // there blanked the card's PR chip until a forced `gh` round-trip put back the
  // value it just cleared. `prLinkUnchanged` must PROVE equality rather than
  // infer it from an omitted field: a `prNumber`-only write naming a DIFFERENT
  // PR leaves `updates.pr_url` unset, and treating absent as "matches" would
  // keep the old PR's state and skip the resolve - worse than the churn. So it
  // requires both fields present and equal, plus a state actually worth
  // preserving (a link with a null state, e.g. from a `preserveLinkOnNotFound`,
  // still needs its resolve).
  const effectivePrNumber = updates.pr_number;
  const prLinkUnchanged =
    typeof updates.pr_url === 'string'
    && updates.pr_url === task.pr_url
    && typeof effectivePrNumber === 'number'
    && effectivePrNumber === task.pr_number
    && task.pr_state != null;
  if ((newPrUrl !== null || newPrNumber !== null) && !prLinkUnchanged) {
    updates.pr_state = null;
    updates.pr_merge_readiness = null;
  }
  if (newAgent !== null) updates.agent = newAgent;
  if (newPriority !== null) updates.priority = Number(newPriority);
  if (newLabels !== null) updates.labels = newLabels;
  if (newBaseBranch !== null) updates.base_branch = newBaseBranch;
  if (newUseWorktree !== null) updates.use_worktree = newUseWorktree ? 1 : 0;
  // model/effort/permissionMode distinguish "not provided" (undefined - leave
  // untouched) from "explicitly cleared" (null, from an empty-string param at
  // the tool layer) from "set" (a concrete value) - unlike the sibling fields
  // above, which collapse "omitted" and "clear" onto the same null sentinel.
  if (newModel !== undefined) updates.model_override = newModel;
  if (newEffort !== undefined) updates.effort_override = newEffort;
  if (newPermissionMode !== undefined) updates.permission_mode = newPermissionMode;
  // Same tri-state, plus a name-to-id resolution. An unknown name fails the
  // whole update rather than clearing the task's profile, which is what `null`
  // would otherwise mean here.
  if (newProfileSelector !== undefined) {
    if (newProfileSelector === null) {
      updates.profile_id = null;
    } else {
      const resolvedProfile = resolveProfileSelector(context, newProfileSelector);
      if (!resolvedProfile.ok) return { success: false, error: resolvedProfile.error };
      updates.profile_id = resolvedProfile.profileId;
    }
  }
  // No "clear" state: the mode is one of two values, so omitted simply means
  // "leave it alone". A pin or profile in this same write still implies a mode
  // via applyProfileExclusivity.
  if (newRunMode !== undefined) updates.run_mode = newRunMode;

  const hasScalarChange = Object.keys(updates).length > 1;
  let updated = hasScalarChange ? taskRepo.update(updates as unknown as TaskUpdateInput) : task;

  // Attach files if provided (additive - existing attachments are untouched).
  let attachmentsAdded = 0;
  if (newAttachments && newAttachments.length > 0) {
    const attachmentRepo = new AttachmentRepository(db);
    const projectPath = context.getProjectPath();
    for (const entry of newAttachments) {
      try {
        const fileData = readFileAsAttachment(entry.filePath, entry.filename);
        attachmentRepo.add(projectPath, task.id, fileData.filename, fileData.base64Data, fileData.mediaType);
        attachmentsAdded += 1;
      } catch (error) {
        console.error(`[update_task] Failed to attach file "${entry.filePath}":`, error);
      }
    }
    // Re-fetch so the response and onTaskUpdated carry the fresh derived attachment_count.
    updated = taskRepo.getById(task.id) ?? updated;
  }

  // If nothing actually changed (no scalar field set, and every requested
  // attachment failed to read), surface a structured failure instead of a
  // misleading success with an empty "Updated  for ..." message. Mirrors the
  // equivalent guard in handleUpdateBacklogItem. Reachable only via attachments,
  // since the tool layer forwards attachments past its "at least one field"
  // gate while attachments contribute to changedFields only when one succeeds.
  if (!hasScalarChange && attachmentsAdded === 0) {
    const attachmentsRequested = newAttachments?.length ?? 0;
    return attachmentsRequested > 0
      ? { success: false, error: `Failed to attach any of the ${attachmentsRequested} requested file(s); no other fields were updated.` }
      : { success: false, error: 'No fields provided to update' };
  }

  context.onTaskUpdated(updated);

  // Gated on what THIS call wrote, not on the post-write row: `updated` falls
  // back to the untouched task when nothing scalar changed, so reading its
  // fields would make a title-only edit on an already-linked task re-resolve.
  // The trim also rejects an empty prUrl, which the `!== null` gate above lets
  // through, and `isFinite` rejects the NaN a non-numeric `prNumber` produces
  // (the mobile bridge hands raw wire params to the handler, unlike the MCP
  // tool layer, whose zod schema has already validated a positive int).
  //
  // `prLinkUnchanged` also skips it: the row already holds this exact link AND a
  // non-null state, so there is nothing for a forced `gh` round-trip to refill.
  const linkedUrl = typeof updates.pr_url === 'string' ? updates.pr_url.trim() : '';
  if (!prLinkUnchanged && (linkedUrl !== '' || Number.isFinite(updates.pr_number))) {
    scheduleLinkTimeResolve(updated.id, taskRepo, context);
  }

  const changedFields: string[] = [];
  if (newTitle !== null) changedFields.push('title');
  if (descriptionChanged) changedFields.push('description');
  if (newPrUrl !== null) changedFields.push('prUrl');
  if (newPrNumber !== null) changedFields.push('prNumber');
  if (newAgent !== null) changedFields.push('agent');
  if (newPriority !== null) changedFields.push('priority');
  if (newLabels !== null) changedFields.push('labels');
  if (newBaseBranch !== null) changedFields.push('baseBranch');
  if (newUseWorktree !== null) changedFields.push('useWorktree');
  if (newModel !== undefined) changedFields.push('model');
  if (newEffort !== undefined) changedFields.push('effort');
  if (newPermissionMode !== undefined) changedFields.push('permissionMode');
  if (newProfileSelector !== undefined) changedFields.push('profile');
  if (newRunMode !== undefined) changedFields.push('runMode');
  if (attachmentsAdded > 0) changedFields.push('attachments');

  return {
    success: true,
    message: `Updated ${changedFields.join(', ')} for "${updated.title}".`,
    data: {
      id: updated.id,
      displayId: updated.display_id,
      title: updated.title,
      description: updated.description,
      prUrl: updated.pr_url,
      prNumber: updated.pr_number,
      agent: updated.agent,
      priority: updated.priority,
      labels: updated.labels,
      baseBranch: updated.base_branch,
      useWorktree: updated.use_worktree,
      modelOverride: updated.model_override,
      effortOverride: updated.effort_override,
      permissionMode: updated.permission_mode,
      profileId: updated.profile_id,
      // Reported like its exclusivity siblings above: a pin or a profile in
      // this write can flip the mode without the caller naming it, so the
      // resulting mode has to be visible in the response.
      runMode: updated.run_mode,
      ...(newAttachments !== null ? { attachmentCount: updated.attachment_count, attachmentsAdded } : {}),
    },
  };
};

/**
 * Idempotent, atomic ingress for the read-only Trello Draft mirror.
 *
 * This deliberately is not a generic external-task upsert. Its source and
 * label are fixed server-side, it can only touch the quiet Draft column, and a
 * task becomes permanently detached the first time the server observes it
 * outside Draft. The transaction closes the find/update race that would let a
 * periodic sync overwrite work after a human promoted it.
 */
export const handleSyncExternalDraft: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const externalId = String(params.externalId ?? '').trim();
  const externalUrl = String(params.externalUrl ?? '').trim();
  const title = String(params.title ?? '').trim().slice(0, 200);
  const description = String(params.description ?? '').slice(0, TASK_DESCRIPTION_MAX_LENGTH);
  if (!externalId || !externalUrl || !title) {
    return { success: false, error: 'externalId, externalUrl, and title are required' };
  }

  const db = context.getProjectDb();
  const draftResolution = resolveColumn(db, 'Draft', 'todo', { includeArchivedDone: false });
  if ('error' in draftResolution || draftResolution.swimlane.name !== 'Draft'
      || draftResolution.swimlane.auto_spawn !== false) {
    return { success: false, error: 'A quiet Draft column with autoSpawn=false is required' };
  }
  const draftId = draftResolution.swimlane.id;
  const repo = new TaskRepository(db);
  type SyncAction = 'created' | 'updated' | 'unchanged' | 'detached';
  let notifyTask: Task | undefined;

  const outcome = db.transaction((): { action: SyncAction; task: Task } => {
    const lookup = () => {
      const row = db.prepare(`SELECT id FROM tasks
        WHERE external_id = ? AND external_source IN ('trello_draft', 'trello_draft_detached')
        ORDER BY created_at ASC LIMIT 1`).get(externalId) as { id: string } | undefined;
      return row ? repo.getById(row.id) : undefined;
    };

    let task = lookup();
    if (task) {
      const detached = task.external_source === 'trello_draft_detached'
        || task.archived_at !== null || task.swimlane_id !== draftId;
      if (detached) {
        if (task.external_source !== 'trello_draft_detached') {
          db.prepare(`UPDATE tasks SET external_source = 'trello_draft_detached', updated_at = ?
            WHERE id = ?`).run(new Date().toISOString(), task.id);
          task = repo.getById(task.id) ?? task;
        }
        return { action: 'detached', task };
      }

      const labels = Array.from(new Set([...task.labels, 'trello']));
      const syncedDescription = preserveDraftPreparationBlock(description, task.description);
      const unchanged = task.title === title && task.description === syncedDescription
        && task.external_url === externalUrl
        && JSON.stringify(task.labels) === JSON.stringify(labels);
      if (unchanged) return { action: 'unchanged', task };

      // The lane/source predicates are defense in depth around the transaction:
      // this write can never land on a task already detached by another path.
      const changed = db.prepare(`UPDATE tasks
        SET title = ?, description = ?, labels = ?, external_url = ?, updated_at = ?
        WHERE id = ? AND swimlane_id = ? AND external_source = 'trello_draft' AND archived_at IS NULL`)
        .run(title, syncedDescription, JSON.stringify(labels), externalUrl, new Date().toISOString(), task.id, draftId);
      if (changed.changes !== 1) throw new Error('Draft changed before external sync commit');
      task = repo.getById(task.id) ?? task;
      notifyTask = task;
      return { action: 'updated', task };
    }

    const created = repo.create({
      title,
      description,
      swimlane_id: draftId,
      labels: ['trello'],
      priority: 0,
      externalId,
      externalSource: 'trello_draft',
      externalUrl,
      // Omit useWorktree: Draft is inert, and when promoted the task must
      // inherit the project's isolation setting instead of pinning false.
    });
    notifyTask = created;
    return { action: 'created', task: created };
  })();

  if (outcome.action === 'created') context.onTaskCreated(outcome.task, 'Draft', draftId);
  else if (notifyTask) context.onTaskUpdated(notifyTask);
  return {
    success: true,
    data: { action: outcome.action, taskId: outcome.task.id, revision: outcome.task.revision },
    message: JSON.stringify({ action: outcome.action, taskId: outcome.task.id, revision: outcome.task.revision }),
  };
};

/**
 * Narrow, quiet write used by the trusted local pre-router.
 *
 * It can only append or replace the machine-owned preparation block of an
 * unchanged task in an inert Draft column. It cannot alter labels, priority,
 * project, column, session, worktree, or any other user-controlled field.
 */
export const handlePrepareDraft: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const taskId = String(params.taskId ?? '').trim();
  const expectedRevision = Number(params.expectedRevision);
  const block = String(params.block ?? '');
  if (!taskId || !Number.isInteger(expectedRevision) || expectedRevision < 0 || !block) {
    return { success: false, error: 'taskId, expectedRevision, and block are required' };
  }
  if (block.length > 8_000) return { success: false, error: 'Preparation block is too large' };

  const db = context.getProjectDb();
  const draftResolution = resolveColumn(db, 'Draft', 'todo', { includeArchivedDone: false });
  if ('error' in draftResolution || draftResolution.swimlane.name !== 'Draft'
      || draftResolution.swimlane.auto_spawn !== false) {
    return { success: false, error: 'A quiet Draft column with autoSpawn=false is required' };
  }
  const repo = new TaskRepository(db);
  let updated: Task | undefined;
  const outcome = db.transaction((): CommandResponse => {
    const task = resolveTask(repo, taskId);
    if (!task || task.archived_at !== null) return { success: false, error: `Task "${taskId}" not found` };
    if (task.swimlane_id !== draftResolution.swimlane.id) {
      return { success: false, error: 'Task is no longer in Draft' };
    }
    if (task.revision !== expectedRevision) {
      return { success: false, error: `Task revision changed (expected ${expectedRevision}, found ${task.revision})` };
    }
    if (task.session_id || task.worktree_path || task.pending_dispatch_id) {
      return { success: false, error: 'Draft preparation refuses tasks with execution state' };
    }
    const merged = mergeDraftPreparationBlock(task.description, block);
    if (!merged.success) return merged;
    if (merged.text === task.description) {
      return { success: true, data: { action: 'unchanged', taskId: task.id, revision: task.revision } };
    }
    const changed = db.prepare(`UPDATE tasks SET description = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND swimlane_id = ? AND archived_at IS NULL`)
      .run(merged.text, new Date().toISOString(), task.id, expectedRevision, draftResolution.swimlane.id);
    if (changed.changes !== 1) return { success: false, error: 'Draft changed before preparation commit' };
    updated = repo.getById(task.id);
    if (!updated) return { success: false, error: 'Prepared Draft disappeared after commit' };
    return { success: true, data: { action: 'prepared', taskId: updated.id, revision: updated.revision } };
  })();
  if (outcome.success && updated) {
    if (context.onTaskPrepared) context.onTaskPrepared(updated);
    else context.onTaskUpdated(updated);
  }
  return outcome;
};

/**
 * The anchors the ladder searched for a task, for a not-found message that
 * reads differently from "nothing to search by".
 */
function describeSearchedAnchors(task: Task): string {
  const anchors: string[] = [];
  if (task.pr_number != null) anchors.push(`PR #${task.pr_number}`);
  if (task.worktree_path) anchors.push('its worktree branch');
  else if (task.branch_name) anchors.push(`branch "${task.branch_name}"`);
  if (task.pushed_branch) anchors.push(`pushed branch "${task.pushed_branch}"`);
  if (task.head_sha) anchors.push(`commit ${task.head_sha.slice(0, 7)}`);
  return anchors.join(', ');
}

/**
 * Authoritatively resolve and link the PR for a task via the confidence ladder
 * (PR number -> worktree branch -> commit SHA -> stored branch -> pushed
 * branch -> remote tip). Works without a live session, picks up human/web-UI-
 * created PRs the scraper misses, and refreshes the linked PR's state
 * (open/draft/merged/closed) and merge readiness on re-run.
 *
 * `branch` (optional) is the remote branch the work was pushed to. It is
 * recorded as the task's `pushed_branch` before the ladder runs, which is how
 * an agent anchors a task that has no worktree and nothing else recorded.
 */
export const handleLinkPr: CommandHandler = async (
  params: Record<string, unknown>,
  context: CommandContext,
): Promise<CommandResponse> => {
  const taskId = params.taskId as string;
  if (!taskId) {
    return { success: false, error: 'taskId is required' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  let task = resolveTask(taskRepo, taskId);
  if (!task) {
    return { success: false, error: `Task "${taskId}" not found` };
  }

  const branch = typeof params.branch === 'string' ? params.branch.trim() : '';
  if (params.branch != null && params.branch !== '' && !isSafeBranchName(branch)) {
    return {
      success: false,
      error: `branch ${JSON.stringify(params.branch)} is not a valid git branch name. Pass the remote branch the work was pushed to, for example "feature/my-change".`,
    };
  }
  // Refused for the same name the automatic capture refuses, and for the same
  // reason: a merge-back's `git push origin HEAD:develop` would otherwise make
  // Tier 5 answer with the base branch's own PR. A refusal rather than a silent
  // skip, because the caller named this branch explicitly and can correct it.
  const effectiveBase = task.base_branch || task.resolved_base_branch || context.getDefaultBaseBranch?.();
  if (branch && branch === effectiveBase) {
    return {
      success: false,
      error: `branch "${branch}" is this task's base branch, not a PR source branch. Pass the branch the work was pushed to, or omit branch to resolve from what is already recorded.`,
    };
  }
  if (branch && branch !== task.branch_name && branch !== task.pushed_branch) {
    task = taskRepo.update({ id: task.id, pushed_branch: branch });
  }

  let result;
  try {
    result = await linkPRForTask(task.id, {
      tasks: taskRepo,
      projectPath: context.getProjectPath(),
      defaultBaseBranch: context.getDefaultBaseBranch?.(),
      resolveOptions: context.getPrResolveOptions?.(),
      force: true,
      onLinked: (linked) => context.onTaskUpdated(linked),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `PR resolution failed: ${message}` };
  }

  const linkedTask = result.task;
  // Same suffix shape as the linker's own log line, so the two stay in step.
  const readinessNote = linkedTask?.pr_merge_readiness ? `, merge ${linkedTask.pr_merge_readiness}` : '';
  switch (result.status) {
    case 'linked':
    case 'unchanged':
      return {
        success: true,
        message: `PR #${linkedTask?.pr_number} (${linkedTask?.pr_state ?? 'open'}${readinessNote}) linked to "${task.title}".`,
        data: {
          id: linkedTask?.id,
          displayId: linkedTask?.display_id,
          prUrl: linkedTask?.pr_url,
          prNumber: linkedTask?.pr_number,
          prState: linkedTask?.pr_state,
          prMergeReadiness: linkedTask?.pr_merge_readiness,
        },
      };
    case 'resolver-unavailable':
      return { success: false, error: result.message ?? 'No PR resolver available for this repository' };
    case 'transient-error':
      return { success: false, error: result.message ?? 'Temporary error while resolving the PR - try again.' };
    case 'no-anchor':
      // A refusal, not a pass: nothing was searched. `isError` lets the agent
      // self-correct instead of reading "linked: false" as "no PR exists".
      return {
        success: false,
        error: `"${task.title}" has nothing recorded to search by: no pull request number, worktree, branch, commit, or pushed branch. Pass branch (the remote branch the work was pushed to) to kangentic_link_pr, or set prUrl or prNumber with kangentic_update_task, then call kangentic_link_pr again.`,
      };
    case 'not-found':
    default: {
      const searched = describeSearchedAnchors(linkedTask ?? task);
      return {
        success: true,
        message: `No PR found for "${task.title}"${searched ? ` (searched by ${searched})` : ''}.`,
        data: { id: task.id, linked: false },
      };
    }
  }
};

/**
 * Parse the optional `position` argument shared by `move_task`. Returns null
 * when omitted, so the caller keeps its existing append placement, and mirrors
 * `handleCreateColumn`'s rejection wording for a bad value.
 */
function parseSlotParam(value: unknown): { slot: number } | { error: string } | null {
  if (value === undefined || value === null) return null;
  // Not `Number(value)`: that coerces '', [], and '   ' to 0 and `true` to 1,
  // so a junk argument would silently become a real slot instead of an error.
  // The MCP schema already guarantees a number here, but the dev-only devtools
  // proxy forwards raw JSON straight into `commandHandlers` and does not.
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return {
      error: `Invalid position "${String(value)}". Provide a whole number >= 0, or omit it to place the task at the end of the column.`,
    };
  }
  return { slot: value };
}

export const handleMoveTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const taskIdParam = params.taskId as string | null;
  const columnName = params.column as string | null;

  if (!taskIdParam) {
    return { success: false, error: 'taskId is required' };
  }
  if (!columnName) {
    return { success: false, error: 'column is required' };
  }

  const parsedSlot = parseSlotParam(params.position);
  if (parsedSlot && 'error' in parsedSlot) {
    return { success: false, error: parsedSlot.error };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const task = resolveTask(taskRepo, taskIdParam);
  if (!task) {
    return { success: false, error: `Task "${taskIdParam}" not found` };
  }

  const resolution = resolveColumn(db, columnName, 'todo', { includeArchivedDone: true });
  if ('error' in resolution) {
    return { success: false, error: resolution.error };
  }
  const { swimlane: targetSwimlane } = resolution;

  if (task.swimlane_id === targetSwimlane.id) {
    // Already here, and no slot named: the long-standing no-op.
    if (!parsedSlot) {
      return {
        success: true,
        message: `Task "${task.title}" is already in ${targetSwimlane.name}.`,
        data: { id: task.id, displayId: task.display_id, column: targetSwimlane.name },
      };
    }

    // Already here WITH a slot: a reposition, and deliberately not routed
    // through `onTaskMove`. `handleTaskMove` aborts any in-flight move for this
    // task before it takes the lock, so an agent nudging a card inside To Do
    // would kill a user's concurrent cross-column drag of that same card along
    // with the spawn it was about to run. Nothing is lost by bypassing it:
    // `handleTaskMove` returns for a same-lane move before every one of its
    // lifecycle branches, so a within-column drag already spawns nothing,
    // suspends nothing, and runs no transition action. Only the WRITE differs,
    // and deliberately - `handleTaskMove` reaches `move()`, a sparse two-shift
    // update, where this path does a dense, gap-healing, position-only rewrite.
    const laneIds = taskRepo.list(targetSwimlane.id).map((laneTask) => laneTask.id);
    // An ARCHIVED task still reports the column it was archived from, and Done
    // resolves by name via includeArchivedDone - but `list()` filters archived
    // rows out, so the task has no slot to take. Reject instead of renumbering
    // the live cards around a card that is not on the board and then reporting a
    // position it does not have.
    if (!laneIds.includes(task.id)) {
      return {
        success: false,
        error: `Task "${task.title}" (#${task.display_id}) is archived, so it has no position in ${targetSwimlane.name}.`,
      };
    }
    // Slot is evaluated against the column WITHOUT this task, so the last legal
    // slot is one less than the column's length.
    const slot = clampSlot(parsedSlot.slot, laneIds.length - 1);
    const orderedIds = computeIdsWithTaskAtSlot(laneIds, task.id, slot);
    taskRepo.reorderWithinSwimlane(targetSwimlane.id, orderedIds);
    context.onTasksReordered(targetSwimlane, orderedIds);

    return {
      success: true,
      message: `Moved "${task.title}" (#${task.display_id}) to position ${slot} of ${targetSwimlane.name}.`,
      data: { id: task.id, displayId: task.display_id, column: targetSwimlane.name, position: slot },
    };
  }

  const sourceSwimlane = new SwimlaneRepository(db).getById(task.swimlane_id);
  if (sourceSwimlane?.name === 'Draft') {
    return {
      success: false,
      error: 'Agents may not move tasks out of Draft; a human must provide GO in the board UI',
    };
  }

  // General agent-driven moves must not bypass the router's authorization
  // surface. UI drag/drop does not use this command handler, so a human can
  // still approve/finish work explicitly in the app.
  if (targetSwimlane.role === 'done' || targetSwimlane.name === 'Done') {
    return { success: false, error: 'Agents may not move tasks to Done; human approval is required' };
  }
  const normalizedLabels = (task.labels ?? []).map((label) => label.trim().toLowerCase());
  if (routerGuarded(normalizedLabels, `${task.title}\n${task.description}`)) {
    return { success: false, error: 'Server guard refused an agent move for held or sensitive work' };
  }

  // Cross-column movement remains available to the unscoped administrative
  // MCP endpoint. Running task sessions do not receive this tool at all (see
  // registerTaskTools), so they must use complete_route_stage and cannot pick
  // their own next stage.
  const targetTasks = taskRepo.list(targetSwimlane.id);
  const slot = parsedSlot ? clampSlot(parsedSlot.slot, targetTasks.length) : targetTasks.length;
  const targetPosition = resolveRawPosition(
    targetTasks.map((laneTask) => laneTask.position),
    slot,
    taskRepo.nextPositionInSwimlane(targetSwimlane.id),
  );
  void context.onTaskMove({
    taskId: task.id,
    targetSwimlaneId: targetSwimlane.id,
    targetPosition,
  }).catch((error) => {
    console.error(`[move_task] Failed for task ${task.id.slice(0, 8)}:`, error);
  });
  const placement = parsedSlot ? ` at position ${slot}` : '';
  return {
    success: true,
    message: `Moving "${task.title}" (#${task.display_id}) to ${targetSwimlane.name}${placement}.`,
    data: { id: task.id, displayId: task.display_id, column: targetSwimlane.name, position: slot },
  };
};

const ROUTER_SENSITIVE = /\b(prod(?:uction)?|producci[oó]n|main|deploy|secret|credential|migrat(?:e|ion)|drop|delete data|borrar datos|terraform destroy)\b/i;
const ROUTER_NEGATED_SENSITIVE_CLAUSE = /\b(?:sin|no)\s+(?:(?![.!;\n]).){0,100}\b(?:prod(?:uction)?|producci[oó]n|main|deploy|secret(?:s|os)?|credential(?:s|es)?|migrat(?:e|ion)|drop|delete data|borrar datos|terraform destroy)\b/gi;
const ROUTER_NO_PRODUCTION_FIELD = /^\s*Requiere\s+producci[oó]n\s*:\s*no\s*$/gim;
const ROUTER_NEGATED_SENSITIVE_TOKEN = /\bno[-_](?:prod(?:uction)?|deploy|secret(?:s)?|credential(?:s)?|migration)\b/gi;

export function routerTextSensitive(text: string): boolean {
  const actionableText = text
    .replace(ROUTER_NO_PRODUCTION_FIELD, '')
    .replace(ROUTER_NEGATED_SENSITIVE_TOKEN, '')
    .replace(ROUTER_NEGATED_SENSITIVE_CLAUSE, '');
  return ROUTER_SENSITIVE.test(actionableText);
}
const ROUTER_HOLD_LABELS = new Set([
  'pedro', 'no-auto', 'manual-hold', 'production', 'prod-deploy',
  // Set atomically by kangentic_request_human_input. Both labels are holds so
  // neither the routed completion tool nor native plan-exit can advance work
  // while a material human answer is outstanding.
  'needs-info', 'needs-human',
]);
// `risky` no longer holds (0.41.0-luuk.26): like the external router, it only
// raises the review path. Deletion by an agent still refuses it.
const DELETE_GUARD_LABELS = new Set([...ROUTER_HOLD_LABELS, 'risky']);

/**
 * `go-ck` is CK's recorded GO (kangentic_record_human_go, admin transport only).
 * It lifts the production hold (label or declared deliverable) and Pedro's
 * origin hold for that card, but never a pending question or a manual pause,
 * and never deletion.
 */
export const HUMAN_GO_LABEL = 'go-ck';
const ROUTER_GO_LIFTS = new Set(['production', 'prod-deploy', 'pedro']);

// A PROD deliverable is declared, not guessed from words (same rule as the
// router's isProductionDeliverable): the `Requiere producción: sí` line, or the
// router Draft block field `Entregable en vivo: sí` (`Entregable PROD: sí`
// before 21-sep). Loose words such as «main.js» or «sin deploy» never hold.
const PRODUCTION_REQUIRED_FIELD = /^\s*(?:-\s*)?(?:\*\*)?Requiere\s+producci[oó]n\s*:(?:\*\*)?\s*s[ií](?![a-záéíóúñ])/im;
const PRODUCTION_DELIVERABLE_FIELD = /^\s*(?:-\s*)?(?:\*\*)?Entregable\s+(?:en\s+vivo|prod)\s*:(?:\*\*)?\s*(?:s[ií]|yes|true)(?![a-záéíóúñ])/im;

export function routerProductionDeliverable(labels: string[], text: string): boolean {
  return labels.includes('production') || labels.includes('prod-deploy')
    || PRODUCTION_REQUIRED_FIELD.test(text) || PRODUCTION_DELIVERABLE_FIELD.test(text);
}

export function routerTaskHeld(labels: string[]): boolean {
  const approved = labels.includes('approved');
  const go = labels.includes(HUMAN_GO_LABEL);
  return labels.some((label) => ROUTER_HOLD_LABELS.has(label)
    && (label !== 'pedro' || !approved)
    && !(go && ROUTER_GO_LIFTS.has(label)));
}

/** Held, or a declared PROD deliverable without CK's recorded GO. */
export function routerGuarded(labels: string[], text: string): boolean {
  return routerTaskHeld(labels)
    || (!labels.includes(HUMAN_GO_LABEL) && routerProductionDeliverable(labels, text));
}

/**
 * Agent deletion never honors go-ck: a Draft, any hold or risk label, a
 * declared PROD deliverable, or sensitive wording all require a human.
 */
export function routerDeleteGuarded(labels: string[], text: string): boolean {
  return labels.some((label) => DELETE_GUARD_LABELS.has(label))
    || routerProductionDeliverable(labels, text) || routerTextSensitive(text);
}

/**
 * Narrow ingress for the external quota-aware router. Unlike move_task this
 * awaits the complete lifecycle and delegates the actual profile+move claim to
 * one repository transaction inside the per-task lifecycle lock.
 */
export const handleRouteTask: CommandHandler = async (
  params: Record<string, unknown>,
  context: CommandContext,
): Promise<CommandResponse> => {
  if (!context.onTaskRoute) return { success: false, error: 'Atomic routing is unavailable in this build' };
  const taskIdParam = String(params.taskId ?? '');
  const columnName = String(params.destination ?? '');
  const profileSelector = String(params.profile ?? '');
  const expectedRevision = Number(params.expectedRevision);
  const expectedFingerprint = String(params.expectedFingerprint ?? '');
  const expectedPolicyVersion = String(params.expectedPolicyVersion ?? '');
  const workflow = String(params.workflow ?? '');
  const dispatchId = String(params.dispatchId ?? '');
  if (!taskIdParam || !columnName || !profileSelector || !Number.isInteger(expectedRevision)
      || expectedRevision < 0 || !/^[a-f0-9]{64}$/i.test(expectedFingerprint)
      || !expectedPolicyVersion || !workflow || !dispatchId) {
    return { success: false, error: 'Invalid atomic route arguments' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const task = resolveTask(taskRepo, taskIdParam);
  if (!task) return { success: false, error: `Task "${taskIdParam}" not found` };
  const normalizedLabels = task.labels.map((label) => label.trim().toLowerCase());
  const text = `${task.title}\n${task.description}`;
  if (routerGuarded(normalizedLabels, text)) {
    return { success: false, error: 'Server guard refused automatic routing for a held or sensitive task' };
  }

  const destination = resolveColumn(db, columnName, 'todo', { includeArchivedDone: false });
  if ('error' in destination) return { success: false, error: destination.error };
  if (!['Planning', 'Executing'].includes(destination.swimlane.name)) {
    return { success: false, error: 'Atomic router may only enter Planning or Executing' };
  }
  const profile = resolveProfileSelector(context, profileSelector);
  if (!profile.ok) return { success: false, error: profile.error };

  const targetTasks = taskRepo.list(destination.swimlane.id);
  const targetPosition = resolveRawPosition(
    targetTasks.map((laneTask) => laneTask.position),
    targetTasks.length,
    taskRepo.nextPositionInSwimlane(destination.swimlane.id),
  );
  try {
    await context.onTaskRoute({
      taskId: task.id,
      targetSwimlaneId: destination.swimlane.id,
      targetPosition,
      expectedRevision,
      expectedFingerprint,
      policyVersion: expectedPolicyVersion,
      profileId: profile.profileId,
      workflow,
      dispatchId,
      projectId: context.projectId,
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  return {
    success: true,
    data: { id: task.id, displayId: task.display_id, column: destination.swimlane.name, profile: profileSelector, dispatchId },
    message: `Routed "${task.title}" to ${destination.swimlane.name} with profile ${profileSelector}.`,
  };
};

export function nextRouteStage(stage: string, workflow: string): string | null {
  if (stage === 'Planning') return 'Executing';
  if (stage === 'Executing') {
    if (workflow === 'review' || workflow === 'review-test') return 'Review';
    if (workflow === 'test') return 'Verify';
    if (workflow === 'direct') return 'Ready';
  }
  if (stage === 'Review') {
    if (workflow === 'review-test') return 'Verify';
    if (workflow === 'review') return 'Ready';
  }
  if (stage === 'Verify' && (workflow === 'test' || workflow === 'review-test')) return 'Ready';
  return null;
}

/**
 * A completed stage may be completed again only by a genuine rework run: the
 * task is back in that stage with a newer revision, and a session started for
 * it after the prior completion at least a minute ago. A delayed MCP retry from
 * the earlier run has no such session, so it stays a duplicate and cannot skip
 * the rework (Review -> Executing -> Review).
 */
export const ROUTE_REWORK_MIN_SESSION_AGE_MS = 60_000;

export function isRouteStageRework(
  db: ReturnType<CommandContext['getProjectDb']>,
  task: { id: string; revision: number },
  current: { name: string },
  stage: string,
  prior: { taskRevision: number; updatedAt?: string },
  now = Date.now(),
): boolean {
  if (current.name !== stage || task.revision <= prior.taskRevision || !prior.updatedAt) return false;
  const row = db.prepare(`SELECT started_at FROM sessions
    WHERE task_id = ? AND started_at > ? ORDER BY started_at DESC LIMIT 1`)
    .get(task.id, prior.updatedAt) as { started_at: string } | undefined;
  if (!row) return false;
  return now - Date.parse(row.started_at) >= ROUTE_REWORK_MIN_SESSION_AGE_MS;
}

/**
 * Finish one successful routed stage. Unlike the general move tool, the target
 * is derived server-side from the dispatch workflow and can never be Done.
 * The claim is durable before lifecycle work starts, so duplicate tool calls do
 * not spawn duplicate sessions; a failed/crashed move is retryable.
 */
export const handleCompleteRouteStage: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const taskIdParam = String(params.taskId ?? '');
  const expectedStage = String(params.stage ?? '');
  if (!taskIdParam) return { success: false, error: 'taskId is required' };
  if (!['Planning', 'Executing', 'Review', 'Verify'].includes(expectedStage)) {
    return { success: false, error: 'stage must be Planning, Executing, Review, or Verify' };
  }
  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const task = resolveTask(taskRepo, taskIdParam);
  if (!task) return { success: false, error: `Task "${taskIdParam}" not found` };
  const labels = task.labels.map((label) => label.trim().toLowerCase());
  if (routerGuarded(labels, `${task.title}\n${task.description}`)) {
    return { success: false, error: 'Server guard refused automatic stage completion for held or sensitive work' };
  }
  const current = db.prepare('SELECT id, name FROM swimlanes WHERE id = ?')
    .get(task.swimlane_id) as { id: string; name: string } | undefined;
  if (!current) return { success: false, error: 'Current column not found' };
  const dispatch = taskRepo.getLatestRouteDispatch(task.id);
  if (!dispatch) return { success: false, error: 'Task has no router dispatch' };
  const priorCompletion = taskRepo.getLatestRouteStageCompletion(dispatch.dispatchId, expectedStage);
  if (priorCompletion?.status === 'completed' && !isRouteStageRework(db, task, current, expectedStage, priorCompletion)) {
    const priorTarget = db.prepare('SELECT name FROM swimlanes WHERE id = ?')
      .get(priorCompletion.targetSwimlaneId) as { name: string } | undefined;
    return {
      success: true,
      message: `Stage ${expectedStage} was already accepted (${priorCompletion.status}).`,
      data: { id: task.id, column: expectedStage, target: priorTarget?.name ?? null, duplicate: true },
    };
  }
  if (priorCompletion?.status === 'pending') {
    const priorTarget = db.prepare('SELECT name FROM swimlanes WHERE id = ?')
      .get(priorCompletion.targetSwimlaneId) as { name: string } | undefined;
    if (current.id === priorCompletion.targetSwimlaneId) {
      taskRepo.finishRouteStageCompletion({
        dispatchId: dispatch.dispatchId,
        stage: expectedStage,
        taskRevision: priorCompletion.taskRevision,
        success: true,
      });
      return {
        success: true,
        message: `Stage ${expectedStage} had already moved and is now reconciled.`,
        data: { id: task.id, column: expectedStage, target: priorTarget?.name ?? null, duplicate: true },
      };
    }
    if (priorCompletion.taskRevision !== task.revision) {
      return {
        success: true,
        message: `Stage ${expectedStage} has an earlier pending completion and will not be replayed after task changes.`,
        data: { id: task.id, column: expectedStage, target: priorTarget?.name ?? null, duplicate: true },
      };
    }
  }
  if (current.name !== expectedStage) {
    return { success: false, error: `Task is in ${current.name}, not the declared stage ${expectedStage}` };
  }
  const targetName = nextRouteStage(current.name, dispatch.workflow);
  if (!targetName) {
    return { success: false, error: `Workflow ${dispatch.workflow} cannot auto-advance from ${current.name}` };
  }
  if (targetName === 'Ready') {
    const report = new TaskCloseoutRepository(db).get(task.id, task.revision);
    if (!report) {
      return { success: false, error: 'Ready requires a current task result. Read the task revision and call kangentic_record_task_result before completing this stage.' };
    }
    if (report.checks.length === 0 || report.checks.some((check) => check.result === 'failed')) {
      return { success: false, error: 'Ready requires documented checks with no failed results. Record actual evidence; explain not-run checks without claiming they passed.' };
    }
  }
  const target = resolveColumn(db, targetName, 'todo', { includeArchivedDone: false });
  if ('error' in target) return { success: false, error: target.error };
  if (target.swimlane.role === 'done' || target.swimlane.name === 'Done') {
    return { success: false, error: 'Automatic stage completion may never enter Done' };
  }
  let claim;
  try {
    claim = taskRepo.claimRouteStageCompletion({
      taskId: task.id,
      dispatchId: dispatch.dispatchId,
      stage: current.name,
      taskRevision: task.revision,
      currentSwimlaneId: current.id,
      targetSwimlaneId: target.swimlane.id,
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (claim.status === 'duplicate') {
    return {
      success: true,
      message: `Stage ${current.name} was already accepted (${claim.moveStatus}).`,
      data: { id: task.id, column: current.name, target: targetName, duplicate: true },
    };
  }
  const targetPosition = taskRepo.nextPositionInSwimlane(target.swimlane.id);
  void context.onTaskMove({
    taskId: task.id,
    targetSwimlaneId: target.swimlane.id,
    targetPosition,
    expectedSwimlaneId: current.id,
    expectedRevision: task.revision,
  }).then(() => {
    new TaskRepository(context.getProjectDb()).finishRouteStageCompletion({
      dispatchId: dispatch.dispatchId, stage: current.name, taskRevision: task.revision, success: true,
    });
  }).catch((error) => {
    new TaskRepository(context.getProjectDb()).finishRouteStageCompletion({
      dispatchId: dispatch.dispatchId, stage: current.name, taskRevision: task.revision,
      success: false, error: error instanceof Error ? error.message : String(error),
    });
    console.error(`[complete_route_stage] Failed for task ${task.id.slice(0, 8)}:`, error);
  });
  return {
    success: true,
    message: `Accepted successful ${current.name}; moving "${task.title}" to ${targetName}.`,
    data: { id: task.id, displayId: task.display_id, column: current.name, target: targetName, duplicate: false },
  };
};

/**
 * Mark the current routed task as requiring an explicit human answer.
 * This deliberately cannot move the card: it only records a bounded question
 * and two well-known labels, leaving every lifecycle decision to the human.
 */
export const handleRequestHumanInput: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const taskIdParam = String(params.taskId ?? '');
  const question = String(params.question ?? '').trim().slice(0, 2_000);
  if (!taskIdParam) return { success: false, error: 'taskId is required' };
  if (!question) return { success: false, error: 'question is required' };
  const taskRepo = new TaskRepository(context.getProjectDb());
  const task = resolveTask(taskRepo, taskIdParam);
  if (!task) return { success: false, error: `Task "${taskIdParam}" not found` };
  const current = context.getProjectDb().prepare('SELECT name FROM swimlanes WHERE id = ?')
    .get(task.swimlane_id) as { name: string } | undefined;
  if (!current || !['Planning', 'Executing', 'Review', 'Verify'].includes(current.name)) {
    return { success: false, error: 'Human input may only be requested from an active routed stage' };
  }
  const labels = [...new Set([...task.labels, 'needs-info', 'needs-human'])];
  const marker = `\n\n## Información requerida\n${question}`;
  const description = task.description.includes(marker) ? task.description : `${task.description}${marker}`;
  if (description.length > TASK_DESCRIPTION_MAX_LENGTH) {
    return { success: false, error: 'The question would exceed the task description limit' };
  }
  const updated = taskRepo.update({ id: task.id, labels, description });
  context.onTaskUpdated(updated);
  return {
    success: true,
    message: `Recorded human question for "${task.title}"; the task remains in ${current.name}.`,
    data: { id: task.id, displayId: task.display_id, column: current.name, question },
  };
};

/** Cap on how many tasks a reorder echoes back before truncating. */
const REORDER_ECHO_LIMIT = 25;

/**
 * Re-sequence tasks within a single column.
 *
 * Presentation only: it never changes a task's column, session, or worktree,
 * which is exactly why it does not go anywhere near `onTaskMove`. See
 * `computeReorderedIds` for the prefix semantics and
 * `TaskRepository.reorderWithinSwimlane` for why the write is a dense rewrite
 * and why it is not under `withTaskLock`.
 */
export const handleReorderTasks: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const columnName = params.column as string | null;
  const requestedIdParams = params.taskIds;

  if (!columnName) {
    return { success: false, error: 'column is required' };
  }
  if (!Array.isArray(requestedIdParams) || requestedIdParams.length === 0) {
    return { success: false, error: 'taskIds is required and must list at least one task.' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);

  const resolution = resolveColumn(db, columnName, 'todo', { includeArchivedDone: true });
  if ('error' in resolution) {
    return { success: false, error: resolution.error };
  }
  const { swimlane } = resolution;

  const laneTasks = taskRepo.list(swimlane.id);
  const laneIds = laneTasks.map((laneTask) => laneTask.id);
  const laneTaskById = new Map(laneTasks.map((laneTask) => [laneTask.id, laneTask]));

  // Resolve every id to a UUID BEFORE testing membership: `resolveTask` accepts
  // a numeric display ID, and the lane holds UUIDs, so comparing the raw input
  // would reject every "#42"-style id the agent is most likely to send.
  const requestedIds: string[] = [];
  const seenIds = new Set<string>();
  for (const requestedIdParam of requestedIdParams) {
    const idParam = String(requestedIdParam);
    const requestedTask = resolveTask(taskRepo, idParam);
    if (!requestedTask) {
      return { success: false, error: `Task "${idParam}" not found` };
    }
    if (!laneTaskById.has(requestedTask.id)) {
      // An ARCHIVED task still reports the column it was archived from, and Done
      // resolves by name via includeArchivedDone, so a task can name this very
      // column and still be absent from `list()`. Say THAT, rather than the
      // wrong-column message below, which would be flatly false. Mirrors the
      // same guard on `handleMoveTask`'s reposition path.
      if (requestedTask.swimlane_id === swimlane.id) {
        return {
          success: false,
          error: `Task "${idParam}" (#${requestedTask.display_id}) is archived, so it has no position in ${swimlane.name}.`,
        };
      }
      return {
        success: false,
        error: `Task "${idParam}" (#${requestedTask.display_id}) is not in ${swimlane.name}. Reordering never moves a task between columns - use kangentic_move_task for that.`,
      };
    }
    if (seenIds.has(requestedTask.id)) {
      return {
        success: false,
        error: `Task "${idParam}" (#${requestedTask.display_id}) is listed more than once in taskIds.`,
      };
    }
    seenIds.add(requestedTask.id);
    requestedIds.push(requestedTask.id);
  }

  const orderedIds = computeReorderedIds(laneIds, requestedIds);
  taskRepo.reorderWithinSwimlane(swimlane.id, orderedIds);
  context.onTasksReordered(swimlane, orderedIds);

  const displayOrder = orderedIds.map((id) => `#${laneTaskById.get(id)!.display_id}`);
  const echoed = displayOrder.slice(0, REORDER_ECHO_LIMIT).join(', ');
  const overflowSuffix = displayOrder.length > REORDER_ECHO_LIMIT
    ? `, and ${displayOrder.length - REORDER_ECHO_LIMIT} more`
    : '';

  return {
    success: true,
    message: `Reordered ${swimlane.name}. New order: ${echoed}${overflowSuffix}.`,
    data: {
      column: swimlane.name,
      order: orderedIds.map((id, index) => ({
        id,
        displayId: laneTaskById.get(id)!.display_id,
        position: index,
      })),
    },
  };
};

/**
 * Relocate a To Do task to a different project's board: creates an equivalent
 * task in the target project's DB (preserving title, description, labels,
 * priority, creation time, and attachments) then deletes the original from
 * the source project's DB. Takes two `CommandContext`s (source and target)
 * because it operates on two separate per-project SQLite databases at once -
 * unlike every other command handler, which is dispatched through the
 * single-context `commandHandlers` registry. Not registered there; called
 * directly by the `kangentic_move_task_to_project` tool.
 *
 * Scoped to To Do because entering a `role: 'todo'` column already resets a
 * task's live state (session killed, worktree removed, branch deleted - see
 * handleTaskMove's Priority 1 branch), so a To Do task is a pure metadata +
 * attachment relocation with no live git/PTY state that would need to cross
 * the project boundary. A task outside To Do may still hold a live session or
 * worktree that cannot be moved, so the move is rejected.
 */
export function handleMoveTaskToProject(
  params: { taskId: string; column?: string | null },
  source: CommandContext,
  target: CommandContext,
): CommandResponse {
  const taskId = params.taskId;
  if (!taskId) {
    return { success: false, error: 'taskId is required' };
  }

  const sourceDb = source.getProjectDb();
  const sourceTaskRepo = new TaskRepository(sourceDb);
  const task = resolveTask(sourceTaskRepo, taskId);
  if (!task) {
    return { success: false, error: `Task "${taskId}" not found` };
  }

  const sourceSwimlane = new SwimlaneRepository(sourceDb).getById(task.swimlane_id);
  if (!sourceSwimlane || sourceSwimlane.role !== 'todo') {
    return {
      success: false,
      error: `Only tasks in a To Do column can be moved to another project. Task #${task.display_id} is in "${sourceSwimlane?.name ?? 'an unknown column'}". Move it to To Do first.`,
    };
  }
  if (task.session_id) {
    return { success: false, error: `Task #${task.display_id} has an active session and cannot be moved to another project.` };
  }
  if (task.worktree_path && fs.existsSync(task.worktree_path)) {
    return { success: false, error: `Task #${task.display_id} still has a worktree on disk and cannot be moved to another project.` };
  }
  const normalizedLabels = (task.labels ?? []).map((label) => label.trim().toLowerCase());
  // CK's GO (go-ck) lets the Inbox hand a sensitive card to its project; the
  // target keeps every other guard, and deletion stays strict.
  if (routerGuarded(normalizedLabels, `${task.title}\n${task.description}`)) {
    return { success: false, error: 'Server guard refused relocation of held or sensitive work' };
  }

  const targetDb = target.getProjectDb();
  const resolution = resolveColumn(targetDb, params.column ?? null, 'todo', {
    refuseDone: 'a relocated task cannot land there',
  });
  if ('error' in resolution) {
    return { success: false, error: resolution.error };
  }
  const { swimlane: targetSwimlane } = resolution;
  if (targetSwimlane.role !== 'todo') {
    return {
      success: false,
      error: 'A relocated task may only land in the target project To Do column; the router decides active execution',
    };
  }

  const targetTaskRepo = new TaskRepository(targetDb);
  const newTask = targetTaskRepo.create({
    title: task.title,
    description: task.description,
    swimlane_id: targetSwimlane.id,
    labels: task.labels,
    priority: task.priority,
    createdAt: task.created_at,
  });

  const sourceAttachmentRepo = new AttachmentRepository(sourceDb);
  const targetAttachmentRepo = new AttachmentRepository(targetDb);
  const targetProjectPath = target.getProjectPath();
  const failedAttachments: string[] = [];
  for (const attachment of sourceAttachmentRepo.list(task.id)) {
    try {
      const base64Data = fs.readFileSync(attachment.file_path).toString('base64');
      targetAttachmentRepo.add(targetProjectPath, newTask.id, attachment.filename, base64Data, attachment.media_type);
    } catch (error) {
      console.error(`[move_task_to_project] Failed to copy attachment "${attachment.filename}":`, error);
      failedAttachments.push(attachment.filename);
    }
  }

  // If any attachment failed to copy, roll back the just-created target task
  // (and its copied attachments) and leave the source untouched. Without this,
  // the unconditional source delete below would destroy the attachments that
  // never reached the target - silent, unrecoverable data loss.
  if (failedAttachments.length > 0) {
    targetAttachmentRepo.deleteByTaskId(newTask.id);
    targetTaskRepo.delete(newTask.id);
    return {
      success: false,
      error: `Failed to copy ${failedAttachments.length} attachment(s) (${failedAttachments.join(', ')}) to the target project. Move aborted; task #${task.display_id} stays in the source project.`,
    };
  }

  // Delete the source task in FK-safe order (attachments, sessions, then the
  // task row), mirroring handleDeleteTask.
  sourceAttachmentRepo.deleteByTaskId(task.id);
  new SessionRepository(sourceDb).deleteByTaskId(task.id);
  source.onTaskDeleted(task);
  sourceTaskRepo.delete(task.id);

  target.onTaskCreated(newTask, targetSwimlane.name, targetSwimlane.id);

  return {
    success: true,
    message: `Moved "${task.title}" (was #${task.display_id}) to the ${targetSwimlane.name} column (now #${newTask.display_id}, id: ${newTask.id}).`,
    data: {
      sourceTaskId: task.id,
      sourceDisplayId: task.display_id,
      newTaskId: newTask.id,
      newDisplayId: newTask.display_id,
      title: newTask.title,
      column: targetSwimlane.name,
    },
  };
}

export const handleDeleteTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const taskId = params.taskId as string;

  if (!taskId) {
    return { success: false, error: 'taskId is required' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const task = resolveTask(taskRepo, taskId);
  if (!task) {
    return { success: false, error: `Task "${taskId}" not found` };
  }

  const sourceLane = new SwimlaneRepository(db).getById(task.swimlane_id);
  const deleteGuardLabels = task.labels.map((label) => label.trim().toLowerCase());
  if (context.actor !== 'human'
      && (sourceLane?.name === 'Draft'
        || routerDeleteGuarded(deleteGuardLabels, `${task.title}\n${task.description}`))) {
    return { success: false, error: 'Agents may not delete Draft, held, or sensitive tasks; human action is required' };
  }

  const attachmentRepo = new AttachmentRepository(db);
  const sessionRepo = new SessionRepository(db);

  // Delete attachments and session records before task (FK constraints)
  attachmentRepo.deleteByTaskId(task.id);
  sessionRepo.deleteByTaskId(task.id);

  // Fire-and-forget async cleanup (PTY kill, worktree removal, renderer notification)
  context.onTaskDeleted(task);

  // Delete the task from DB
  taskRepo.delete(task.id);

  return {
    success: true,
    message: `Deleted task "${task.title}" (#${task.display_id}).`,
    data: { id: task.id, displayId: task.display_id, title: task.title },
  };
};

/**
 * Remove a single attachment by ID from either surface. Tries the board
 * `task_attachments` table first, then falls back to backlog
 * `backlog_attachments` - the attachment UUID alone determines which surface
 * owns it, so there is no separate board/backlog parameter to get wrong.
 */
export const handleRemoveAttachment: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const attachmentId = params.attachmentId as string;

  if (!attachmentId) {
    return { success: false, error: 'attachmentId is required' };
  }

  const db = context.getProjectDb();

  const attachmentRepo = new AttachmentRepository(db);
  const boardAttachment = attachmentRepo.getById(attachmentId);
  if (boardAttachment) {
    attachmentRepo.remove(attachmentId);
    const taskRepo = new TaskRepository(db);
    const task = taskRepo.getById(boardAttachment.task_id);
    if (task) {
      context.onTaskUpdated(task);
    }
    return {
      success: true,
      message: `Removed attachment "${boardAttachment.filename}" from task ${task ? `"${task.title}" (#${task.display_id})` : boardAttachment.task_id}.`,
      data: { attachmentId, taskId: boardAttachment.task_id, filename: boardAttachment.filename },
    };
  }

  const backlogAttachmentRepo = new BacklogAttachmentRepository(db);
  const backlogAttachment = backlogAttachmentRepo.getById(attachmentId);
  if (backlogAttachment) {
    backlogAttachmentRepo.remove(attachmentId);
    context.onBacklogChanged();
    return {
      success: true,
      message: `Removed attachment "${backlogAttachment.filename}" from backlog item ${backlogAttachment.backlog_task_id}.`,
      data: { attachmentId, backlogItemId: backlogAttachment.backlog_task_id, filename: backlogAttachment.filename },
    };
  }

  return { success: false, error: `Attachment "${attachmentId}" not found` };
};
