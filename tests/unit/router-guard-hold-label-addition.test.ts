/**
 * A guarded task accepts one agent mutation: adding hold labels and nothing
 * else, so the router can mark a PROD-held card para-ck (0.42.0-luuk.2).
 * Same repository-mock harness as mcp-update-task-description-edits.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be registered before the import under test
// ---------------------------------------------------------------------------

const {
  mockTaskRepoUpdate,
  mockTaskRepoGetById,
  mockTaskRepoGetByDisplayId,
} = vi.hoisted(() => ({
  mockTaskRepoUpdate: vi.fn(),
  mockTaskRepoGetById: vi.fn(),
  mockTaskRepoGetByDisplayId: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    update = mockTaskRepoUpdate;
    getById = mockTaskRepoGetById;
    getByDisplayId = mockTaskRepoGetByDisplayId;
  },
}));

vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class {
    add = vi.fn();
    getById = vi.fn();
    remove = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({
  BacklogAttachmentRepository: class {
    getById = vi.fn();
    remove = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/attachment-utils', () => ({
  readFileAsAttachment: vi.fn(),
}));

// Defensive: transitively imported by task-commands.ts but unused by the
// handler under test here.
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {},
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPRForTask: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { handleUpdateTask, isHoldOnlyLabelAddition } from '../../src/main/agent/commands/task-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

function makeContext(): CommandContext {
  return {
    getProjectDb: vi.fn(() => ({}) as never),
    getProjectPath: vi.fn(() => '/mock/project'),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn(async () => {}),
    onTasksReordered: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
  };
}

/** The MCP tool forwards every omitted field as an explicit null. */
function params(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    taskId: 'task-32',
    title: null,
    description: null,
    descriptionEdits: null,
    appendDescription: null,
    prUrl: null,
    prNumber: null,
    agent: null,
    priority: null,
    labels: null,
    baseBranch: null,
    useWorktree: null,
    model: undefined,
    effort: undefined,
    permissionMode: undefined,
    profile: undefined,
    runMode: undefined,
    attachments: null,
    ...overrides,
  };
}

const HELD_TASK = {
  id: 'task-32',
  display_id: 32,
  title: '[Pedro] Cobranza PROD',
  description: 'Requiere producción: sí',
  labels: ['production', 'approved'],
  attachment_count: 0,
};

const REFUSAL = 'Agents may not mutate a held or sensitive task; human action is required';

describe('a guarded task accepts an agent update that only ADDS hold labels (0.42.0-luuk.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskRepoGetById.mockReturnValue({ ...HELD_TASK });
    mockTaskRepoUpdate.mockImplementation((updates: Record<string, unknown>) => ({ ...HELD_TASK, ...updates }));
  });

  it('adding para-ck to a production card passes and writes only the labels', async () => {
    const result = await handleUpdateTask(params({ labels: ['production', 'approved', 'para-ck'] }), makeContext());

    expect(result.success).toBe(true);
    expect(mockTaskRepoUpdate).toHaveBeenCalledTimes(1);
    const updates = mockTaskRepoUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(updates.labels).toEqual(['production', 'approved', 'para-ck']);
    expect(Object.keys(updates).sort()).toEqual(['id', 'labels']);
  });

  it('removing production in the same call is refused', async () => {
    const result = await handleUpdateTask(params({ labels: ['approved', 'para-ck'] }), makeContext());
    expect(result).toEqual({ success: false, error: REFUSAL });
    expect(mockTaskRepoUpdate).not.toHaveBeenCalled();
  });

  it('adding go-ck is refused', async () => {
    const result = await handleUpdateTask(params({ labels: ['production', 'approved', 'para-ck', 'go-ck'] }), makeContext());
    expect(result.success).toBe(false);
    expect(mockTaskRepoUpdate).not.toHaveBeenCalled();
  });

  it('changing the description in the same call is refused', async () => {
    const result = await handleUpdateTask(
      params({ labels: ['production', 'approved', 'para-ck'], appendDescription: '\nnota' }),
      makeContext(),
    );
    expect(result).toEqual({ success: false, error: REFUSAL });
    expect(mockTaskRepoUpdate).not.toHaveBeenCalled();
  });

  it('a description-only change stays refused, as before', async () => {
    const result = await handleUpdateTask(params({ description: 'otra cosa' }), makeContext());
    expect(result).toEqual({ success: false, error: REFUSAL });
  });
});

describe('isHoldOnlyLabelAddition', () => {
  it('accepts every hold label, case- and space-insensitively, and keeps existing ones', () => {
    for (const label of ['para-ck', 'needs-human', 'manual-hold', 'no-auto', 'needs-info']) {
      expect(isHoldOnlyLabelAddition({ taskId: 't', labels: ['Production', ` ${label.toUpperCase()} `] }, ['production'])).toBe(true);
    }
  });

  it('refuses a no-op, a non-hold label, approved and a setting change', () => {
    expect(isHoldOnlyLabelAddition({ taskId: 't', labels: ['production'] }, ['production'])).toBe(false);
    expect(isHoldOnlyLabelAddition({ taskId: 't', labels: ['production', 'risky'] }, ['production'])).toBe(false);
    expect(isHoldOnlyLabelAddition({ taskId: 't', labels: ['production', 'approved'] }, ['production'])).toBe(false);
    expect(isHoldOnlyLabelAddition({ taskId: 't', labels: ['production', 'para-ck'], model: null }, ['production'])).toBe(false);
    expect(isHoldOnlyLabelAddition({ taskId: 't', labels: ['production', 'para-ck'], priority: 2 }, ['production'])).toBe(false);
  });
});
