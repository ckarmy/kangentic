import { TaskRepository } from '../../db/repositories/task-repository';
import { resolveTask } from './task-resolver';
import type { CommandHandler, CommandResponse } from './types';

export const handleResumeAnsweredTask: CommandHandler = async (params, context) => {
  if (context.actor !== 'human' || !context.onAnsweredTaskResume) {
    return { success: false, error: 'Only a human can resume an answered task' };
  }
  if (typeof params.taskId !== 'string' || !params.taskId.trim() || !Number.isSafeInteger(params.expectedRevision)) {
    return { success: false, error: 'taskId and expectedRevision are required' };
  }
  try {
    await context.onAnsweredTaskResume(params.taskId, params.expectedRevision as number);
    return { success: true, data: { resumed: true } };
  } catch (failure) {
    return { success: false, error: failure instanceof Error ? failure.message : 'Resume was not confirmed' };
  }
};

/** Record an answer, not an execution permission. Resuming is a separate action. */
export const handleHumanResponse: CommandHandler = (params, context): CommandResponse => {
  // The trusted transport supplies actor. A payload cannot promote itself.
  if (context.actor !== 'human') {
    return { success: false, error: 'Only a human can answer a task question' };
  }
  if (typeof params.taskId !== 'string' || !params.taskId.trim()
      || typeof params.answer !== 'string' || !params.answer.trim()
      || params.answer.trim().length > 4_000
      || !Number.isSafeInteger(params.expectedRevision)) {
    return { success: false, error: 'taskId, answer (1-4000 characters), and expectedRevision are required' };
  }
  const taskId = params.taskId;
  const answer = params.answer.trim();
  const database = context.getProjectDb();
  const tasks = new TaskRepository(database);
  const result = database.transaction((): CommandResponse => {
    const task = resolveTask(tasks, taskId);
    if (!task || task.archived_at) return { success: false, error: 'Task is missing or archived' };
    if (task.revision !== params.expectedRevision) {
      return { success: false, error: 'The task changed. Refresh and review the current question before answering.' };
    }
    const labels = task.labels ?? [];
    if (!labels.some((label) => label.trim().toLowerCase() === 'needs-info')) {
      return { success: false, error: 'This task has no outstanding information request' };
    }
    // Never clear manual-hold/no-auto, grant approved, or infer a production GO.
    // Keeping needs-human prevents the router from starting work on a mere save.
    const nextLabels = labels.filter((label) => label.trim().toLowerCase() !== 'needs-info');
    if (!nextLabels.some((label) => label.trim().toLowerCase() === 'needs-human')) nextLabels.push('needs-human');
    // Quote each line so an answer cannot accidentally become a new parser heading.
    const quotedAnswer = answer.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
    const description = `${task.description ?? ''}\n\n## Respuesta humana\n${quotedAnswer}\n\nRespuesta registrada; ejecución todavía pausada. No amplía el alcance autorizado.`;
    if (description.length > 50_000) return { success: false, error: 'The answer would exceed the task description limit' };
    tasks.update({ id: task.id, description, labels: nextLabels });
    return { success: true, data: tasks.getById(task.id), message: 'Answer saved. Task remains paused until explicitly resumed.' };
  })();
  if (result.success && result.data) {
    // Re-read by resolved identity, not by whichever project is on screen.
    const updated = resolveTask(tasks, taskId);
    if (updated) context.onTaskUpdated(updated);
  }
  return result;
};
