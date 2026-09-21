import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseTaskCloseout, type TaskCloseoutSnapshot, type TaskCloseoutReport } from '../../shared/task-closeout';
import { getProjectDb } from '../db/database';
import { TaskCloseoutRepository } from '../db/repositories/task-closeout-repository';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import type { IpcContext } from '../ipc/ipc-context';

const runFile = promisify(execFile);

/** On demand only. Reads one bounded file and two read-only Git facts, no model. */
export async function readTaskCloseout(context: IpcContext, projectId: string, taskId: string): Promise<TaskCloseoutSnapshot> {
  const project = context.projectRepo.getById(projectId);
  if (!project) return { state: 'missing', message: 'Proyecto no disponible.' };
  const task = getProjectRepos(context, projectId).tasks.getById(taskId);
  if (!task) return { state: 'missing', message: 'Tarjeta no disponible.' };
  const directory = task.worktree_path || project.path;
  const saved = new TaskCloseoutRepository(getProjectDb(projectId)).get(taskId);
  if (saved) return observeCloseout(saved, directory, Boolean(task.archived_at));
  const filename = path.join(directory, 'kangentic-result.json');
  let raw: string;
  try {
    const stat = await fs.lstat(filename, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
      return { state: 'invalid', message: 'Resultado inválido: debe ser un archivo regular de hasta 64 KB.' };
    }
    const handle = await fs.open(filename, 'r');
    try {
      const opened = await handle.stat({ bigint: true });
      // Windows lstat may omit the volume ID (0); file IDs must still match exactly.
      const unknownWindowsDevice = process.platform === 'win32' && stat.dev === 0n;
      if (!opened.isFile() || opened.ino !== stat.ino || (!unknownWindowsDevice && opened.dev !== stat.dev)) {
        return { state: 'invalid', message: 'El archivo cambió durante la lectura. Reintenta.' };
      }
      const buffer = Buffer.alloc(64 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 64 * 1024) return { state: 'invalid', message: 'Resultado demasiado grande.' };
      raw = buffer.subarray(0, length).toString('utf8');
    } finally { await handle.close(); }
  } catch (failure) {
    return { state: 'missing', message: (failure as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'Todavía no hay un kangentic-result.json para revisar. No se acredita trabajo terminado.'
      : 'No se pudo leer el resultado. No se acredita trabajo terminado.' };
  }
  let report;
  try { report = parseTaskCloseout(JSON.parse(raw), taskId); } catch { report = null; }
  if (!report) return { state: 'invalid', message: 'El resultado no cumple el formato o pertenece a otra tarjeta.' };
  return observeCloseout(report, directory, Boolean(task.archived_at));
}

async function observeCloseout(report: TaskCloseoutReport, directory: string, archived: boolean): Promise<TaskCloseoutSnapshot> {
  const snapshot: TaskCloseoutSnapshot = { state: 'reported', report, message: 'Declarado por el agente. Los checks, push y despliegue requieren revisar su evidencia.' };
  if (archived) {
    snapshot.message += ' Tarjeta archivada: no se compara con el checkout de otro trabajo.';
    return snapshot;
  }
  try {
    const options = { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true };
    const [head, status] = await Promise.all([
      runFile('git', ['-C', directory, 'rev-parse', 'HEAD'], options),
      runFile('git', ['-C', directory, 'status', '--porcelain', '--untracked-files=normal', '--', '.', ':(exclude)kangentic-result.json'], options),
    ]);
    snapshot.observedHead = head.stdout.trim();
    snapshot.headMatches = snapshot.observedHead === report.head;
    snapshot.worktreeDirty = status.stdout.trim().length > 0;
  } catch {
    snapshot.message += ' No se pudo verificar el estado Git actual.';
  }
  return snapshot;
}
