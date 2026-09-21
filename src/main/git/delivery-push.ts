import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const run = promisify(execFile);

function git(directory: string) {
  return async (...args: string[]) => (await run('git', ['-C', directory, ...args], {
    timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' },
  })).stdout.trim();
}

/** Read-only destination preview. No fetching, credentials in output, or implicit upstream. */
export async function prepareGitPush(directory: string, expectedBranch: string, baseBranch: string | null) {
  const root = await fs.realpath(directory);
  const command = git(root);
  if (await fs.realpath(await command('rev-parse', '--show-toplevel')) !== root) throw new Error('Se requiere la raíz del worktree.');
  const branch = await command('symbolic-ref', '--quiet', '--short', 'HEAD');
  if (branch !== expectedBranch || ['main', 'master', 'trunk', 'develop', baseBranch?.replace(/^refs\/heads\//, '')].includes(branch)) {
    throw new Error('No se permite subir esta rama desde la entrega.');
  }
  await command('check-ref-format', `refs/heads/${branch}`);
  const head = await command('rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error('HEAD inválido.');
  const urls = (await command('remote', 'get-url', '--push', '--all', 'origin')).split(/\r?\n/);
  if (urls.length !== 1 || !urls[0] || /[\x00-\x1f]/.test(urls[0]) || urls[0].startsWith('-')) throw new Error('Se requiere un único destino origin explícito.');
  const destination = urls[0];
  if (destination.includes('::') || (/^[a-z][a-z0-9+.-]*:\/\//i.test(destination)
      && !/^(https?|ssh|git|file):\/\//i.test(destination))) throw new Error('Transporte remoto no admitido para entrega.');
  if (/^https?:\/\//i.test(destination)) {
    const url = new URL(destination);
    if (url.username || url.password || url.search || url.hash) throw new Error('Usa un gestor de credenciales, no credenciales en la URL remota.');
  }
  if (/^ssh:\/\//i.test(destination)) {
    const url = new URL(destination);
    if (url.password || url.search || url.hash) throw new Error('La URL SSH no debe incluir contraseñas ni parámetros.');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ root, branch, head, destination })).digest('hex');
  return { branch, head, destination, fingerprint };
}

/** Explicit human approval only. Exact SHA to same named task branch; no retry or force. */
export async function confirmGitPush(directory: string, branch: string, baseBranch: string | null, fingerprint: string) {
  const preview = await prepareGitPush(directory, branch, baseBranch);
  if (fingerprint !== preview.fingerprint) throw new Error('La rama, el commit o el destino cambiaron. Revisa una nueva vista previa.');
  const command = git(directory);
  try {
    await command('push', '--no-force', '--no-mirror', '--no-follow-tags', '--recurse-submodules=no', '--',
      preview.destination, `${preview.head}:refs/heads/${preview.branch}`);
    const remote = await command('ls-remote', '--refs', '--', preview.destination, `refs/heads/${preview.branch}`);
    const rows = remote.split(/\r?\n/).filter(Boolean);
    if (rows.length !== 1 || rows[0].split(/\s+/)[0] !== preview.head) throw new Error('No se confirmó el SHA remoto.');
    return { commit: preview.head, branch: preview.branch, destination: preview.destination };
  } catch {
    throw new Error('No se confirmó el push. El remoto puede haber recibido el commit; comprueba su estado antes de reintentar. No se reintentó ni se forzó.');
  }
}
