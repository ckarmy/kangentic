import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confirmGitPush, prepareGitPush } from '../../src/main/git/delivery-push';

const temporaryPrefix = path.join(os.tmpdir(), 'kangentic-delivery-push-');
let temporaryDirectory = '';
let repositoryDirectory = '';
let remoteDirectory = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repositoryDirectory, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function gitDirectory(directory: string, ...args: string[]): string {
  return execFileSync('git', ['--git-dir', directory, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function write(relativePath: string, content: string, directory = repositoryDirectory): void {
  const target = path.join(directory, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function remoteRef(ref: string): string | null {
  return refAt(remoteDirectory, ref);
}

function refAt(directory: string, ref: string): string | null {
  try { return gitDirectory(directory, 'rev-parse', '--verify', ref); } catch { return null; }
}

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(temporaryPrefix);
  repositoryDirectory = path.join(temporaryDirectory, 'worktree');
  remoteDirectory = path.join(temporaryDirectory, 'origin.git');
  fs.mkdirSync(repositoryDirectory);
  execFileSync('git', ['init', '--initial-branch=main', repositoryDirectory], { windowsHide: true });
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.invalid');
  write('base.txt', 'base\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  execFileSync('git', ['init', '--bare', remoteDirectory], { windowsHide: true });
  git('remote', 'add', 'origin', remoteDirectory);
  git('push', 'origin', 'main:refs/heads/main');
  git('switch', '-c', 'task/delivery-push');
  write('task.txt', 'task change\n');
  git('add', 'task.txt');
  git('commit', '-m', 'task work');
});

afterEach(() => {
  const resolvedDirectory = fs.realpathSync(temporaryDirectory);
  expect(resolvedDirectory.startsWith(temporaryPrefix)).toBe(true);
  expect(fs.readdirSync(resolvedDirectory)).toBeDefined();
  fs.rmSync(resolvedDirectory, { recursive: true, force: true });
});

describe('delivery push', () => {
  it('pushes the exact approved task SHA only, leaving main and unrelated tags unchanged', async () => {
    git('tag', 'unrelated-tag');
    const preview = await prepareGitPush(repositoryDirectory, 'task/delivery-push', 'main');
    const mainBefore = remoteRef('refs/heads/main');

    const result = await confirmGitPush(repositoryDirectory, 'task/delivery-push', 'main', preview.fingerprint);

    expect(result).toEqual({ commit: preview.head, branch: 'task/delivery-push', destination: preview.destination });
    expect(remoteRef('refs/heads/task/delivery-push')).toBe(preview.head);
    expect(remoteRef('refs/heads/main')).toBe(mainBefore);
    expect(remoteRef('refs/tags/unrelated-tag')).toBeNull();
  });

  it.each(['head', 'origin'])('refuses a stale fingerprint without mutating the remote when the %s changes', async (change) => {
    const preview = await prepareGitPush(repositoryDirectory, 'task/delivery-push', 'main');
    let alternateRemote: string | null = null;
    if (change === 'head') {
      write('later.txt', 'later change\n');
      git('add', 'later.txt');
      git('commit', '-m', 'later work');
    } else {
      alternateRemote = path.join(temporaryDirectory, 'alternate.git');
      execFileSync('git', ['init', '--bare', alternateRemote], { windowsHide: true });
      git('remote', 'set-url', 'origin', alternateRemote);
    }

    await expect(confirmGitPush(repositoryDirectory, 'task/delivery-push', 'main', preview.fingerprint))
      .rejects.toThrow(/rama, el commit o el destino cambiaron/i);
    expect(remoteRef('refs/heads/task/delivery-push')).toBeNull();
    if (alternateRemote) expect(refAt(alternateRemote, 'refs/heads/task/delivery-push')).toBeNull();
  });

  it('rejects protected or base branch expectations', async () => {
    await expect(prepareGitPush(repositoryDirectory, 'main', 'main')).rejects.toThrow(/No se permite subir/i);
    git('switch', 'main');
    await expect(prepareGitPush(repositoryDirectory, 'main', 'main')).rejects.toThrow(/No se permite subir/i);
  });

  it('rejects multiple push URLs and credential-bearing HTTP URLs before a push', async () => {
    const otherRemote = path.join(temporaryDirectory, 'other.git');
    execFileSync('git', ['init', '--bare', otherRemote], { windowsHide: true });
    git('config', '--add', 'remote.origin.pushurl', remoteDirectory);
    git('config', '--add', 'remote.origin.pushurl', otherRemote);
    await expect(prepareGitPush(repositoryDirectory, 'task/delivery-push', 'main')).rejects.toThrow(/único destino origin/i);
    git('config', '--unset-all', 'remote.origin.pushurl');
    git('config', '--add', 'remote.origin.pushurl', 'https://user:secret@example.invalid/repo.git');

    await expect(prepareGitPush(repositoryDirectory, 'task/delivery-push', 'main')).rejects.toThrow(/gestor de credenciales/i);
    expect(remoteRef('refs/heads/task/delivery-push')).toBeNull();
  });

  it('does not force a non-fast-forward push and preserves the newer remote SHA', async () => {
    git('push', 'origin', 'task/delivery-push:refs/heads/task/delivery-push');
    const preview = await prepareGitPush(repositoryDirectory, 'task/delivery-push', 'main');
    const competingDirectory = path.join(temporaryDirectory, 'competing-worktree');
    execFileSync('git', ['clone', remoteDirectory, competingDirectory], { windowsHide: true });
    execFileSync('git', ['-C', competingDirectory, 'config', 'user.name', 'Other User'], { windowsHide: true });
    execFileSync('git', ['-C', competingDirectory, 'config', 'user.email', 'other@example.invalid'], { windowsHide: true });
    execFileSync('git', ['-C', competingDirectory, 'switch', 'task/delivery-push'], { windowsHide: true });
    write('remote-only.txt', 'newer remote work\n', competingDirectory);
    execFileSync('git', ['-C', competingDirectory, 'add', 'remote-only.txt'], { windowsHide: true });
    execFileSync('git', ['-C', competingDirectory, 'commit', '-m', 'remote advance'], { windowsHide: true });
    execFileSync('git', ['-C', competingDirectory, 'push', 'origin', 'task/delivery-push:refs/heads/task/delivery-push'], { windowsHide: true });
    const remoteBefore = remoteRef('refs/heads/task/delivery-push');

    await expect(confirmGitPush(repositoryDirectory, 'task/delivery-push', 'main', preview.fingerprint))
      .rejects.toThrow(/No se confirmó el push.*no se reintentó ni se forzó/i);
    expect(remoteRef('refs/heads/task/delivery-push')).toBe(remoteBefore);
  });
});
