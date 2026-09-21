import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const mocks = vi.hoisted(() => ({
  getProjectRepos: vi.fn(),
  getProjectDb: vi.fn(),
  getCloseout: vi.fn(),
  prepareDelivery: vi.fn(),
  commitDelivery: vi.fn(),
  preparePush: vi.fn(),
  confirmPush: vi.fn(),
  runOperation: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: mocks.getProjectRepos }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: mocks.getProjectDb }));
vi.mock('../../src/main/db/repositories/task-closeout-repository', () => ({
  TaskCloseoutRepository: class { get = mocks.getCloseout; },
}));
vi.mock('../../src/main/git/delivery-preview', () => ({ prepareGitDelivery: mocks.prepareDelivery }));
vi.mock('../../src/main/git/delivery-commit', () => ({ commitGitDelivery: mocks.commitDelivery }));
vi.mock('../../src/main/git/delivery-push', () => ({
  prepareGitPush: mocks.preparePush,
  confirmGitPush: mocks.confirmPush,
}));
vi.mock('../../src/main/monitor/delivery-operation', () => ({ runDeliveryOperation: mocks.runOperation }));

import { confirmTaskDelivery, confirmTaskDeliveryOperation, confirmTaskPush, confirmTaskPushOperation, prepareTaskDelivery, prepareTaskPush } from '../../src/main/monitor/task-delivery';

interface DeliveryTask {
  id: string;
  revision: number;
  title: string;
  swimlane_id: string;
  archived_at: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  labels: string[];
}

const report = {
  version: 1 as const,
  taskId: 'task-1',
  summary: 'Ready for delivery.',
  files: ['server.ts'],
  checks: [{ command: 'npx vitest run', result: 'passed' as const, evidence: 'Passed.' }],
  head: 'a'.repeat(40),
  delivery: 'No push.',
  deployment: 'No deployment.',
  nextAction: 'Review.',
};

let task: DeliveryTask;
let taskLookup: () => DeliveryTask | undefined;
let sessionSummaries: Array<{ projectId: string; taskId: string; status: string }>;

function makeTask(overrides: Partial<DeliveryTask> = {}): DeliveryTask {
  return {
    id: 'task-1', revision: 7, title: 'Ship service result', swimlane_id: 'ready', archived_at: null,
    worktree_path: '/worktree/task-1', branch_name: 'task/result', base_branch: 'main', labels: [],
    ...overrides,
  };
}

function context(projectIds = ['project-a']): IpcContext {
  return {
    projectRepo: { getById: (projectId: string) => projectIds.includes(projectId) ? { id: projectId, path: `/projects/${projectId}` } : undefined },
    sessionManager: { listManagedSummaries: () => sessionSummaries },
  } as unknown as IpcContext;
}

function confirmation(overrides: Record<string, unknown> = {}) {
  return { revision: 7, fingerprint: 'b'.repeat(64), message: 'chore: ship result', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  task = makeTask();
  taskLookup = () => task;
  sessionSummaries = [];
  mocks.getProjectDb.mockReturnValue({});
  mocks.getProjectRepos.mockImplementation(() => ({
    tasks: { getById: () => taskLookup() },
    swimlanes: { getById: () => ({ name: 'Ready' }) },
  }));
  mocks.getCloseout.mockReturnValue(report);
  mocks.prepareDelivery.mockResolvedValue({
    branch: 'task/result', head: report.head, files: ['server.ts'], fingerprint: 'b'.repeat(64), otherChangedFiles: [],
  });
  mocks.commitDelivery.mockResolvedValue({ commit: report.head, branch: 'task/result' });
  mocks.preparePush.mockResolvedValue({ branch: 'task/result', head: report.head, destination: '/origin.git', fingerprint: 'c'.repeat(64) });
  mocks.confirmPush.mockResolvedValue({ commit: report.head, branch: 'task/result', destination: '/origin.git' });
  mocks.runOperation.mockImplementation(async (_database: unknown, taskId: string, operationId: string, kind: string,
    _request: Record<string, unknown>, execute: () => Promise<{ commit: string; branch: string }>, preflight?: () => Promise<void>) => {
    await preflight?.();
    const operationResult = await execute();
    return { id: operationId, taskId, kind, status: 'succeeded', result: operationResult, message: 'Operación confirmada y registrada.' };
  });
});

describe('task delivery service', () => {
  it('uses only the explicitly requested project and does not fall back across projects', async () => {
    await expect(prepareTaskDelivery(context(['project-a']), 'project-b', 'task-1')).rejects.toThrow(/Proyecto o tarjeta/i);
    expect(mocks.getProjectRepos).not.toHaveBeenCalled();

    await prepareTaskDelivery(context(), 'project-a', 'task-1');
    expect(mocks.getProjectRepos).toHaveBeenCalledWith(expect.anything(), 'project-a');
    expect(mocks.getProjectDb).toHaveBeenCalledWith('project-a');
  });

  it.each([
    ['held', makeTask({ labels: ['manual-hold'] }), 'Ready'],
    ['archived', makeTask({ archived_at: '2026-01-01T00:00:00.000Z' }), 'Ready'],
    ['not ready', makeTask(), 'Review'],
  ])('denies a %s task before Git preview', async (_kind, deniedTask, laneName) => {
    task = deniedTask;
    mocks.getProjectRepos.mockImplementation(() => ({
      tasks: { getById: () => task }, swimlanes: { getById: () => ({ name: laneName }) },
    }));

    await expect(prepareTaskDelivery(context(), 'project-a', task.id)).rejects.toThrow();
    expect(mocks.prepareDelivery).not.toHaveBeenCalled();
  });

  it('blocks a stale task revision observed while preparing delivery', async () => {
    mocks.prepareDelivery.mockImplementation(async () => {
      task = makeTask({ revision: 8 });
      return { branch: 'task/result', head: report.head, files: ['server.ts'], fingerprint: 'b'.repeat(64), otherChangedFiles: [] };
    });

    await expect(prepareTaskDelivery(context(), 'project-a', 'task-1')).rejects.toThrow(/tarjeta cambió durante la preparación/i);
    expect(mocks.commitDelivery).not.toHaveBeenCalled();
  });

  it('blocks stale confirmation revision or fingerprint before committing', async () => {
    await expect(confirmTaskDelivery(context(), 'project-a', 'task-1', confirmation({ revision: 6 }) as never))
      .rejects.toThrow(/archivos cambiaron/i);
    await expect(confirmTaskDelivery(context(), 'project-a', 'task-1', confirmation({ fingerprint: 'c'.repeat(64) }) as never))
      .rejects.toThrow(/archivos cambiaron/i);
    expect(mocks.commitDelivery).not.toHaveBeenCalled();
  });

  it('runs read-only preflight before delivery execution and exposes the stable operation id', async () => {
    await expect(confirmTaskDeliveryOperation(context(), 'project-a', 'task-1', confirmation() as never, 'operation-000001'))
      .resolves.toMatchObject({ id: 'operation-000001', status: 'succeeded' });
    expect(mocks.prepareDelivery).toHaveBeenCalledOnce();
    expect(mocks.commitDelivery).toHaveBeenCalledOnce();
  });

  it.each(['running', 'queued'])('blocks a %s primary or auxiliary task session before committing or pushing', async (status) => {
    sessionSummaries = [
      { projectId: 'project-a', taskId: 'task-1', status },
      { projectId: 'project-a', taskId: 'task-1', status: 'suspended' },
    ];

    await expect(confirmTaskDelivery(context(), 'project-a', 'task-1', confirmation() as never)).rejects.toThrow(/sesiones/i);
    await expect(confirmTaskPush(context(), 'project-a', 'task-1', 7, 'c'.repeat(64))).rejects.toThrow(/sesiones/i);
    expect(mocks.commitDelivery).not.toHaveBeenCalled();
    expect(mocks.confirmPush).not.toHaveBeenCalled();
  });

  it('commits only server-derived preview files, never arbitrary renderer confirmation fields', async () => {
    await expect(confirmTaskDelivery(context(), 'project-a', 'task-1', confirmation({ files: ['renderer-arbitrary.ts'] }) as never))
      .resolves.toEqual({ commit: report.head, branch: 'task/result' });

    expect(mocks.commitDelivery).toHaveBeenCalledWith(
      '/worktree/task-1', 'task/result', 'main', ['server.ts'], 'b'.repeat(64), 'chore: ship result',
    );
  });

  it('blocks a stale revision observed during push preview', async () => {
    mocks.preparePush.mockImplementation(async () => {
      task = makeTask({ revision: 8 });
      return { branch: 'task/result', head: report.head, destination: '/origin.git', fingerprint: 'c'.repeat(64) };
    });

    await expect(prepareTaskPush(context(), 'project-a', 'task-1')).rejects.toThrow(/tarjeta cambió durante la preparación/i);
    expect(mocks.confirmPush).not.toHaveBeenCalled();
  });

  it('uses the stable push operation id and executes Git only after preflight', async () => {
    await expect(confirmTaskPushOperation(context(), 'project-a', 'task-1', 7, 'c'.repeat(64), 'operation-000002'))
      .resolves.toMatchObject({ id: 'operation-000002', status: 'succeeded' });
    expect(mocks.preparePush).toHaveBeenCalledOnce();
    expect(mocks.confirmPush).toHaveBeenCalledOnce();
  });
});
