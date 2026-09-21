import { getProjectRepos } from '../ipc/helpers/project-repos';
import { getProjectDb } from '../db/database';
import { TaskCloseoutRepository } from '../db/repositories/task-closeout-repository';
import { prepareGitDelivery } from '../git/delivery-preview';
import type { IpcContext } from '../ipc/ipc-context';
import type { TaskDeliveryPreview } from '../../shared/task-delivery';
import type { TaskDeliveryConfirmation, TaskDeliveryCommitResult } from '../../shared/task-delivery';
import { withTaskLock } from '../ipc/task-lifecycle-lock';
import { commitGitDelivery } from '../git/delivery-commit';
import { prepareGitPush, confirmGitPush } from '../git/delivery-push';
import type { TaskPushPreview } from '../../shared/task-delivery';
import { randomUUID } from 'node:crypto';
import type { TaskDeliveryOperation } from '@kangentic/protocol';
import { runDeliveryOperation } from './delivery-operation';

/** Preview only. A separate future human confirmation must revalidate before mutation. */
export async function prepareTaskDelivery(context: IpcContext, projectId: string, taskId: string): Promise<TaskDeliveryPreview> {
  if (!projectId || !taskId || !context.projectRepo.getById(projectId)) throw new Error('Proyecto o tarjeta no disponibles.');
  const { tasks, swimlanes } = getProjectRepos(context, projectId);
  const task = tasks.getById(taskId);
  if (!task || task.archived_at || swimlanes.getById(task.swimlane_id)?.name !== 'Ready') throw new Error('La tarjeta debe estar en Ready antes de preparar la entrega.');
  if (!task.worktree_path || !task.branch_name) throw new Error('La entrega requiere un worktree y una rama propios de la tarea.');
  const holds = new Set(task.labels.map((label) => label.trim().toLowerCase()));
  if (['manual-hold', 'no-auto', 'needs-info', 'needs-human', 'production'].some((label) => holds.has(label))) throw new Error('Hay una restricción pendiente; revísala antes de preparar la entrega.');
  const report = new TaskCloseoutRepository(getProjectDb(projectId)).get(taskId);
  if (!report || !report.checks.length || report.checks.some((check) => check.result === 'failed')) throw new Error('Falta un informe con checks documentados sin fallos.');
  const preview = await prepareGitDelivery(task.worktree_path, task.branch_name, task.base_branch, report.files);
  if (preview.head !== report.head) throw new Error('HEAD cambió desde el informe. Actualiza la verificación antes de entregar.');
  if (tasks.getById(taskId)?.revision !== task.revision) throw new Error('La tarjeta cambió durante la preparación.');
  return { ...preview, taskId, revision: task.revision, checks: report.checks,
    suggestedMessage: `chore: ${task.title.replace(/[\r\n]/g, ' ').slice(0, 100)}` };
}

function pushTask(context: IpcContext, projectId: string, taskId: string) {
  if (!projectId || !taskId || !context.projectRepo.getById(projectId)) throw new Error('Proyecto o tarjeta no disponibles.');
  const { tasks, swimlanes } = getProjectRepos(context, projectId);
  const task = tasks.getById(taskId);
  if (!task || task.archived_at || !task.worktree_path || !task.branch_name
      || swimlanes.getById(task.swimlane_id)?.name !== 'Ready') throw new Error('Se requiere una tarea Ready con worktree propio.');
  if (task.labels.some((label) => ['manual-hold', 'no-auto', 'needs-info', 'needs-human', 'production'].includes(label.trim().toLowerCase()))) throw new Error('Resuelve la restricción pendiente antes de subir.');
  const report = new TaskCloseoutRepository(getProjectDb(projectId)).get(taskId);
  if (!report || !report.checks.length || report.checks.some((check) => check.result === 'failed')) throw new Error('Falta un informe sin checks fallidos.');
  return task;
}

export async function prepareTaskPush(context: IpcContext, projectId: string, taskId: string): Promise<TaskPushPreview> {
  const task = pushTask(context, projectId, taskId);
  const preview = await prepareGitPush(task.worktree_path!, task.branch_name!, task.base_branch);
  if (pushTask(context, projectId, taskId).revision !== task.revision) throw new Error('La tarjeta cambió durante la preparación.');
  return { ...preview, revision: task.revision };
}

export async function confirmTaskPush(context: IpcContext, projectId: string, taskId: string, revision: number, fingerprint: string) {
  return confirmedResult(await confirmTaskPushOperation(context, projectId, taskId, revision, fingerprint, randomUUID()));
}

export async function confirmTaskPushOperation(context: IpcContext, projectId: string, taskId: string, revision: number, fingerprint: string, operationId: string) {
  if (!Number.isSafeInteger(revision) || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Confirmación inválida.');
  if (!projectId || !taskId || !context.projectRepo.getById(projectId)) throw new Error('Proyecto o tarjeta no disponibles.');
  return withTaskLock(taskId, async () => {
    let task: ReturnType<typeof pushTask>;
    return runDeliveryOperation(getProjectDb(projectId), taskId, operationId, 'push', { revision, fingerprint },
      () => confirmGitPush(task.worktree_path!, task.branch_name!, task.base_branch, fingerprint), async () => {
        task = pushTask(context, projectId, taskId);
        if (task.revision !== revision) throw new Error('La tarjeta cambió; revisa antes de subir.');
        if (context.sessionManager.listManagedSummaries().some((session) => session.projectId === projectId && session.taskId === taskId
            && ['running', 'queued'].includes(session.status))) throw new Error('Detén las sesiones de la tarea antes de subir.');
        const preview = await prepareTaskPush(context, projectId, taskId);
        if (preview.fingerprint !== fingerprint) throw new Error('El destino o el commit cambiaron. Prepara otra vista.');
      });
  });
}

/** Human desktop action only, intentionally not exported as an agent MCP command. */
export async function confirmTaskDelivery(context: IpcContext, projectId: string, taskId: string,
  confirmation: TaskDeliveryConfirmation): Promise<TaskDeliveryCommitResult> {
  return confirmedResult(await confirmTaskDeliveryOperation(context, projectId, taskId, confirmation, randomUUID()));
}

export async function confirmTaskDeliveryOperation(context: IpcContext, projectId: string, taskId: string,
  confirmation: TaskDeliveryConfirmation, operationId: string) {
  if (!confirmation || !Number.isSafeInteger(confirmation.revision)
      || typeof confirmation.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(confirmation.fingerprint)) throw new Error('Confirmación inválida.');
  if (typeof confirmation.message !== 'string' || !confirmation.message.trim() || confirmation.message.length > 500
      || /[\x00-\x1f]/.test(confirmation.message)) throw new Error('Mensaje de commit inválido.');
  if (!projectId || !taskId || !context.projectRepo.getById(projectId)) throw new Error('Proyecto o tarjeta no disponibles.');
  return withTaskLock(taskId, async () => {
    let task: ReturnType<typeof pushTask>;
    let preview: TaskDeliveryPreview;
    return runDeliveryOperation(getProjectDb(projectId), taskId, operationId, 'commit',
      { revision: confirmation.revision, fingerprint: confirmation.fingerprint, message: confirmation.message },
      () => commitGitDelivery(task.worktree_path!, task.branch_name!, task.base_branch,
        preview.files, confirmation.fingerprint, confirmation.message), async () => {
        preview = await prepareTaskDelivery(context, projectId, taskId);
        if (preview.revision !== confirmation.revision || preview.fingerprint !== confirmation.fingerprint) throw new Error('La tarjeta o sus archivos cambiaron. Prepara una nueva entrega.');
        task = getProjectRepos(context, projectId).tasks.getById(taskId)!;
        const active = context.sessionManager.listManagedSummaries().some((session) =>
          session.projectId === projectId && session.taskId === taskId && ['running', 'queued'].includes(session.status));
        if (active) throw new Error('Detén las sesiones de esta tarea antes de crear el commit.');
      });
  });
}

function confirmedResult(operation: TaskDeliveryOperation): TaskDeliveryCommitResult {
  if (operation.status === 'succeeded' && operation.result) return operation.result;
  throw new Error(`${operation.message} Operación: ${operation.id}`);
}
