import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareGitDelivery } from './delivery-preview';

const run = promisify(execFile);

/** Called only after human confirmation. Never pushes, amends, resets, or retries. */
export async function commitGitDelivery(directory: string, branch: string, baseBranch: string | null,
  files: string[], fingerprint: string, message: string): Promise<{ commit: string; branch: string }> {
  if (typeof message !== 'string' || !message.trim() || message.length > 500 || /[\x00-\x1f]/.test(message)) {
    throw new Error('El mensaje debe tener entre 1 y 500 caracteres en una línea.');
  }
  const preview = await prepareGitDelivery(directory, branch, baseBranch, files);
  if (preview.fingerprint !== fingerprint) throw new Error('Los cambios ya no coinciden con la vista aprobada. Prepara una nueva entrega.');
  const git = async (...args: string[]) => (await run('git', ['--literal-pathspecs', '-C', directory, ...args], {
    timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })).stdout.trim();
  try {
    // --only excludes unrelated staged work. add also makes new declared files known to Git.
    await git('add', '--', ...preview.files);
    await git('commit', '--only', '-m', message.trim(), '--', ...preview.files);
    const commit = await git('rev-parse', 'HEAD');
    const parent = await git('rev-parse', 'HEAD^');
    const currentBranch = await git('symbolic-ref', '--quiet', '--short', 'HEAD');
    const committedFiles = (await git('diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', commit)).split('\0').filter(Boolean);
    if (commit === preview.head || parent !== preview.head || currentBranch !== branch) {
      throw new Error('El estado Git posterior no coincide con la entrega.');
    }
    if (!committedFiles.length || committedFiles.some((file) => !preview.files.includes(file))) {
      throw new Error('El commit contiene archivos fuera de la entrega aprobada.');
    }
    return { commit, branch };
  } catch {
    // A hook/process may have completed an operation before timeout. No automatic retry/rollback.
    throw new Error('No se confirmó el commit. Puede haber archivos staged o un commit creado. Revisa Git y los hooks antes de reintentar. Este flujo no ejecuta push.');
  }
}
