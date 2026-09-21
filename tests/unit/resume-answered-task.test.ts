import { beforeEach, expect, it, vi } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import { resumeAnsweredTask } from '../../src/main/monitor/resume-answered-task';

const mocks = vi.hoisted(() => ({ repos: vi.fn(), ensure: vi.fn(), spawn: vi.fn(), reconcile: vi.fn(), suspendWrites: vi.fn() }));
vi.mock('../../src/main/ipc/helpers', () => ({ getProjectRepos: mocks.repos, ensureTaskWorktree: mocks.ensure,
  createTransitionEngine: () => ({ resumeSuspendedSession: mocks.spawn }), resolveSpawnOverrides: () => ({}) }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: () => ({}) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({ reconcileTaskSessionRef: mocks.reconcile, applySuspendDbWrites: mocks.suspendWrites }));
vi.mock('../../src/main/transition-engine/column-strategy', () => ({ applyProfileToLane: (lane: unknown) => lane }));
vi.mock('../../src/main/ipc/helpers/task-profile', () => ({ loadTaskProfile: () => null }));

let task = makeTask();
function makeTask() {
  return { id: 'task', revision: 7, title: 'Investigate', description: '\n## Información requerida\nTrace?\n## Respuesta humana\n> Attached.',
    labels: ['approved', 'needs-human'], swimlane_id: 'verify', session_id: null as string | null,
    model_override: null, permission_mode: null, archived_at: null };
}
const sessionManager = { getSession: vi.fn(), getActivityCache: vi.fn(), suspend: vi.fn() };
const context = { projectRepo: { getById: vi.fn(() => ({ id: 'project', path: '/repo' })) }, sessionManager,
  boardEvents: { emitBoardChanged: vi.fn() } } as unknown as IpcContext;
const update = vi.fn((patch: Partial<typeof task>) => { task = { ...task, ...patch, revision: task.revision + 1 }; });
beforeEach(() => {
  vi.clearAllMocks();
  task = makeTask();
  mocks.repos.mockReturnValue({ tasks: { getById: () => task, update }, swimlanes: { getById: () => ({ name: 'Verify' }) }, actions: {}, attachments: {} });
  mocks.reconcile.mockImplementation(() => ({ task, liveSession: null }));
  mocks.ensure.mockResolvedValue(undefined);
  mocks.spawn.mockImplementation(async () => { update({ session_id: 'new' }); });
  sessionManager.getSession.mockReturnValue({ id: 'new', status: 'running' });
  sessionManager.getActivityCache.mockReturnValue({ existing: 'idle' });
  sessionManager.suspend.mockResolvedValue(undefined);
});
it('starts once and only releases the question hold after the session exists', async () => {
  mocks.spawn.mockImplementation(async () => {
    expect(task.labels).toContain('needs-human');
    update({ session_id: 'new' });
  });
  await resumeAnsweredTask(context, 'project', 'task', 7);
  expect(task.labels).toEqual(['approved']);
  expect(mocks.spawn).toHaveBeenCalledOnce();
  await expect(resumeAnsweredTask(context, 'project', 'task', 7)).rejects.toThrow('cambió');
  expect(mocks.spawn).toHaveBeenCalledOnce();
});
it('preserves the hold when spawn fails', async () => {
  mocks.spawn.mockRejectedValue(new Error('CLI missing'));
  await expect(resumeAnsweredTask(context, 'project', 'task', 7)).rejects.toThrow('CLI missing');
  expect(task.labels).toContain('needs-human');
});
it('suspends a partially created process on uncertain spawn failure without retrying', async () => {
  mocks.spawn.mockImplementation(async () => { update({ session_id: 'new' }); throw new Error('startup interrupted'); });
  await expect(resumeAnsweredTask(context, 'project', 'task', 7)).rejects.toThrow('startup interrupted');
  expect(sessionManager.suspend).toHaveBeenCalledWith('new');
  expect(task.labels).toContain('needs-human');
  expect(mocks.spawn).toHaveBeenCalledOnce();
});
it('refuses changed scope during worktree setup', async () => {
  mocks.ensure.mockImplementation(async () => { update({ description: 'Changed scope' }); });
  await expect(resumeAnsweredTask(context, 'project', 'task', 7)).rejects.toThrow('cambió');
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it.each(['thinking', 'permission', undefined])('does not interrupt a session with activity %s', async (activity) => {
  mocks.reconcile.mockReturnValue({ liveSession: { id: 'existing', status: 'running' } });
  sessionManager.getActivityCache.mockReturnValue({ existing: activity });
  await expect(resumeAnsweredTask(context, 'project', 'task', 7)).rejects.toThrow('sesión');
  expect(sessionManager.suspend).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it('restarts an idle session with an explicit continuation, not keyboard approval', async () => {
  mocks.reconcile.mockReturnValue({ liveSession: { id: 'existing', status: 'running' } });
  await resumeAnsweredTask(context, 'project', 'task', 7);
  expect(sessionManager.suspend).toHaveBeenCalledWith('existing');
  expect(mocks.spawn.mock.calls[0][3]).toContain('no autoriza producción');
});
it('suspends startup if another question arrived and preserves its labels', async () => {
  mocks.spawn.mockImplementation(async () => { update({ session_id: 'new', labels: ['approved', 'needs-human', 'needs-info'] }); });
  await expect(resumeAnsweredTask(context, 'project', 'task', 7)).rejects.toThrow('cambió');
  expect(sessionManager.suspend).toHaveBeenCalledWith('new');
  expect(task.labels).toContain('needs-info');
});
it('does not release a hold on missing session confirmation', async () => {
  sessionManager.getSession.mockReturnValue(undefined);
  await expect(resumeAnsweredTask(context, 'project', 'task', 7)).rejects.toThrow('confirmó');
  expect(task.labels).toContain('needs-human');
});
