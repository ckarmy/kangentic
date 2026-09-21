import { withTaskLock } from '../ipc/task-lifecycle-lock';
import { getProjectRepos, ensureTaskWorktree, createTransitionEngine, resolveSpawnOverrides } from '../ipc/helpers';
import { getProjectDb } from '../db/database';
import { SessionRepository } from '../db/repositories/session-repository';
import { applySuspendDbWrites, reconcileTaskSessionRef } from '../ipc/handlers/session-reconcile';
import { abortInFlightResume, registerResumeController, releaseResumeController } from '../ipc/handlers/session-resume-controllers';
import { applyProfileToLane } from '../transition-engine/column-strategy';
import { loadTaskProfile } from '../ipc/helpers/task-profile';
import { humanResponseResumeBlock } from '../../shared/human-response-resume';
import type { IpcContext } from '../ipc/ipc-context';

/** Human UI only. Keeps the router hold until a replacement session really exists. */
export async function resumeAnsweredTask(context: IpcContext, projectId: string, taskId: string, expectedRevision: number): Promise<void> {
  if (!projectId || !taskId || !Number.isSafeInteger(expectedRevision)) throw new Error('Invalid resume request');
  const project = context.projectRepo.getById(projectId);
  if (!project) throw new Error('Project is unavailable');
  abortInFlightResume(taskId);
  const controller = new AbortController();
  registerResumeController(taskId, controller);
  const { signal } = controller;
  try {
    await withTaskLock(taskId, async () => {
      const { tasks, swimlanes, automations, automationRuns, attachments } = getProjectRepos(context, projectId);
      const original = tasks.getById(taskId);
      if (!original || original.revision !== expectedRevision) throw new Error('La tarjeta cambió. Actualiza y revisa antes de reanudar.');
      const block = humanResponseResumeBlock({ labels: original.labels, description: original.description,
        archived: Boolean(original.archived_at), columnName: swimlanes.getById(original.swimlane_id)?.name ?? '' });
      if (block) throw new Error(block);
      signal.throwIfAborted();
      const { liveSession } = reconcileTaskSessionRef(context, projectId, taskId);
      if (liveSession) {
        // Never feed an answer to a permission prompt, or kill a working/unknown session.
        if (liveSession.status !== 'running' || context.sessionManager.getActivityCache()[liveSession.id] !== 'idle') {
          throw new Error('La sesión sigue activa, en cola o esperando un permiso. Abre la sesión para revisar su estado.');
        }
        applySuspendDbWrites(context, projectId, taskId, 'user');
        await context.sessionManager.suspend(liveSession.id);
      }
      signal.throwIfAborted();
      const prepared = tasks.getById(taskId);
      if (!prepared) throw new Error('Task disappeared');
      await ensureTaskWorktree(context, prepared, tasks, project.path, { signal, projectId });
      signal.throwIfAborted();
      const current = tasks.getById(taskId);
      // Worktree setup can update worktree metadata. Scope/holds/lane must not change.
      if (!current || current.description !== original.description || current.swimlane_id !== original.swimlane_id
          || JSON.stringify(current.labels) !== JSON.stringify(original.labels)
          || current.title !== original.title || current.model_override !== original.model_override
          || current.effort_override !== original.effort_override || current.agent !== original.agent
          || current.base_branch !== original.base_branch || current.use_worktree !== original.use_worktree
          || current.permission_mode !== original.permission_mode || current.archived_at) {
        throw new Error('La tarjeta cambió durante la preparación. Sigue pausada; revisa antes de reintentar.');
      }
      const lane = applyProfileToLane(swimlanes.getById(current.swimlane_id), loadTaskProfile(context, current, project.path));
      const engine = createTransitionEngine(context, automations, automationRuns, tasks, new SessionRepository(getProjectDb(projectId)), attachments, projectId, project.path);
      const prompt = 'El humano respondió la última pregunta en la descripción actual. Continúa únicamente el alcance previamente aprobado usando esa respuesta. '
        + 'No repitas trabajo completado. Esta reanudación no autoriza producción, secretos, despliegues ni operaciones destructivas. '
        + 'Si la respuesta es insuficiente, solicita el dato concreto que falta.';
      try {
        await engine.resumeSuspendedSession(current, lane?.permission_mode, undefined, prompt, signal, undefined, undefined,
          resolveSpawnOverrides(current, lane, project));
      } catch (failure) {
        // A spawn can fail after creating the PTY. Do not leave it working under
        // a held card or automatically retry an uncertain partial execution.
        const partial = tasks.getById(taskId);
        const partialSession = partial?.session_id ? context.sessionManager.getSession(partial.session_id) : null;
        if (partialSession && ['running', 'queued'].includes(partialSession.status)) {
          applySuspendDbWrites(context, projectId, taskId, 'system');
          await context.sessionManager.suspend(partialSession.id);
        }
        throw failure;
      }
      const updated = tasks.getById(taskId);
      const started = updated?.session_id ? context.sessionManager.getSession(updated.session_id) : null;
      if (!updated || !started || !['running', 'queued'].includes(started.status)) throw new Error('No se confirmó la sesión; la tarjeta conserva la pausa.');
      // Do not overwrite a new question or hold arriving during asynchronous startup.
      if (updated.description !== current.description || JSON.stringify(updated.labels) !== JSON.stringify(current.labels)
          || updated.swimlane_id !== current.swimlane_id || signal.aborted) {
        applySuspendDbWrites(context, projectId, taskId, 'system');
        await context.sessionManager.suspend(started.id);
        throw new Error('La tarjeta cambió durante el inicio; se mantuvo pausada.');
      }
      tasks.update({ id: taskId, labels: updated.labels.filter((label) => label.trim().toLowerCase() !== 'needs-human') });
      context.boardEvents.emitBoardChanged({ projectId, change: 'task-updated', ids: [taskId] });
    });
  } finally {
    releaseResumeController(taskId, controller);
  }
}
