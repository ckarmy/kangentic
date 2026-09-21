import { TaskRepository } from '../../db/repositories/task-repository';
import { resolveTask } from './task-resolver';
import { HUMAN_GO_LABEL } from './task-commands';
import type { CommandHandler, CommandResponse } from './types';

const ACTIVE_STAGES = /^(planning|executing|review|code review|verify|testing)$/i;
/** Holds a GO lifts. A question still pending, or a later one, holds again. */
const LIFTED_BY_GO = new Set(['needs-info', 'needs-human', 'manual-hold', 'no-auto']);

const quote = (text: string) => text.split(/\r?\n/).map((line) => `> ${line}`).join('\n');

/**
 * CK's GO or NO, relayed from a trusted local transport (the router, answering a
 * Telegram question). Only reachable with the admin token, never from an agent
 * session. GO records the comment on the card, adds `go-ck` and clears the holds
 * that were waiting on CK; on an active stage paused by a question it records
 * the answer and resumes the session. It never authorizes running anything in
 * production: the card text says so, and the column prompts hand those steps
 * back to CK as a prepared command. NO archives the card with the reason.
 */
export const handleRecordHumanGo: CommandHandler = async (params, context): Promise<CommandResponse> => {
  if (context.actor !== 'human') return { success: false, error: 'Only a trusted human transport can record a GO' };
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  const decision = params.decision === 'no' ? 'no' : params.decision === 'go' ? 'go' : null;
  const comment = typeof params.comment === 'string' ? params.comment.trim().slice(0, 2_000) : '';
  const source = typeof params.source === 'string' && params.source.trim() ? params.source.trim().slice(0, 40) : 'externo';
  if (!taskId || !decision) return { success: false, error: 'taskId and decision (go|no) are required' };

  const database = context.getProjectDb();
  const tasks = new TaskRepository(database);
  const task = resolveTask(tasks, taskId);
  if (!task || task.archived_at) return { success: false, error: 'Task is missing or archived' };
  if (Number.isSafeInteger(params.expectedRevision) && task.revision !== params.expectedRevision) {
    return { success: false, error: 'The task changed after the question was sent' };
  }
  const column = (database.prepare('SELECT name, role FROM swimlanes WHERE id = ?').get(task.swimlane_id) ?? {}) as { name?: string; role?: string };
  const stamp = new Date().toISOString();
  const labels = task.labels ?? [];
  const lower = labels.map((label) => label.trim().toLowerCase());

  if (decision === 'no') {
    const description = `${task.description ?? ''}\n\n## CK dijo que no (${source}, ${stamp})\n${quote(comment || 'sin comentario')}`;
    tasks.update({ id: task.id, description });
    tasks.archive(task.id);
    const archived = tasks.getById(task.id);
    if (archived) context.onTaskUpdated(archived);
    return { success: true, data: { archived: true }, message: 'Archived after CK said no.' };
  }

  const active = ACTIVE_STAGES.test(column.name ?? '');
  const waitingAnswer = active && lower.includes('needs-info');
  if (!active && column.role !== 'todo') {
    return { success: false, error: `A GO applies to Approved or an active stage, not ${column.name ?? 'this column'}` };
  }
  const nextLabels = labels.filter((label) => !LIFTED_BY_GO.has(label.trim().toLowerCase()));
  if (!nextLabels.some((label) => label.trim().toLowerCase() === HUMAN_GO_LABEL)) nextLabels.push(HUMAN_GO_LABEL);
  // An answered question keeps needs-human until the resume really starts a
  // session: that is what resumeAnsweredTask checks and then clears.
  if (waitingAnswer) nextLabels.push('needs-human');
  const heading = waitingAnswer ? '## Respuesta humana' : `## GO de CK (${source}, ${stamp})`;
  const description = `${task.description ?? ''}\n\n${heading}\n${quote(`GO de CK (${source}): ${comment || 'sigue'}`)}\n\n`
    + 'CK autoriza continuar con esta tarjeta. Nada que exija ejecutar en producción se ejecuta: '
    + 'se deja preparado (script, archivos, comando exacto) para que CK lo corra.';
  if (description.length > 50_000) return { success: false, error: 'The GO would exceed the task description limit' };
  tasks.update({ id: task.id, description, labels: nextLabels });
  const updated = tasks.getById(task.id);
  if (updated) context.onTaskUpdated(updated);

  if (waitingAnswer && updated) {
    if (!context.onAnsweredTaskResume) return { success: true, data: updated, message: 'GO saved; resume must be done in the app.' };
    try {
      await context.onAnsweredTaskResume(updated.id, updated.revision);
      return { success: true, data: { resumed: true }, message: 'GO saved and session resumed.' };
    } catch (failure) {
      return { success: true, data: { resumed: false }, message: `GO saved; resume failed: ${failure instanceof Error ? failure.message : String(failure)}` };
    }
  }
  return { success: true, data: updated, message: active ? 'GO saved.' : 'GO saved; the router can take it now.' };
};
