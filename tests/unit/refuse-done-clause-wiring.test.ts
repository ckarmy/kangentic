/**
 * Handler-level wiring for resolveColumn's `refuseDone` option.
 *
 * column-resolver.ts's own tests (column-resolver-done-modes.test.ts) prove
 * the MECHANISM: given a `refuseDone` clause, resolveColumn folds it into a
 * refusal message. But those tests pass the clause string in as an argument
 * themselves, so they are tautological about which handler is calling it or
 * what it actually passes. Nothing asserts that handlePromoteBacklog and
 * handleMoveTaskToProject each thread their OWN clause through - a dropped
 * `{ refuseDone: ... }` options object at either call site still compiles
 * (the option is optional) and silently regresses that handler to the bare
 * "Column \"Done\" not found" message, which flatly contradicts
 * kangentic_list_columns once it started printing Done.
 *
 * Strategy: mock only the repositories (SwimlaneRepository, TaskRepository,
 * AttachmentRepository, SessionRepository, BacklogRepository,
 * BacklogAttachmentRepository) so no better-sqlite3 binary is needed - but
 * deliberately do NOT mock column-resolver. The real resolveColumn runs
 * against a mocked SwimlaneRepository.list() that includes a genuine Done
 * lane, so the assertions are on the handler's actual returned refusal text,
 * not on a mock's recorded call arguments.
 *
 * A third handler, handleCreateTask, carries its own refuseDone clause
 * (task-commands.ts) and is the primary one: it is the tool whose schema
 * description names the done-role column, and the handler in the bug this
 * whole change is about. Its only other coverage is
 * mcp-move-task-to-done.test.ts, which is describe.runIf(CAN_RUN) against a
 * real better-sqlite3 DB and skips on this machine (the ABI does not load
 * under vitest), so without a test here a dropped `{ refuseDone: ... }` at
 * that call site stays green in every locally-runnable suite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted-by-position mocks - registered before the import under test.
// Mirrors backlog-update-delete-handlers.test.ts / backlog-promote-abort.test.ts,
// which use this same "plain const above its vi.mock" ordering successfully.
// ---------------------------------------------------------------------------

const mockSwimlaneRepoList = vi.fn();
const mockSwimlaneRepoGetById = vi.fn();
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = mockSwimlaneRepoList;
    getById = mockSwimlaneRepoGetById;
  },
}));

const mockTaskRepoGetById = vi.fn();
const mockTaskRepoCreate = vi.fn();
const mockTaskRepoDelete = vi.fn();
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = mockTaskRepoGetById;
    create = mockTaskRepoCreate;
    delete = mockTaskRepoDelete;
  },
}));

const mockAttachmentRepoList = vi.fn(() => []);
const mockAttachmentRepoAdd = vi.fn();
const mockAttachmentRepoDeleteByTaskId = vi.fn();
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class {
    list = mockAttachmentRepoList;
    add = mockAttachmentRepoAdd;
    deleteByTaskId = mockAttachmentRepoDeleteByTaskId;
  },
}));

const mockSessionRepoDeleteByTaskId = vi.fn();
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    deleteByTaskId = mockSessionRepoDeleteByTaskId;
  },
}));

const mockBacklogRepoGetById = vi.fn();
vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {
    getById = mockBacklogRepoGetById;
  },
}));

const mockBacklogAttachmentRepoList = vi.fn(() => []);
const mockBacklogAttachmentRepoDeleteByTaskId = vi.fn();
vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({
  BacklogAttachmentRepository: class {
    list = mockBacklogAttachmentRepoList;
    deleteByTaskId = mockBacklogAttachmentRepoDeleteByTaskId;
  },
}));

vi.mock('../../src/main/db/repositories/attachment-utils', () => ({
  readFileAsAttachment: vi.fn(),
}));

vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPRForTask: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered). column-resolver is
// deliberately real.
// ---------------------------------------------------------------------------

import { handleMoveTaskToProject, handleCreateTask } from '../../src/main/agent/commands/task-commands';
import { handlePromoteBacklog } from '../../src/main/agent/commands/backlog-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TODO_LANE = { id: 'lane-todo', name: 'To Do', role: 'todo', is_archived: 0 };
const MERGE_LANE = { id: 'lane-merge', name: 'Merge', role: null, is_archived: 0 };
const DONE_LANE = { id: 'lane-done', name: 'Done', role: 'done', is_archived: 1 };

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
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
    ...overrides,
  } as unknown as CommandContext;
}

// ---------------------------------------------------------------------------
// handleMoveTaskToProject
// ---------------------------------------------------------------------------

describe('handleMoveTaskToProject refuseDone wiring', () => {
  let source: CommandContext;
  let target: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSwimlaneRepoList.mockReturnValue([TODO_LANE, MERGE_LANE, DONE_LANE]);
    // The source-swimlane role check reads SwimlaneRepository.getById directly
    // (not through resolveColumn) - a todo-role lane lets that guard pass.
    mockSwimlaneRepoGetById.mockReturnValue({ id: 'lane-todo-src', name: 'To Do', role: 'todo', is_archived: 0 });
    mockTaskRepoGetById.mockReturnValue({
      id: 'task-1',
      display_id: 7,
      title: 'Relocate me',
      description: '',
      swimlane_id: 'lane-todo-src',
      session_id: null,
      worktree_path: null,
    });
    source = makeContext();
    target = makeContext();
  });

  it('refuses a named Done target with its own clause, not a bare "not found"', () => {
    const response = handleMoveTaskToProject({ taskId: 'task-1', column: 'Done' }, source, target);

    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error).toContain('a relocated task cannot land there');
      expect(response.error).not.toContain('not found');
      expect(response.error).toContain('kangentic_move_task');
    }
    // The refusal must stop the handler before it creates anything.
    expect(mockTaskRepoCreate).not.toHaveBeenCalled();
    expect(source.onTaskDeleted).not.toHaveBeenCalled();
  });

  it('refuses a non-To Do target so project relocation cannot bypass routing', () => {

    const response = handleMoveTaskToProject({ taskId: 'task-1', column: 'Merge' }, source, target);

    expect(response.success).toBe(false);
    expect(response.error).toContain('To Do');
    expect(mockTaskRepoCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handlePromoteBacklog
// ---------------------------------------------------------------------------

describe('handlePromoteBacklog refuseDone wiring', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSwimlaneRepoList.mockReturnValue([TODO_LANE, MERGE_LANE, DONE_LANE]);
    mockBacklogRepoGetById.mockReturnValue(undefined);
    context = makeContext();
  });

  it('refuses a named Done target with its own clause, not a bare "not found"', () => {
    const result = handlePromoteBacklog({ itemIds: ['item-1'], column: 'Done' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('a backlog item cannot be promoted straight there');
    expect(result.error).not.toContain('not found');
    expect(result.error).toContain('kangentic_move_task');
  });

  it('refuses a non-To Do target so backlog promotion cannot bypass routing', () => {
    const result = handlePromoteBacklog({ itemIds: ['missing-item'], column: 'Merge' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('only to Draft or To Do');
  });
});

// ---------------------------------------------------------------------------
// handleCreateTask
// ---------------------------------------------------------------------------

describe('handleCreateTask refuseDone wiring', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSwimlaneRepoList.mockReturnValue([TODO_LANE, MERGE_LANE, DONE_LANE]);
    context = makeContext();
  });

  it('refuses a named Done target with its own clause, not a bare "not found"', async () => {
    const response = await handleCreateTask({ title: 'New task', column: 'Done' }, context);

    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error).toContain('a task cannot be created there');
      expect(response.error).not.toContain('not found');
      expect(response.error).toContain('kangentic_move_task');
    }
    // The refusal must stop the handler before it creates anything.
    expect(mockTaskRepoCreate).not.toHaveBeenCalled();
    expect(context.onTaskCreated).not.toHaveBeenCalled();
  });

  it('refuses creating directly in an active workflow column', async () => {

    const response = await handleCreateTask({ title: 'New task', column: 'Merge' }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('only in Draft or To Do');
    expect(mockTaskRepoCreate).not.toHaveBeenCalled();
  });
});
