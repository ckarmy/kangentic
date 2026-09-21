import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { Task } from '../../src/shared/types';

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  getByDisplayId: vi.fn(),
  save: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = mocks.getById;
    getByDisplayId = mocks.getByDisplayId;
  },
}));

vi.mock('../../src/main/db/repositories/task-closeout-repository', () => ({
  TaskCloseoutRepository: class {
    save = mocks.save;
  },
}));

vi.mock('../../src/main/agent/commands/task-commands', () => ({
  routerTaskHeld: (labels: string[]) => {
    const approved = labels.includes('approved');
    return labels.some((label) => ['pedro', 'no-auto', 'manual-hold', 'production', 'risky', 'needs-info', 'needs-human'].includes(label)
      && (label !== 'pedro' || !approved));
  },
}));

import { handleGetTaskResult, handleRecordTaskResult } from '../../src/main/agent/commands/task-result';

const taskId = 'task-1';
const report = {
  version: 1,
  taskId,
  summary: 'Implemented the requested behavior.',
  files: ['src/main/agent/commands/task-result.ts'],
  checks: [{ command: 'npx vitest run tests/unit/task-result.test.ts', result: 'passed' as const, evidence: '8 tests passed' }],
  head: 'a'.repeat(40),
  delivery: 'No push performed.',
  deployment: 'No deployment performed.',
  nextAction: 'Human review.',
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId,
    revision: 4,
    display_id: 12,
    title: 'Record task outcome',
    description: 'Persist agent-declared evidence.',
    swimlane_id: 'testing',
    position: 0,
    agent: 'codex',
    session_id: null,
    worktree_path: null,
    worktree_folder: null,
    worktree_skip_reason: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    pr_merge_readiness: null,
    head_sha: null,
    pushed_branch: null,
    external_id: null,
    external_source: null,
    external_url: null,
    base_branch: null,
    resolved_base_branch: null,
    labels: [],
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

function makeContext(actor?: 'agent' | 'human'): CommandContext {
  const database = {
    transaction: (callback: () => unknown) => mocks.transaction(callback),
  };
  return {
    actor,
    projectId: 'project-1',
    getProjectDb: () => database,
  } as CommandContext;
}

function record(params: Record<string, unknown>, actor?: 'agent' | 'human') {
  return handleRecordTaskResult(params, makeContext(actor));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation((callback: () => unknown) => () => callback());
  mocks.getByDisplayId.mockReturnValue(undefined);
  mocks.getById.mockReturnValue(makeTask());
});

describe('handleRecordTaskResult', () => {
  it('persists a valid declaration without mutating the task stage or revision', () => {
    const task = makeTask({ swimlane_id: 'testing', revision: 4 });
    mocks.getById.mockReturnValue(task);

    const result = record({ taskId, expectedRevision: 4, report: JSON.stringify(report) });

    expect(result).toEqual({
      success: true,
      data: { taskId, recorded: true, verified: false },
      message: 'Result recorded as agent-declared evidence. No stage, approval, push or deployment was performed.',
    });
    expect(mocks.save).toHaveBeenCalledWith(taskId, 4, report);
    expect(task.swimlane_id).toBe('testing');
    expect(task.revision).toBe(4);
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it('rejects malformed and oversized reports before persistence', () => {
    const malformed = record({ taskId, expectedRevision: 4, report: '{not json' });
    const oversized = record({ taskId, expectedRevision: 4, report: 'x'.repeat(64 * 1024 + 1) });
    const negativeRevision = record({ taskId, expectedRevision: -1, report: JSON.stringify(report) });

    expect(malformed).toEqual({ success: false, error: 'Invalid result schema or task identity. See the task-closeout report schema.' });
    expect(oversized).toEqual({ success: false, error: 'taskId, expectedRevision and a JSON report up to 64 KB are required' });
    expect(negativeRevision).toEqual({ success: false, error: 'taskId, expectedRevision and a JSON report up to 64 KB are required' });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('rejects a report whose declared task identity differs from the resolved task', () => {
    const result = record({ taskId, expectedRevision: 4, report: JSON.stringify({ ...report, taskId: 'other-task' }) });

    expect(result).toEqual({ success: false, error: 'Invalid result schema or task identity. See the task-closeout report schema.' });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('rejects a stale expected revision without parsing or saving the report', () => {
    const result = record({ taskId, expectedRevision: 3, report: JSON.stringify(report) });

    expect(result).toEqual({ success: false, error: 'Task changed. Refresh before recording the result.' });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['archived', makeTask({ archived_at: '2026-01-02T00:00:00.000Z' })],
  ])('rejects a %s task', (_kind, task) => {
    mocks.getById.mockReturnValue(task);

    const result = record({ taskId, expectedRevision: 4, report: JSON.stringify(report) });

    expect(result).toEqual({ success: false, error: 'Task is missing or archived' });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([
    ['agent', 'agent' as const],
    ['omitted actor', undefined],
  ])('refuses held tasks for %s context even when params forge a human actor', (_kind, actor) => {
    mocks.getById.mockReturnValue(makeTask({ labels: [' manual-hold '] }));

    const result = record({ taskId, expectedRevision: 4, report: JSON.stringify(report), actor: 'human' }, actor);

    expect(result).toEqual({ success: false, error: 'Human action is required for a held task' });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('allows a human transport context to record a held task result', () => {
    mocks.getById.mockReturnValue(makeTask({ labels: ['needs-human'] }));

    const result = record({ taskId, expectedRevision: 4, report: JSON.stringify(report) }, 'human');

    expect(result).toMatchObject({ success: true, data: { taskId, recorded: true } });
    expect(mocks.save).toHaveBeenCalledOnce();
  });
});

describe('handleGetTaskResult', () => {
  it('delegates the requested task to the bound project reader', async () => {
    const readTaskResult = vi.fn(async () => ({ state: 'missing' as const, message: 'No result.' }));
    const context = { ...makeContext(), readTaskResult };

    await expect(handleGetTaskResult({ taskId }, context)).resolves.toEqual({
      success: true,
      data: { state: 'missing', message: 'No result.' },
    });
    expect(readTaskResult).toHaveBeenCalledWith(taskId);
  });

  it.each([{}, { taskId: '' }, { taskId: '   ' }, { taskId: 4 }])('requires a non-empty taskId', async (params) => {
    const readTaskResult = vi.fn();

    await expect(handleGetTaskResult(params, { ...makeContext(), readTaskResult })).resolves.toEqual({
      success: false,
      error: 'taskId is required',
    });
    expect(readTaskResult).not.toHaveBeenCalled();
  });

  it('refuses when this transport does not provide a task-result reader', async () => {
    await expect(handleGetTaskResult({ taskId }, makeContext())).resolves.toEqual({
      success: false,
      error: 'Task result reader is unavailable',
    });
  });
});
