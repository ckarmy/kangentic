import type Database from 'better-sqlite3';
import { parseTaskCloseout, type TaskCloseoutReport } from '../../../shared/task-closeout';

export class TaskCloseoutRepository {
  constructor(private database: Database.Database) {}

  get(taskId: string, expectedRevision?: number): TaskCloseoutReport | null {
    const row = this.database.prepare('SELECT report_json, task_revision FROM task_closeouts WHERE task_id = ?').get(taskId) as { report_json: string; task_revision: number } | undefined;
    if (!row || (expectedRevision !== undefined && row.task_revision !== expectedRevision)) return null;
    try { return parseTaskCloseout(JSON.parse(row.report_json), taskId); } catch { return null; }
  }

  save(taskId: string, revision: number, report: TaskCloseoutReport): void {
    this.database.prepare(`INSERT INTO task_closeouts (task_id, task_revision, report_json, recorded_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET
      task_revision = excluded.task_revision, report_json = excluded.report_json, recorded_at = excluded.recorded_at`)
      .run(taskId, revision, JSON.stringify(report), new Date().toISOString());
  }
}
