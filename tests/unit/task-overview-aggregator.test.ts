import { beforeEach, expect, it, vi } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import { buildTaskOverview } from '../../src/main/monitor/task-overview';

const { repositories } = vi.hoisted(() => ({ repositories: vi.fn() }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: repositories }));

const context = {
  projectRepo: { list: () => [{ id: 'one', name: 'App' }, { id: 'two', name: 'Backend' }] },
  sessionManager: { listManagedSummaries: vi.fn(() => []), getActivityCache: () => ({}) },
} as unknown as IpcContext;

beforeEach(() => {
  vi.mocked(context.sessionManager.listManagedSummaries).mockReturnValue([]);
  repositories.mockImplementation((_context: unknown, projectId: string) => ({
    swimlanes: { list: () => [{ id: 'draft', name: 'Draft', role: null, auto_spawn: false }] },
    tasks: { list: () => [{ id: 'same-id', display_id: 1, title: projectId, description: '', labels: [], priority: 0, updated_at: '2026-09-18T00:00:00Z', swimlane_id: 'draft' }] },
  }));
});

it('includes inactive projects and sessionless Drafts, with project-scoped identities', () => {
  const snapshot = buildTaskOverview(context);
  expect(snapshot.tasks).toHaveLength(2);
  expect(snapshot.tasks.map((task) => task.projectId)).toEqual(['one', 'two']);
  expect(snapshot.tasks.every((task) => task.attention.kind === 'draft')).toBe(true);
  expect(snapshot.unavailableProjects).toEqual([]);
});

it('surfaces partial failures rather than reporting an empty healthy board', () => {
  repositories.mockImplementation((_context: unknown, projectId: string) => {
    if (projectId === 'two') throw new Error('unavailable');
    return { tasks: { list: () => [] }, swimlanes: { list: () => [] } };
  });
  expect(buildTaskOverview(context).unavailableProjects).toEqual([{ projectId: 'two', projectName: 'Backend' }]);
});

it('uses a live isolated session, not a stale task session identifier', () => {
  repositories.mockReturnValue({
    swimlanes: { list: () => [{ id: 'verify', name: 'Verify', auto_spawn: true }] },
    tasks: { list: () => [{ id: 'task', display_id: 1, title: 'Test', labels: [], swimlane_id: 'verify', session_id: 'stale' }] },
  });
  vi.mocked(context.sessionManager.listManagedSummaries).mockReturnValue([
    { id: 'live', projectId: 'one', taskId: 'task', status: 'running', transient: false },
  ] as ReturnType<IpcContext['sessionManager']['listManagedSummaries']>);
  const snapshot = buildTaskOverview(context);
  expect(snapshot.tasks[0].attention.kind).toBe('unknown');
  expect(snapshot.tasks[1].attention.kind).toBe('blocked');
});

it('reads the router summary only while fresh, and tolerates a missing file', async () => {
  const { readRouterReasons } = await import('../../src/main/monitor/task-overview');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'router-summary-')), 'kangentic-resumen.json');
  const now = Date.parse('2026-09-22T12:30:00Z');
  fs.writeFileSync(file, JSON.stringify({
    generado: '2026-09-22T12:15:53.837Z',
    paraCK: [{ proyecto: 'Kangentic Inbox', n: 32, motivo: 'su entregable es producción' }],
  }));
  expect(readRouterReasons(file, now).get('Kangentic Inbox#32')).toBe('su entregable es producción');
  expect(readRouterReasons(file, now + 3 * 60 * 60_000).size).toBe(0);
  expect(readRouterReasons(path.join(path.dirname(file), 'missing.json'), now).size).toBe(0);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
