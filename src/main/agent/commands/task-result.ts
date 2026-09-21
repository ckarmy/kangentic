import { TaskRepository } from '../../db/repositories/task-repository';
import { TaskCloseoutRepository } from '../../db/repositories/task-closeout-repository';
import { parseTaskCloseout } from '../../../shared/task-closeout';
import { resolveTask } from './task-resolver';
import { routerTaskHeld } from './task-commands';
import type { CommandHandler } from './types';

/** Read-only transport entry point. Project scope is bound by the context. */
export const handleGetTaskResult: CommandHandler = async (params, context) => {
  if (typeof params.taskId !== 'string' || !params.taskId.trim()) return { success: false, error: 'taskId is required' };
  if (!context.readTaskResult) return { success: false, error: 'Task result reader is unavailable' };
  return { success: true, data: await context.readTaskResult(params.taskId) };
};

/** Persist declarations as declarations, without completing or approving a task. */
export const handleRecordTaskResult: CommandHandler = (params, context) => {
  if (typeof params.taskId !== 'string' || typeof params.report !== 'string'
      || Buffer.byteLength(params.report, 'utf8') > 64 * 1024 || !Number.isSafeInteger(params.expectedRevision)
      || (params.expectedRevision as number) < 0) {
    return { success: false, error: 'taskId, expectedRevision and a JSON report up to 64 KB are required' };
  }
  const database = context.getProjectDb();
  return database.transaction(() => {
    const task = resolveTask(new TaskRepository(database), params.taskId as string);
    if (!task || task.archived_at) return { success: false, error: 'Task is missing or archived' };
    if (task.revision !== params.expectedRevision) return { success: false, error: 'Task changed. Refresh before recording the result.' };
    if (context.actor !== 'human' && routerTaskHeld(task.labels.map((label) => label.trim().toLowerCase()))) {
      return { success: false, error: 'Human action is required for a held task' };
    }
    let report;
    try { report = parseTaskCloseout(JSON.parse(params.report as string), task.id); } catch { report = null; }
    if (!report) return { success: false, error: 'Invalid result schema or task identity. See the task-closeout report schema.' };
    new TaskCloseoutRepository(database).save(task.id, task.revision, report);
    return { success: true, data: { taskId: task.id, recorded: true, verified: false },
      message: 'Result recorded as agent-declared evidence. No stage, approval, push or deployment was performed.' };
  })();
};
