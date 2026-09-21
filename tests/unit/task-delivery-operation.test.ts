import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskDeliveryOperationRepository } from '../../src/main/db/repositories/task-delivery-operation-repository';
import { readDeliveryOperation, runDeliveryOperation } from '../../src/main/monitor/delivery-operation';

let database: Database.Database;
const operationId = 'operation-000001';
const result = { commit: 'a'.repeat(40), branch: 'task/delivery' };

function requestHash(request: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function insertTask(id: string): void {
  const swimlane = database.prepare('SELECT id FROM swimlanes ORDER BY position LIMIT 1').get() as { id: string };
  database.prepare(`INSERT INTO tasks (id, revision, title, description, swimlane_id, position, created_at, updated_at)
    VALUES (?, 0, ?, '', ?, 0, ?, ?)`).run(id, `Task ${id}`, swimlane.id, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
}

beforeEach(() => {
  database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runProjectMigrations(database);
  runProjectMigrations(database);
  insertTask('task-a');
  insertTask('task-b');
});

afterEach(() => database.close());

describe('durable task delivery operations', () => {
  it('executes an approved request once and returns the persisted success for the same operation id', async () => {
    let executions = 0;
    const first = await runDeliveryOperation(database, 'task-a', operationId, 'commit', { fingerprint: 'a'.repeat(64) }, async () => {
      executions += 1;
      return result;
    });
    const repeated = await runDeliveryOperation(database, 'task-a', operationId, 'commit', { fingerprint: 'a'.repeat(64) }, async () => {
      executions += 1;
      return result;
    });

    expect(executions).toBe(1);
    expect(first).toMatchObject({ id: operationId, taskId: 'task-a', status: 'succeeded', result });
    expect(repeated).toEqual(first);
  });

  it('does not reserve an operation when read-only preflight rejects', async () => {
    let executions = 0;

    await expect(runDeliveryOperation(database, 'task-a', operationId, 'commit', { fingerprint: 'a'.repeat(64) }, async () => {
      executions += 1;
      return result;
    }, async () => { throw new Error('Preview is stale'); })).rejects.toThrow('Preview is stale');

    expect(executions).toBe(0);
    expect(readDeliveryOperation(database, 'task-a', operationId)).toBeNull();
  });

  it('returns a completed duplicate before an obsolete preflight or execute can rerun', async () => {
    const request = { fingerprint: 'a'.repeat(64) };
    const first = await runDeliveryOperation(database, 'task-a', operationId, 'commit', request, async () => result);
    let executions = 0;

    const duplicate = await runDeliveryOperation(database, 'task-a', operationId, 'commit', request, async () => {
      executions += 1;
      return result;
    }, async () => { throw new Error('Old preview must not be read'); });

    expect(duplicate).toEqual(first);
    expect(executions).toBe(0);
  });

  it('rejects a different payload under the same operation id', async () => {
    await runDeliveryOperation(database, 'task-a', operationId, 'commit', { fingerprint: 'a'.repeat(64) }, async () => result);

    await expect(runDeliveryOperation(database, 'task-a', operationId, 'commit', { fingerprint: 'b'.repeat(64) }, async () => result))
      .rejects.toThrow(/identidad de operación/i);
  });

  it('deduplicates a new id with the same approved request to the original operation', async () => {
    const request = { fingerprint: 'a'.repeat(64), revision: 2 };
    const first = await runDeliveryOperation(database, 'task-a', operationId, 'push', request, async () => result);
    let executions = 0;
    const duplicate = await runDeliveryOperation(database, 'task-a', 'operation-000002', 'push', request, async () => {
      executions += 1;
      return result;
    });

    expect(duplicate.id).toBe(first.id);
    expect(executions).toBe(0);
  });

  it('does not leak operations across task scopes', async () => {
    await runDeliveryOperation(database, 'task-a', operationId, 'commit', { fingerprint: 'a'.repeat(64) }, async () => result);

    expect(readDeliveryOperation(database, 'task-b', operationId)).toBeNull();
    const taskB = await runDeliveryOperation(database, 'task-b', 'operation-000002', 'commit', { fingerprint: 'a'.repeat(64) }, async () => result);
    expect(taskB).toMatchObject({ taskId: 'task-b', status: 'succeeded' });
  });

  it('runs concurrent calls for one request only once', async () => {
    let release!: () => void;
    const execution = new Promise<void>((resolve) => { release = resolve; });
    let executions = 0;
    const first = runDeliveryOperation(database, 'task-a', operationId, 'commit', { fingerprint: 'a'.repeat(64) }, async () => {
      executions += 1;
      await execution;
      return result;
    });
    const second = runDeliveryOperation(database, 'task-a', operationId, 'commit', { fingerprint: 'a'.repeat(64) }, async () => {
      executions += 1;
      return result;
    });
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(executions).toBe(1);
    expect(firstResult.status).toBe('succeeded');
    expect(secondResult).toMatchObject({ id: operationId, status: 'running' });
  });

  it('records a failed execution as uncertain and never retries it', async () => {
    let executions = 0;
    const failed = await runDeliveryOperation(database, 'task-a', operationId, 'commit', { fingerprint: 'a'.repeat(64) }, async () => {
      executions += 1;
      throw new Error('Git connection lost');
    });
    const repeated = await runDeliveryOperation(database, 'task-a', operationId, 'commit', { fingerprint: 'a'.repeat(64) }, async () => {
      executions += 1;
      return result;
    });

    expect(failed.status).toBe('uncertain');
    expect(repeated.status).toBe('uncertain');
    expect(executions).toBe(1);
  });

  it('treats an operation owned by an earlier process as uncertain', () => {
    const request = { fingerprint: 'a'.repeat(64) };
    const originalOwner = new TaskDeliveryOperationRepository(database, 'previous-process');
    originalOwner.reserve('task-a', operationId, 'commit', requestHash(request));

    const afterRestart = new TaskDeliveryOperationRepository(database, 'current-process').get('task-a', operationId);
    expect(afterRestart).toMatchObject({ status: 'uncertain', message: expect.stringMatching(/no se reintentará/i) });
  });

  it('retains operations after archive and deletes them through the task foreign-key cascade', async () => {
    await runDeliveryOperation(database, 'task-a', operationId, 'commit', { fingerprint: 'a'.repeat(64) }, async () => result);
    database.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', 'task-a');

    expect(readDeliveryOperation(database, 'task-a', operationId)).toMatchObject({ status: 'succeeded' });
    database.prepare('DELETE FROM tasks WHERE id = ?').run('task-a');
    expect(readDeliveryOperation(database, 'task-a', operationId)).toBeNull();
  });
});
