import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import { readTaskCloseout } from '../../src/main/monitor/task-closeout';

const mocks = vi.hoisted(() => ({ stat: vi.fn(), open: vi.fn(), git: vi.fn(), repos: vi.fn(), close: vi.fn(), saved: vi.fn() }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: () => ({}) }));
vi.mock('../../src/main/db/repositories/task-closeout-repository', () => ({ TaskCloseoutRepository: class { get = mocks.saved; } }));
vi.mock('node:fs/promises', () => ({ default: { lstat: mocks.stat, open: mocks.open } }));
vi.mock('node:util', () => ({ promisify: () => mocks.git }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: mocks.repos }));
const context = { projectRepo: { getById: () => ({ path: '/project' }) } } as unknown as IpcContext;
const report = { version: 1, taskId: 'one', summary: 'Done', files: [], checks: [{ command: 'DO NOT EXECUTE ME', result: 'passed', evidence: 'log' }],
  head: 'a'.repeat(40), delivery: 'Not pushed', deployment: 'Not deployed', nextAction: 'Review' };
let raw = '';
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saved.mockReturnValue(null);
  raw = JSON.stringify(report);
  const stat = { isFile: () => true, isSymbolicLink: () => false, size: raw.length, ino: 1, dev: 1 };
  mocks.stat.mockResolvedValue(stat);
  mocks.open.mockResolvedValue({ stat: async () => stat, close: mocks.close,
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const content = Buffer.from(raw);
      const bytesRead = content.copy(buffer, offset, position, position + length);
      return { bytesRead };
    } });
  mocks.repos.mockReturnValue({ tasks: { getById: () => ({ worktree_path: '/worktree' }) } });
  mocks.git.mockImplementation(async (_executable: string, args: string[]) => ({ stdout: args.includes('rev-parse') ? 'a'.repeat(40) : '' }));
});
afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
});
it('observes Git separately without executing declared test commands', async () => {
  const result = await readTaskCloseout(context, 'project', 'one');
  expect(result).toMatchObject({ state: 'reported', headMatches: true, worktreeDirty: false });
  expect(mocks.git).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(mocks.git.mock.calls)).not.toContain('DO NOT EXECUTE ME');
  expect(mocks.close).toHaveBeenCalledOnce();
});
it('retains the recorded report after archival without reading a deleted worktree', async () => {
  mocks.saved.mockReturnValue(report);
  mocks.repos.mockReturnValue({ tasks: { getById: () => ({ archived_at: 'now', worktree_path: null }) } });
  expect(await readTaskCloseout(context, 'project', 'one')).toMatchObject({ state: 'reported', report });
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.git).not.toHaveBeenCalled();
});
it('rejects a symlink before opening it or invoking Git', async () => {
  mocks.stat.mockResolvedValue({ isFile: () => false, isSymbolicLink: () => true });
  expect(await readTaskCloseout(context, 'project', 'one')).toMatchObject({ state: 'invalid' });
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.git).not.toHaveBeenCalled();
});
it('rejects mismatched task identity', async () => {
  expect(await readTaskCloseout(context, 'project', 'two')).toMatchObject({ state: 'invalid' });
  expect(mocks.git).not.toHaveBeenCalled();
});
it('does not claim Git verification when Git fails', async () => {
  mocks.git.mockRejectedValue(new Error('Unavailable'));
  const result = await readTaskCloseout(context, 'project', 'one');
  expect(result.headMatches).toBeUndefined();
  expect(result.message).toContain('No se pudo verificar');
});
it('bounds a file that grows after its initial stat', async () => {
  raw = 'x'.repeat(70_000);
  expect(await readTaskCloseout(context, 'project', 'one')).toMatchObject({ state: 'invalid' });
  expect(mocks.git).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledOnce();
});
it('accepts Windows lstat dev=0 when the opened handle has the same bigint inode on its real volume', async () => {
  setPlatform('win32');
  const lstat = { isFile: () => true, isSymbolicLink: () => false, size: raw.length, ino: 41n, dev: 0n };
  const opened = { ...lstat, dev: 987n };
  mocks.stat.mockResolvedValue(lstat);
  mocks.open.mockResolvedValue({ stat: async () => opened, close: mocks.close,
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const content = Buffer.from(raw);
      return { bytesRead: content.copy(buffer, offset, position, position + length) };
    } });

  await expect(readTaskCloseout(context, 'project', 'one')).resolves.toMatchObject({ state: 'reported' });
});
it('rejects a Windows opened handle whose bigint inode differs from lstat', async () => {
  setPlatform('win32');
  const lstat = { isFile: () => true, isSymbolicLink: () => false, size: raw.length, ino: 41n, dev: 0n };
  const opened = { ...lstat, ino: 42n, dev: 987n };
  mocks.stat.mockResolvedValue(lstat);
  mocks.open.mockResolvedValue({ stat: async () => opened, close: mocks.close, read: vi.fn() });

  await expect(readTaskCloseout(context, 'project', 'one')).resolves.toMatchObject({ state: 'invalid', message: expect.stringMatching(/cambió durante la lectura/i) });
  expect(mocks.git).not.toHaveBeenCalled();
});
it('rejects a known lstat volume that differs from the opened handle volume', async () => {
  setPlatform('win32');
  const lstat = { isFile: () => true, isSymbolicLink: () => false, size: raw.length, ino: 41n, dev: 1n };
  const opened = { ...lstat, dev: 2n };
  mocks.stat.mockResolvedValue(lstat);
  mocks.open.mockResolvedValue({ stat: async () => opened, close: mocks.close, read: vi.fn() });

  await expect(readTaskCloseout(context, 'project', 'one')).resolves.toMatchObject({ state: 'invalid', message: expect.stringMatching(/cambió durante la lectura/i) });
  expect(mocks.git).not.toHaveBeenCalled();
});
