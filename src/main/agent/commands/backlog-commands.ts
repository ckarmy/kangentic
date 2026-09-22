import fs from 'node:fs';
import { TaskRepository } from '../../db/repositories/task-repository';
import { BacklogRepository } from '../../db/repositories/backlog-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { BacklogAttachmentRepository } from '../../db/repositories/backlog-attachment-repository';
import { readFileAsAttachment } from '../../db/repositories/attachment-utils';
import { BACKLOG_PRIORITY_LABELS } from '../../../shared/types';
import { resolveColumn } from './column-resolver';
import type { CommandContext, CommandHandler, CommandResponse } from './types';
import type { BacklogTaskUpdateInput } from '../../../shared/types';

// Backlog items keep a lower description cap than board tasks (whose cap is
// TASK_DESCRIPTION_MAX_LENGTH in task-commands.ts). handleCreateTask enforces
// this before routing a `column: "Backlog"` create here, so an over-cap
// backlog description fails loudly instead of being silently truncated.
export const BACKLOG_DESCRIPTION_MAX_LENGTH = 10_000;

function includesApprovedLabel(labels: Array<string | { name: string }>): boolean {
  return labels.some((entry) => (typeof entry === 'string' ? entry : entry?.name)?.trim().toLowerCase() === 'approved');
}

/** Max serialized size of a backlog item's `externalMetadata`. */
export const BACKLOG_EXTERNAL_METADATA_MAX_BYTES = 16_384;

/**
 * A calendar date, `YYYY-MM-DD`, that actually exists. Returns the error text,
 * or null when valid.
 */
export function validateDueDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return 'dueDate must be a date in YYYY-MM-DD form';
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return `dueDate "${value}" is not a real calendar date`;
  }
  return null;
}

/** A plain JSON object under the size cap. Returns the error text, or null. */
export function validateExternalMetadata(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'externalMetadata must be a JSON object';
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return 'externalMetadata must be serializable JSON';
  }
  if (Buffer.byteLength(serialized, 'utf8') > BACKLOG_EXTERNAL_METADATA_MAX_BYTES) {
    return `externalMetadata exceeds ${BACKLOG_EXTERNAL_METADATA_MAX_BYTES} bytes`;
  }
  return null;
}

/** The stable JSON shape list/create/update return for one backlog item. */
export function backlogItemData(item: {
  id: string; title: string; description: string; priority: number; labels: string[];
  due_date: string | null; assignee: string | null; external_metadata: Record<string, unknown> | null; created_at: string;
}) {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    priority: item.priority,
    priorityLabel: BACKLOG_PRIORITY_LABELS[item.priority] ?? 'None',
    labels: item.labels,
    dueDate: item.due_date,
    assignee: item.assignee,
    externalMetadata: item.external_metadata,
    createdAt: item.created_at,
  };
}

/**
 * Soonest due date first, undated items after, stable otherwise (the input is
 * the backlog's manual position order). `YYYY-MM-DD` sorts correctly as text.
 */
export function sortBacklogByDueDate<T extends { due_date: string | null }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftDue = left.item.due_date;
      const rightDue = right.item.due_date;
      if (leftDue && rightDue && leftDue !== rightDue) return leftDue < rightDue ? -1 : 1;
      if (leftDue && !rightDue) return -1;
      if (!leftDue && rightDue) return 1;
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

/**
 * A Draft column: named like one, no role, and it never starts an agent. The
 * name check keeps Ready (also agentless) from counting.
 */
export function isDraftColumn(lane: { name: string; role: string | null; auto_spawn: boolean }): boolean {
  return lane.role === null && !lane.auto_spawn && /^(draft|drafts|borrador|borradores|ideas?)$/i.test(lane.name.trim());
}

const AGENT_PROTECTED_BACKLOG_LABELS = new Set([
  'approved', 'pedro', 'no-auto', 'manual-hold', 'risky', 'production',
]);

export const handleListBacklog: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const priorityFilter = params.priority as number | null;
  const query = (params.query as string | null)?.toLowerCase() ?? null;
  const dueOnOrBefore = (params.dueOnOrBefore as string | null | undefined) ?? null;
  if (dueOnOrBefore !== null) {
    const dueError = validateDueDate(dueOnOrBefore);
    if (dueError) return { success: false, error: dueError.replace('dueDate', 'dueOnOrBefore') };
  }

  const db = context.getProjectDb();
  const backlogRepo = new BacklogRepository(db);

  let items = backlogRepo.list();

  if (priorityFilter !== null && priorityFilter !== undefined) {
    items = items.filter((item) => item.priority === priorityFilter);
  }
  if (query) {
    items = items.filter(
      (item) =>
        item.title.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query) ||
        item.labels.some((label) => label.toLowerCase().includes(query)),
    );
  }
  if (dueOnOrBefore !== null) {
    // Items with no due date are not "due on or before" anything.
    items = items.filter((item) => item.due_date !== null && item.due_date <= dueOnOrBefore);
  }
  // Soonest due first, undated last; the backlog's own order breaks ties.
  items = sortBacklogByDueDate(items);

  if (items.length === 0) {
    const filterNote = query ? ` matching "${query}"` : '';
    return { success: true, message: `No backlog tasks found${filterNote}.`, data: [] };
  }

  const lines = items.map((item) => {
    const priorityLabel = BACKLOG_PRIORITY_LABELS[item.priority] ?? 'None';
    const labelString = item.labels.length > 0 ? ` [${item.labels.join(', ')}]` : '';
    const dueString = item.due_date ? ` (due: ${item.due_date})` : '';
    return `- ${item.title} (${priorityLabel})${labelString}${dueString} (id: ${item.id})`;
  });

  return {
    success: true,
    message: `${items.length} backlog task(s):\n${lines.join('\n')}`,
    data: items.map(backlogItemData),
  };
};

export const handleCreateBacklogTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const title = String(params.title ?? '').slice(0, 200);
  const description = String(params.description ?? '').slice(0, BACKLOG_DESCRIPTION_MAX_LENGTH);
  const priority = (params.priority as number) ?? 0;
  const rawLabels = (params.labels as Array<string | { name: string; color: string }>) ?? [];
  const attachments = params.attachments as Array<{ filePath: string; filename?: string }> | null;
  const dueDate = (params.dueDate as string | null | undefined) ?? null;
  const assignee = (params.assignee as string | null | undefined) ?? null;
  const externalMetadata = (params.externalMetadata as Record<string, unknown> | null | undefined) ?? null;

  // Observability for the "labels dropped on a large description" bug
  // (task #229). Logs the raw `labels` value as received (before the `?? []`
  // fallback above), so an absent key is visible as null.
  console.log('[create_backlog_task] received args:', {
    descriptionLength: description.length,
    labels: params.labels ?? null,
  });

  if (includesApprovedLabel(rawLabels)) {
    return { success: false, error: 'Agents may not grant the approved label; human action is required' };
  }

  // Normalize labels: extract names for DB storage and colors for config
  const labelNames: string[] = [];
  const labelColorMap: Record<string, string> = {};
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

  if (!title.trim()) {
    return { success: false, error: 'Title is required' };
  }

  if (priority < 0 || priority > 4) {
    return { success: false, error: 'Priority must be 0-4 (0=none, 1=low, 2=medium, 3=high, 4=urgent)' };
  }
  if (dueDate !== null) {
    const dueError = validateDueDate(dueDate);
    if (dueError) return { success: false, error: dueError };
  }
  if (externalMetadata !== null) {
    const metadataError = validateExternalMetadata(externalMetadata);
    if (metadataError) return { success: false, error: metadataError };
  }
  const trimmedAssignee = assignee !== null ? String(assignee).trim().slice(0, 200) : '';

  const db = context.getProjectDb();
  const backlogRepo = new BacklogRepository(db);

  const item = backlogRepo.create({
    title,
    description,
    priority: priority,
    labels: labelNames,
    ...(dueDate !== null ? { dueDate } : {}),
    ...(trimmedAssignee ? { assignee: trimmedAssignee } : {}),
    ...(externalMetadata !== null ? { externalMetadata } : {}),
  });

  // Process file attachments if provided
  if (attachments && attachments.length > 0) {
    const backlogAttachmentRepo = new BacklogAttachmentRepository(db);
    const projectPath = context.getProjectPath();
    for (const entry of attachments) {
      try {
        const fileData = readFileAsAttachment(entry.filePath, entry.filename);
        backlogAttachmentRepo.add(projectPath, item.id, fileData.filename, fileData.base64Data, fileData.mediaType);
      } catch (error) {
        console.error(`[create_backlog_task] Failed to attach file "${entry.filePath}":`, error);
      }
    }
  }

  // Persist label colors to config if any were provided
  if (Object.keys(labelColorMap).length > 0) {
    context.onLabelColorsChanged(labelColorMap);
  }

  context.onBacklogChanged();

  const priorityLabel = BACKLOG_PRIORITY_LABELS[item.priority] ?? 'None';
  return {
    success: true,
    // `priority` stays the LABEL, which create_task's existing callers read;
    // the number is `priorityValue`.
    data: { ...backlogItemData(item), priority: priorityLabel, priorityValue: item.priority },
    message: `Created backlog task "${item.title}" (priority: ${priorityLabel}, id: ${item.id})`,
  };
};

export const handleUpdateBacklogItem: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const itemId = params.itemId as string;
  const newTitle = (params.title ?? null) as string | null;
  const newDescription = (params.description ?? null) as string | null;
  const newPriority = (params.priority ?? null) as number | null;
  const rawLabels = (params.labels ?? null) as Array<string | { name: string; color: string }> | null;
  const newAttachments = (params.attachments ?? null) as Array<{ filePath: string; filename?: string }> | null;
  // undefined = untouched; null = clear.
  const newDueDate = params.dueDate as string | null | undefined;
  const newExternalMetadata = params.externalMetadata as Record<string, unknown> | null | undefined;

  // Observability for the "labels dropped on a large description" bug
  // (task #229). See the matching note in handleCreateBacklogTask.
  console.log('[update_backlog_item] received args:', {
    descriptionLength: typeof newDescription === 'string' ? newDescription.length : null,
    labels: rawLabels,
  });

  if (!itemId) {
    return { success: false, error: 'itemId is required' };
  }

  if (newPriority !== null && (newPriority < 0 || newPriority > 4)) {
    return { success: false, error: 'Priority must be 0-4 (0=none, 1=low, 2=medium, 3=high, 4=urgent)' };
  }
  if (newDueDate !== undefined && newDueDate !== null) {
    const dueError = validateDueDate(newDueDate);
    if (dueError) return { success: false, error: dueError };
  }
  if (newExternalMetadata !== undefined && newExternalMetadata !== null) {
    const metadataError = validateExternalMetadata(newExternalMetadata);
    if (metadataError) return { success: false, error: metadataError };
  }

  const db = context.getProjectDb();
  const backlogRepo = new BacklogRepository(db);

  const existing = backlogRepo.getById(itemId);
  if (!existing) {
    return {
      success: false,
      error: `Backlog item "${itemId}" not found. If you remember this ID from before a backlog -> board promotion, the new task has a different UUID - search for it by title with kangentic_search_tasks or kangentic_find_task.`,
    };
  }

  const updates: Record<string, unknown> = { id: existing.id };
  const changedFields: string[] = [];

  if (newTitle !== null) {
    updates.title = String(newTitle).slice(0, 200);
    changedFields.push('title');
  }
  if (newDescription !== null) {
    updates.description = String(newDescription).slice(0, BACKLOG_DESCRIPTION_MAX_LENGTH);
    changedFields.push('description');
  }
  if (newPriority !== null) {
    updates.priority = Number(newPriority);
    changedFields.push('priority');
  }
  if (newDueDate !== undefined) {
    updates.dueDate = newDueDate;
    changedFields.push('dueDate');
  }
  if (newExternalMetadata !== undefined) {
    updates.externalMetadata = newExternalMetadata;
    changedFields.push('externalMetadata');
  }

  const labelColorMap: Record<string, string> = {};
  if (rawLabels !== null) {
    if (includesApprovedLabel(rawLabels)) {
      return { success: false, error: 'Agents may not grant the approved label; human action is required' };
    }
    const labelNames: string[] = [];
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
    const requestedLabels = new Set(labelNames.map((label) => label.trim().toLowerCase()));
    const removedProtected = existing.labels
      .map((label) => label.trim().toLowerCase())
      .filter((label) => AGENT_PROTECTED_BACKLOG_LABELS.has(label) && !requestedLabels.has(label));
    if (removedProtected.length > 0) {
      return {
        success: false,
        error: `Agents may not remove protected backlog labels (${removedProtected.join(', ')}); human action is required`,
      };
    }
    updates.labels = labelNames;
    changedFields.push('labels');
  }

  // Attach files if provided (additive - existing attachments are untouched).
  let attachmentsAdded = 0;
  if (newAttachments && newAttachments.length > 0) {
    const backlogAttachmentRepo = new BacklogAttachmentRepository(db);
    const projectPath = context.getProjectPath();
    for (const entry of newAttachments) {
      try {
        const fileData = readFileAsAttachment(entry.filePath, entry.filename);
        backlogAttachmentRepo.add(projectPath, existing.id, fileData.filename, fileData.base64Data, fileData.mediaType);
        attachmentsAdded += 1;
      } catch (error) {
        console.error(`[update_backlog_item] Failed to attach file "${entry.filePath}":`, error);
      }
    }
    if (attachmentsAdded > 0) changedFields.push('attachments');
  }

  if (changedFields.length === 0) {
    const attachmentsRequested = newAttachments?.length ?? 0;
    return {
      success: false,
      error: attachmentsRequested > 0
        ? `Failed to attach any of the ${attachmentsRequested} requested file(s); no other fields were updated.`
        : 'No fields provided to update',
    };
  }

  // The attach loop above must run BEFORE this update/getById: backlog
  // attachment_count is a stored column synced inside BacklogAttachmentRepository.add,
  // so re-reading the row here picks up the fresh count. (Contrast handleUpdateTask,
  // where attachment_count is a computed JOIN aggregate, so its re-fetch happens
  // after the loop instead.)
  const hasScalarChange = Object.keys(updates).length > 1;
  const updated = hasScalarChange ? backlogRepo.update(updates as unknown as BacklogTaskUpdateInput) : (backlogRepo.getById(existing.id) ?? existing);

  if (Object.keys(labelColorMap).length > 0) {
    context.onLabelColorsChanged(labelColorMap);
  }

  context.onBacklogChanged();

  const priorityLabel = BACKLOG_PRIORITY_LABELS[updated.priority] ?? 'None';
  return {
    success: true,
    message: `Updated ${changedFields.join(', ')} for "${updated.title}".`,
    data: {
      ...backlogItemData(updated),
      priorityLabel,
      ...(newAttachments !== null ? { attachmentCount: updated.attachment_count, attachmentsAdded } : {}),
    },
  };
};

export const handleDeleteBacklogItem: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const itemId = params.itemId as string;

  if (!itemId) {
    return { success: false, error: 'itemId is required' };
  }

  const db = context.getProjectDb();
  const backlogRepo = new BacklogRepository(db);
  const item = backlogRepo.getById(itemId);
  if (!item) {
    return {
      success: false,
      error: `Backlog item "${itemId}" not found. If you remember this ID from before a backlog -> board promotion, the new task has a different UUID - search for it by title with kangentic_search_tasks or kangentic_find_task.`,
    };
  }

  const backlogAttachmentRepo = new BacklogAttachmentRepository(db);
  backlogAttachmentRepo.deleteByTaskId(item.id);
  backlogRepo.delete(item.id);

  context.onBacklogChanged();

  return {
    success: true,
    message: `Deleted backlog item "${item.title}".`,
    data: { id: item.id, title: item.title },
  };
};

export const handlePromoteBacklog: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const itemIds = params.itemIds as string[];
  const columnName = params.column as string | null;

  if (!itemIds || itemIds.length === 0) {
    return { success: false, error: 'At least one backlog task ID is required' };
  }

  const db = context.getProjectDb();
  const backlogRepo = new BacklogRepository(db);
  const taskRepo = new TaskRepository(db);

  const resolution = resolveColumn(db, columnName, 'todo', {
    refuseDone: 'a backlog item cannot be promoted straight there',
  });
  if ('error' in resolution) {
    return { success: false, error: resolution.error };
  }
  const { swimlane: targetSwimlane } = resolution;
  const toDraft = isDraftColumn(targetSwimlane);
  if (targetSwimlane.role !== 'todo' && !toDraft) {
    return { success: false, error: 'Agents may promote backlog items only to Draft or To Do for human/router review' };
  }

  // Draft never starts an agent and nothing leaves it without a human, so a
  // protected item may land there. To Do is where the router picks work up,
  // so protected work still needs a human to put it there.
  if (!toDraft) {
    for (const itemId of itemIds) {
      const item = backlogRepo.getById(itemId);
      const labels = item?.labels.map((label) => label.trim().toLowerCase()) ?? [];
      if (labels.some((label) => AGENT_PROTECTED_BACKLOG_LABELS.has(label))) {
        return { success: false, error: 'Protected backlog work must be promoted by a human in the UI' };
      }
    }
  }

  const backlogAttachmentRepo = new BacklogAttachmentRepository(db);
  const attachmentRepo = new AttachmentRepository(db);
  const projectPath = context.getProjectPath();

  const promoted: Array<{ taskId: string; title: string }> = [];
  const notFound: string[] = [];

  for (const itemId of itemIds) {
    const item = backlogRepo.getById(itemId);
    if (!item) {
      notFound.push(itemId);
      continue;
    }

    const task = taskRepo.create({
      title: item.title,
      description: item.description,
      swimlane_id: targetSwimlane.id,
      labels: item.labels,
      priority: item.priority,
      externalId: item.external_id ?? undefined,
      externalSource: item.external_source ?? undefined,
      externalUrl: item.external_url ?? undefined,
    });

    // Copy backlog attachments to task attachments
    const backlogAttachments = backlogAttachmentRepo.list(itemId);
    for (const backlogAttachment of backlogAttachments) {
      try {
        const buffer = fs.readFileSync(backlogAttachment.file_path);
        const base64Data = buffer.toString('base64');
        attachmentRepo.add(projectPath, task.id, backlogAttachment.filename, base64Data, backlogAttachment.media_type);
      } catch (error) {
        console.error(`[promote_backlog] Failed to copy attachment "${backlogAttachment.filename}":`, error);
      }
    }
    // Clean up backlog attachment files
    backlogAttachmentRepo.deleteByTaskId(itemId);

    backlogRepo.delete(itemId);
    promoted.push({ taskId: task.id, title: task.title });

    context.onTaskCreated(task, targetSwimlane.name, targetSwimlane.id);
  }

  context.onBacklogChanged();

  if (promoted.length === 0) {
    return {
      success: false,
      error: `No backlog tasks found for the provided IDs. If you remember an ID from before a previous promotion, the new task has a different UUID - search for the current ID with kangentic_search_tasks.`,
    };
  }

  const lines = promoted.map((item) => `- "${item.title}" (task id: ${item.taskId})`);
  let message = `Moved ${promoted.length} item(s) to ${targetSwimlane.name}:\n${lines.join('\n')}`;
  if (notFound.length > 0) {
    message += `\n\nNot found: ${notFound.join(', ')}`;
  }

  return {
    success: true,
    message,
    data: { promoted, targetColumn: targetSwimlane.name, notFound },
  };
};
