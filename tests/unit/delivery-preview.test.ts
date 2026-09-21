import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareGitDelivery } from '../../src/main/git/delivery-preview';

const temporaryPrefix = path.join(os.tmpdir(), 'kangentic-delivery-preview-');
let repositoryDirectory = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repositoryDirectory, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function write(relativePath: string, content: string): void {
  const target = path.join(repositoryDirectory, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function repositoryState() {
  return {
    branch: git('branch', '--show-current'),
    head: git('rev-parse', 'HEAD'),
    index: git('diff', '--cached', '--binary'),
    worktree: git('status', '--porcelain=v1', '--untracked-files=all'),
  };
}

beforeEach(() => {
  repositoryDirectory = fs.mkdtempSync(temporaryPrefix);
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.invalid');
  write('tracked.txt', 'original\n');
  write('unchanged.txt', 'unchanged\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  git('switch', '-c', 'task/delivery-preview');
});

afterEach(() => {
  const resolvedDirectory = fs.realpathSync(repositoryDirectory);
  expect(resolvedDirectory.startsWith(temporaryPrefix)).toBe(true);
  expect(fs.readdirSync(resolvedDirectory)).toBeDefined();
  fs.rmSync(resolvedDirectory, { recursive: true, force: true });
});

describe('prepareGitDelivery', () => {
  it('selects declared changed and untracked files, excludes unchanged declarations, and reports unrelated changes', async () => {
    write('tracked.txt', 'changed\n');
    write('new.txt', 'new file\n');
    write('unrelated.txt', 'unrelated\n');

    const preview = await prepareGitDelivery(repositoryDirectory, 'task/delivery-preview', 'main', [
      'tracked.txt', 'new.txt', 'unchanged.txt', 'tracked.txt',
    ]);

    expect(preview.branch).toBe('task/delivery-preview');
    expect(preview.head).toBe(git('rev-parse', 'HEAD'));
    expect(preview.files).toEqual(['new.txt', 'tracked.txt']);
    expect(preview.otherChangedFiles).toEqual(['unrelated.txt']);
    expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes the fingerprint when a selected file changes and leaves HEAD, index, and worktree untouched', async () => {
    write('tracked.txt', 'first change\n');
    const before = repositoryState();
    const first = await prepareGitDelivery(repositoryDirectory, 'task/delivery-preview', 'main', ['tracked.txt']);
    expect(repositoryState()).toEqual(before);

    write('tracked.txt', 'second change\n');
    const second = await prepareGitDelivery(repositoryDirectory, 'task/delivery-preview', 'main', ['tracked.txt']);

    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it.each([
    ['main', 'main'],
    ['task/delivery-preview', 'task/delivery-preview'],
    ['other-task', 'main'],
  ])('rejects the %s branch expectation', async (expectedBranch, baseBranch) => {
    write('tracked.txt', 'changed\n');

    await expect(prepareGitDelivery(repositoryDirectory, expectedBranch, baseBranch, ['tracked.txt']))
      .rejects.toThrow(/rama actual/i);
  });

  it.each([
    ['traversal', '../tracked.txt'],
    ['git metadata', '.git/HEAD'],
    ['absolute path', '/tracked.txt'],
  ])('rejects a %s declared path', async (_kind, declaredFile) => {
    write('tracked.txt', 'changed\n');

    await expect(prepareGitDelivery(repositoryDirectory, 'task/delivery-preview', 'main', [declaredFile]))
      .rejects.toThrow(/ruta no válida/i);
  });

  it('rejects a declared symlink or directory', async () => {
    write('tracked.txt', 'changed\n');
    fs.symlinkSync(path.join(repositoryDirectory, 'tracked.txt'), path.join(repositoryDirectory, 'link.txt'), 'file');
    fs.mkdirSync(path.join(repositoryDirectory, 'folder'));

    await expect(prepareGitDelivery(repositoryDirectory, 'task/delivery-preview', 'main', ['link.txt']))
      .rejects.toThrow(/enlaces simbólicos ni directorios/i);
    await expect(prepareGitDelivery(repositoryDirectory, 'task/delivery-preview', 'main', ['folder']))
      .rejects.toThrow(/enlaces simbólicos ni directorios/i);
  });

  it('rejects a declared file with no pending change', async () => {
    await expect(prepareGitDelivery(repositoryDirectory, 'task/delivery-preview', 'main', ['unchanged.txt']))
      .rejects.toThrow(/No hay cambios pendientes/i);
  });
});
