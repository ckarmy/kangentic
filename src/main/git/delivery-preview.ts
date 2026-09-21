import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** All Git invocations are read-only and disable external diff/textconv drivers. */
export async function prepareGitDelivery(directory: string, expectedBranch: string, baseBranch: string | null, declaredFiles: string[]) {
  const root = await fs.realpath(directory);
  const git = async (...args: string[]) => (await run('git', ['--literal-pathspecs', '-C', root, ...args], {
    timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  })).stdout;
  const top = await fs.realpath((await git('rev-parse', '--show-toplevel')).trim());
  if (top !== root) throw new Error('La entrega requiere la raíz exacta del worktree.');
  const branch = (await git('symbolic-ref', '--quiet', '--short', 'HEAD')).trim();
  if (branch !== expectedBranch || ['main', 'master', 'trunk', 'develop', baseBranch?.replace(/^refs\/heads\//, '')].includes(branch)) {
    throw new Error('La rama actual no es una rama de tarea autorizada. No se prepara entrega sobre la rama base.');
  }
  if (!Array.isArray(declaredFiles) || !declaredFiles.length || declaredFiles.length > 100) throw new Error('El informe debe identificar entre 1 y 100 archivos.');
  const head = (await git('rev-parse', 'HEAD')).trim();
  const fingerprint = createHash('sha256').update(JSON.stringify({ root, branch, head }));
  const files: string[] = [];
  let total = 0;
  for (const file of [...new Set(declaredFiles)].sort()) {
    if (typeof file !== 'string' || !file || /[\\:\x00-\x1f]/.test(file) || path.posix.isAbsolute(file)
        || file.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      throw new Error('El informe contiene una ruta no válida para entrega.');
    }
    // Walk every segment: no directory traversal or symlinked ancestor, even for deletions.
    let cursor = root;
    const parts = file.split('/');
    let exists = true;
    let identity: { ino: bigint; dev: bigint } | null = null;
    for (let index = 0; index < parts.length; index += 1) {
      cursor = path.join(cursor, parts[index]);
      try {
        const stat = await fs.lstat(cursor, { bigint: true });
        if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
          throw new Error('No se incluyen enlaces simbólicos ni directorios en una entrega.');
        }
        if (index === parts.length - 1) identity = { ino: stat.ino, dev: stat.dev };
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
        exists = false;
        break;
      }
    }
    const status = await git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--', file);
    if (!status) continue;
    fingerprint.update(JSON.stringify({ file, status }));
    if (exists) {
      const handle = await fs.open(cursor, 'r');
      try {
        const openedIdentity = await handle.stat({ bigint: true });
        // Windows path-based stat may report dev=0 while fstat supplies the volume ID.
        // Keep exact bigint file IDs (Number can round NTFS IDs); never waive inode checks.
        const unknownWindowsDevice = process.platform === 'win32' && identity?.dev === 0n;
        if (!identity || openedIdentity.ino !== identity.ino
            || (!unknownWindowsDevice && openedIdentity.dev !== identity.dev)) throw new Error('Un archivo fue reemplazado durante la preparación.');
        const before = await handle.stat();
        if (!before.isFile() || before.size > MAX_FILE_BYTES || (total += before.size) > MAX_TOTAL_BYTES) throw new Error('Archivos demasiado grandes para preparar una entrega segura.');
        const bytes = Buffer.alloc(before.size + 1);
        let size = 0;
        while (size < bytes.length) {
          const read = await handle.read(bytes, size, bytes.length - size, size);
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        const after = await handle.stat();
        if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Un archivo cambió durante la lectura. Actualiza antes de entregar.');
        fingerprint.update(bytes.subarray(0, size));
      } finally { await handle.close(); }
    }
    fingerprint.update(await git('diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--', file));
    files.push(file);
  }
  if (!files.length) throw new Error('No hay cambios pendientes en los archivos declarados.');
  if ((await git('rev-parse', 'HEAD')).trim() !== head || (await git('symbolic-ref', '--quiet', '--short', 'HEAD')).trim() !== branch) {
    throw new Error('La rama cambió durante la preparación.');
  }
  const changed = new Set([
    ...(await git('diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD')).split('\0'),
    ...(await git('ls-files', '--others', '--exclude-standard', '-z')).split('\0'),
  ].filter(Boolean));
  return { branch, head, files, fingerprint: fingerprint.digest('hex'), otherChangedFiles: [...changed].filter((file) => !files.includes(file)).sort() };
}
