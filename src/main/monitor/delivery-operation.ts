import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TaskDeliveryCommitResult, TaskDeliveryOperation } from '@kangentic/protocol';
import { TaskDeliveryOperationRepository } from '../db/repositories/task-delivery-operation-repository';

// A running row from an earlier process is uncertain, never automatically resumed.
const processOwner = randomUUID();

export function readDeliveryOperation(database: Database.Database, taskId: string, operationId: string): TaskDeliveryOperation | null {
  return new TaskDeliveryOperationRepository(database, processOwner).get(taskId, operationId);
}

/** Persist before executing. A lost response can be recovered without replaying Git. */
export async function runDeliveryOperation(database: Database.Database, taskId: string, operationId: string,
  kind: 'commit' | 'push', approvedRequest: Record<string, unknown>, execute: () => Promise<TaskDeliveryCommitResult>,
  preflight?: () => Promise<void>): Promise<TaskDeliveryOperation> {
  const repository = new TaskDeliveryOperationRepository(database, processOwner);
  const requestHash = createHash('sha256').update(JSON.stringify(approvedRequest)).digest('hex');
  const existing = repository.findExisting(taskId, operationId, kind, requestHash);
  if (existing) return existing;
  // Read-only rejection before reserving cannot have written Git. Do not create an uncertain hold.
  await preflight?.();
  const reservation = repository.reserve(taskId, operationId, kind, requestHash);
  if (!reservation.created) return reservation.operation;
  try {
    const result = await execute();
    repository.finish(taskId, operationId, result);
  } catch {
    // No retry and no rollback. Even an exception may follow a successful Git write.
    repository.finish(taskId, operationId, null);
  }
  return repository.get(taskId, operationId)!;
}
