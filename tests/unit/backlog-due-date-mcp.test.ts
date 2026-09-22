/**
 * Backlog items with a due date and external metadata, created and edited
 * from MCP (0.42.0-luuk.2), so the router can stage dated work without
 * touching the board.
 *
 * The handler tests run against a real in-memory better-sqlite3 DB with the
 * production schema, so the SQL is exercised too. They skip cleanly where the
 * native module cannot load (plain Node); run them under Electron's Node.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import {
  handleCreateBacklogTask,
  handleListBacklog,
  handleUpdateBacklogItem,
  handlePromoteBacklog,
  isDraftColumn,
  sortBacklogByDueDate,
  validateDueDate,
  validateExternalMetadata,
} from '../../src/main/agent/commands/backlog-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

function probeBetterSqlite3(): typeof DatabaseType | null {
  try {
    const moduleName = 'better-sqlite3';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nativeModule = require(moduleName) as unknown;
    const databaseConstructor = (
      (nativeModule as { default?: typeof DatabaseType }).default ?? nativeModule
    ) as typeof DatabaseType;
    const probeHandle = new databaseConstructor(':memory:');
    probeHandle.close();
    return databaseConstructor;
  } catch {
    return null;
  }
}

const Database = probeBetterSqlite3();
const CAN_RUN = Database !== null;

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';

describe('backlog due-date helpers', () => {
  it('accepts only real YYYY-MM-DD dates', () => {
    expect(validateDueDate('2026-09-30')).toBeNull();
    expect(validateDueDate('2026-02-30')).toContain('not a real calendar date');
    expect(validateDueDate('30-09-2026')).toContain('YYYY-MM-DD');
    expect(validateDueDate(20260930)).toContain('YYYY-MM-DD');
  });

  it('accepts a JSON object under the cap, nothing else', () => {
    expect(validateExternalMetadata({ trello: 'abc', n: 1 })).toBeNull();
    expect(validateExternalMetadata(['a'])).toContain('JSON object');
    expect(validateExternalMetadata('x')).toContain('JSON object');
    expect(validateExternalMetadata({ big: 'x'.repeat(20_000) })).toContain('exceeds');
  });

  it('orders soonest first, undated last, stable otherwise', () => {
    const ordered = sortBacklogByDueDate([
      { id: 'a', due_date: null },
      { id: 'b', due_date: '2026-10-05' },
      { id: 'c', due_date: '2026-09-25' },
      { id: 'd', due_date: null },
      { id: 'e', due_date: '2026-09-25' },
    ]);
    expect(ordered.map((item) => item.id)).toEqual(['c', 'e', 'b', 'a', 'd']);
  });

  it('a Draft column is agentless, roleless and named like one; Ready is not', () => {
    expect(isDraftColumn({ name: 'Draft', role: null, auto_spawn: false })).toBe(true);
    expect(isDraftColumn({ name: 'Ready', role: null, auto_spawn: false })).toBe(false);
    expect(isDraftColumn({ name: 'Draft', role: null, auto_spawn: true })).toBe(false);
    expect(isDraftColumn({ name: 'Approved', role: 'todo', auto_spawn: false })).toBe(false);
  });
});

describe.runIf(CAN_RUN)('backlog MCP handlers with due dates (real DB)', () => {
  let db: DatabaseType.Database;
  let context: CommandContext;

  beforeEach(() => {
    db = new Database!(':memory:');
    runProjectMigrations(db);
    db.prepare("DELETE FROM swimlanes").run();
    const insertLane = db.prepare(`INSERT INTO swimlanes (id, name, role, position, color, auto_spawn, created_at)
      VALUES (?, ?, ?, ?, '#888', ?, '2026-01-01T00:00:00Z')`);
    insertLane.run('lane-draft', 'Draft', null, 0, 0);
    insertLane.run('lane-approved', 'Approved', 'todo', 1, 0);
    insertLane.run('lane-exec', 'Executing', null, 2, 1);
    insertLane.run('lane-done', 'Done', 'done', 3, 0);
    context = {
      getProjectDb: () => db,
      getProjectPath: () => '/mock/project',
      onBacklogChanged: vi.fn(),
      onLabelColorsChanged: vi.fn(),
      onTaskCreated: vi.fn(),
      onTaskUpdated: vi.fn(),
      onTaskDeleted: vi.fn(),
      onTaskMove: vi.fn(async () => {}),
      onTasksReordered: vi.fn(),
      onSwimlaneUpdated: vi.fn(),
      onSwimlaneDeleted: vi.fn(),
    } as unknown as CommandContext;
  });

  afterEach(() => {
    db.close();
  });

  const create = (params: Record<string, unknown>) => handleCreateBacklogTask(params, context);

  it('creates an item with dueDate, assignee and externalMetadata and returns its id', async () => {
    const result = await create({
      title: 'Cobrar a Estafeta', description: 'D-2', priority: 3, labels: ['cobranza'],
      dueDate: '2026-09-30', assignee: 'CK', externalMetadata: { source: 'router', ref: 'k13' },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(typeof data.id).toBe('string');
    expect(data).toMatchObject({
      title: 'Cobrar a Estafeta', dueDate: '2026-09-30', assignee: 'CK',
      externalMetadata: { source: 'router', ref: 'k13' }, priority: 'High', priorityValue: 3,
    });
  });

  it('refuses an invalid dueDate and the approved label', async () => {
    expect((await create({ title: 'x', dueDate: '2026-13-01' })).success).toBe(false);
    expect((await create({ title: 'x', labels: ['approved'] })).success).toBe(false);
  });

  it('lists as JSON ordered by due date, with the dueOnOrBefore filter', async () => {
    await create({ title: 'undated' });
    await create({ title: 'late', dueDate: '2026-10-10' });
    await create({ title: 'soon', dueDate: '2026-09-24', externalMetadata: { k: 1 } });

    const all = await handleListBacklog({ priority: null, query: null }, context);
    const rows = all.data as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.title)).toEqual(['soon', 'late', 'undated']);
    expect(rows[0]).toMatchObject({ dueDate: '2026-09-24', externalMetadata: { k: 1 }, labels: [] });
    expect(rows[2]).toMatchObject({ dueDate: null, externalMetadata: null });

    const due = await handleListBacklog({ priority: null, query: null, dueOnOrBefore: '2026-09-30' }, context);
    expect((due.data as Array<Record<string, unknown>>).map((row) => row.title)).toEqual(['soon']);

    expect((await handleListBacklog({ dueOnOrBefore: 'mañana' }, context)).success).toBe(false);
  });

  it('updates dueDate and externalMetadata, and null clears them', async () => {
    const created = await create({ title: 'item', dueDate: '2026-09-24', externalMetadata: { a: 1 } });
    const itemId = (created.data as { id: string }).id;

    const moved = await handleUpdateBacklogItem({ itemId, dueDate: '2026-10-01', externalMetadata: { b: 2 } }, context);
    expect(moved.success).toBe(true);
    expect(moved.data).toMatchObject({ dueDate: '2026-10-01', externalMetadata: { b: 2 } });

    const cleared = await handleUpdateBacklogItem({ itemId, dueDate: null, externalMetadata: null }, context);
    expect(cleared.data).toMatchObject({ dueDate: null, externalMetadata: null });

    const untouched = await handleUpdateBacklogItem({ itemId, title: 'renamed' }, context);
    expect(untouched.data).toMatchObject({ title: 'renamed', dueDate: null });
  });

  it('promotes to Draft (even protected work), still refuses an agent column', async () => {
    const protectedItem = await create({ title: 'prod work', labels: ['production'] });
    const itemId = (protectedItem.data as { id: string }).id;

    const toExec = await handlePromoteBacklog({ itemIds: [itemId], column: 'Executing' }, context);
    expect(toExec.success).toBe(false);
    const toApproved = await handlePromoteBacklog({ itemIds: [itemId], column: 'Approved' }, context);
    expect(toApproved.success).toBe(false);

    const toDraft = await handlePromoteBacklog({ itemIds: [itemId], column: 'Draft' }, context);
    expect(toDraft.success).toBe(true);
    expect((toDraft.data as { targetColumn: string }).targetColumn).toBe('Draft');
  });
});

describe.runIf(!CAN_RUN)('backlog MCP handlers with due dates (skipped)', () => {
  it('skipped - better-sqlite3 cannot load under this Node runtime (NODE_MODULE_VERSION mismatch)', () => {
    expect(CAN_RUN).toBe(false);
  });
});
