import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitGitDelivery } from '../../src/main/git/delivery-commit';
import { prepareGitDelivery } from '../../src/main/git/delivery-preview';

const temporaryPrefix = path.join(os.tmpdir(), 'kangentic-delivery-commit-');
let repositoryDirectory = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repositoryDirectory, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function write(relativePath: string, content: string): void {
  const target = path.join(repositoryDirectory, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function state() {
  return {
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
  write('selected.txt', 'original\n');
  write('unrelated.txt', 'original\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  git('switch', '-c', 'task/delivery-commit');
});

afterEach(() => {
  const resolvedDirectory = fs.realpathSync(repositoryDirectory);
  expect(resolvedDirectory.startsWith(temporaryPrefix)).toBe(true);
  expect(fs.readdirSync(resolvedDirectory)).toBeDefined();
  fs.rmSync(resolvedDirectory, { recursive: true, force: true });
});

describe('commitGitDelivery', () => {
  it('commits only declared modified and untracked files, preserving unrelated staged and unstaged work', async () => {
    write('selected.txt', 'selected modification\n');
    write('new-selected.txt', 'selected untracked\n');
    write('unrelated.txt', 'staged unrelated\n');
    git('add', 'unrelated.txt');
    write('unrelated.txt', 'unstaged unrelated\n');
    const preview = await prepareGitDelivery(repositoryDirectory, 'task/delivery-commit', 'main', ['selected.txt', 'new-selected.txt']);

    const result = await commitGitDelivery(
      repositoryDirectory, 'task/delivery-commit', 'main', ['selected.txt', 'new-selected.txt'], preview.fingerprint, 'Deliver selected files',
    );

    expect(result).toEqual({ commit: git('rev-parse', 'HEAD'), branch: 'task/delivery-commit' });
    expect(git('show', '--format=', '--name-only', 'HEAD').split('\n').filter(Boolean).sort())
      .toEqual(['new-selected.txt', 'selected.txt']);
    expect(git('diff', '--cached', '--', 'unrelated.txt')).toContain('staged unrelated');
    expect(git('diff', '--', 'unrelated.txt')).toContain('unstaged unrelated');
  });

  it('refuses a stale fingerprint without changing HEAD, index, or the worktree', async () => {
    write('selected.txt', 'first version\n');
    const preview = await prepareGitDelivery(repositoryDirectory, 'task/delivery-commit', 'main', ['selected.txt']);
    write('selected.txt', 'second version\n');
    const before = state();

    await expect(commitGitDelivery(repositoryDirectory, 'task/delivery-commit', 'main', ['selected.txt'], preview.fingerprint, 'Deliver selected file'))
      .rejects.toThrow(/no coinciden con la vista aprobada/i);
    expect(state()).toEqual(before);
  });

  it.each(['', '   ', 'message\nwith newline', 'x'.repeat(501)])('refuses an invalid message without mutating Git state', async (message) => {
    write('selected.txt', 'selected modification\n');
    const before = state();

    await expect(commitGitDelivery(repositoryDirectory, 'task/delivery-commit', 'main', ['selected.txt'], 'unused', message))
      .rejects.toThrow(/mensaje debe tener/i);
    expect(state()).toEqual(before);
  });

  it('reports a hook failure as uncertain and does not retry the commit', async () => {
    write('selected.txt', 'selected modification\n');
    const preview = await prepareGitDelivery(repositoryDirectory, 'task/delivery-commit', 'main', ['selected.txt']);
    const hooksDirectory = path.join(repositoryDirectory, '.test-hooks');
    fs.mkdirSync(hooksDirectory);
    git('config', 'core.hooksPath', '.test-hooks');
    const hookPath = path.join(hooksDirectory, 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\nprintf "once\\n" >> .test-hooks/hook-runs\nexit 1\n');
    fs.chmodSync(hookPath, 0o755);
    const initialHead = git('rev-parse', 'HEAD');

    await expect(commitGitDelivery(repositoryDirectory, 'task/delivery-commit', 'main', ['selected.txt'], preview.fingerprint, 'Deliver selected file'))
      .rejects.toThrow(/No se confirmó el commit.*no ejecuta push/i);
    expect(git('rev-parse', 'HEAD')).toBe(initialHead);
    expect(fs.readFileSync(path.join(hooksDirectory, 'hook-runs'), 'utf8')).toBe('once\n');
  });
});
