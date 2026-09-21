import type Database from 'better-sqlite3';
import type { TaskDeliveryOperation, TaskDeliveryCommitResult } from '@kangentic/protocol';

interface Row {
  id: string; task_id: string; kind: 'commit' | 'push'; request_hash: string;
  owner: string; status: 'running' | 'succeeded' | 'uncertain'; result_json: string | null;
}

/** Durable at-most-once reservation; never infer failure from elapsed time. */
export class TaskDeliveryOperationRepository {
  constructor(private database: Database.Database, private owner: string) {}

  get(taskId: string, id: string): TaskDeliveryOperation | null {
    const row = this.database.prepare('SELECT * FROM task_delivery_operations WHERE task_id = ? AND id = ?').get(taskId, id) as Row | undefined;
    return row ? this.toOperation(row) : null;
  }

  reserve(taskId: string, id: string, kind: 'commit' | 'push', requestHash: string): { created: boolean; operation: TaskDeliveryOperation } {
    if (!/^[a-zA-Z0-9-]{16,128}$/.test(id) || !/^[a-f0-9]{64}$/.test(requestHash)) throw new Error('Identidad de operación inválida.');
    return this.database.transaction(() => {
      const existing = this.findExisting(taskId, id, kind, requestHash);
      if (existing) return { created: false, operation: existing };
      const unresolved = this.database.prepare("SELECT id FROM task_delivery_operations WHERE task_id = ? AND status != 'succeeded' LIMIT 1").get(taskId);
      if (unresolved) throw new Error('Existe una entrega pendiente o incierta. Comprueba su resultado antes de autorizar otra.');
      this.database.prepare(`INSERT INTO task_delivery_operations
        (id, task_id, kind, request_hash, owner, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`)
        .run(id, taskId, kind, requestHash, this.owner, new Date().toISOString());
      return { created: true, operation: this.get(taskId, id)! };
    })();
  }

  findExisting(taskId: string, id: string, kind: 'commit' | 'push', requestHash: string): TaskDeliveryOperation | null {
    if (!/^[a-zA-Z0-9-]{16,128}$/.test(id) || !/^[a-f0-9]{64}$/.test(requestHash)) throw new Error('Identidad de operación inválida.');
    const row = this.database.prepare('SELECT * FROM task_delivery_operations WHERE id = ?').get(id) as Row | undefined;
    if (row) {
      if (row.task_id !== taskId || row.kind !== kind || row.request_hash !== requestHash) throw new Error('La identidad de operación ya pertenece a otra solicitud.');
      return this.toOperation(row);
    }
    const same = this.database.prepare('SELECT * FROM task_delivery_operations WHERE task_id = ? AND kind = ? AND request_hash = ?').get(taskId, kind, requestHash) as Row | undefined;
    return same ? this.toOperation(same) : null;
  }

  finish(taskId: string, id: string, result: TaskDeliveryCommitResult | null): void {
    const changed = this.database.prepare(`UPDATE task_delivery_operations SET status = ?, result_json = ?, finished_at = ?
      WHERE id = ? AND task_id = ? AND owner = ? AND status = 'running'`)
      .run(result ? 'succeeded' : 'uncertain', result ? JSON.stringify(result) : null, new Date().toISOString(), id, taskId, this.owner);
    if (changed.changes !== 1) throw new Error('No se pudo registrar el resultado. No repitas la operación; comprueba Git.');
  }

  private toOperation(row: Row): TaskDeliveryOperation {
    const status = row.status === 'running' && row.owner !== this.owner ? 'uncertain' : row.status;
    let result: TaskDeliveryCommitResult | undefined;
    if (row.result_json) {
      try {
        const parsed = JSON.parse(row.result_json);
        if (typeof parsed.branch === 'string' && typeof parsed.commit === 'string' && /^[a-f0-9]{40,64}$/.test(parsed.commit)) result = parsed;
      } catch { /* Never treat corrupt evidence as success. */ }
    }
    const effective = status === 'succeeded' && !result ? 'uncertain' : status;
    return { id: row.id, taskId: row.task_id, kind: row.kind, status: effective, result,
      message: effective === 'running' ? 'Operación en curso. Consulta el resultado; no la repitas.'
        : effective === 'succeeded' ? 'Operación confirmada y registrada.' : 'Resultado incierto. Comprueba Git antes de continuar; no se reintentará automáticamente.' };
  }
}
