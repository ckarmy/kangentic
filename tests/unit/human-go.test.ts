import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRecordHumanGo } from '../../src/main/agent/commands/human-go';
import { routerGuarded, routerTaskHeld } from '../../src/main/agent/commands/task-commands';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { humanResponseResumeBlock } from '../../src/shared/human-response-resume';

describe('CK GO relayed from a trusted transport', () => {
  let db: Database.Database;
  let tasks: TaskRepository;
  let todoId: string;
  let executingId: string;
  const context = (over: Record<string, unknown> = {}) => ({
    actor: 'human', projectId: 'p', getProjectDb: () => db, onTaskUpdated: vi.fn(), ...over,
  }) as any;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runProjectMigrations(db);
    tasks = new TaskRepository(db);
    todoId = (db.prepare("SELECT id FROM swimlanes WHERE role='todo'").get() as { id: string }).id;
    executingId = (db.prepare("SELECT id FROM swimlanes WHERE name='Executing'").get() as { id: string }).id;
  });
  afterEach(() => db.close());

  it('refuses anything but the human transport', async () => {
    const task = tasks.create({ title: 'Cobranza PROD', description: 'Leer PROD.', swimlane_id: todoId });
    expect(await handleRecordHumanGo({ taskId: task.id, decision: 'go' }, context({ actor: 'agent' })))
      .toMatchObject({ success: false });
  });

  it('GO on an Approved card lifts the sensitive text and risk labels, not a later question', async () => {
    const task = tasks.create({ title: 'Decidir el GO de cobranza en PROD', description: 'Toca PROD.', swimlane_id: todoId,
      labels: ['approved', 'production', 'risky', 'manual-hold'] });
    const before = tasks.getById(task.id)!;
    expect(routerGuarded(before.labels, `${before.title}\n${before.description}`)).toBe(true);

    const r = await handleRecordHumanGo({ taskId: task.id, decision: 'go', comment: 'solo lectura', source: 'telegram' }, context());
    expect(r.success).toBe(true);
    const after = tasks.getById(task.id)!;
    expect(after.labels).toEqual(['approved', 'production', 'risky', 'go-ck']);
    expect(after.description).toContain('> GO de CK (telegram): solo lectura');
    expect(after.description).toContain('Nada que exija ejecutar en producción se ejecuta');
    expect(routerGuarded(after.labels, `${after.title}\n${after.description}`)).toBe(false);
    // A new question after the GO holds the card again.
    expect(routerTaskHeld([...after.labels, 'needs-info'])).toBe(true);
  });

  it('GO on a paused stage answers the question and resumes the session', async () => {
    const task = tasks.create({ title: 'Errores Sentry', description: 'Trabajo.\n\n## Información requerida\n¿Adjuntas la evidencia?',
      swimlane_id: executingId, labels: ['approved', 'needs-info', 'needs-human'] });
    const onAnsweredTaskResume = vi.fn(async () => {});
    const r = await handleRecordHumanGo({ taskId: task.id, decision: 'go', comment: 'usa el MCP de Sentry' }, context({ onAnsweredTaskResume }));
    expect(r).toMatchObject({ success: true, data: { resumed: true } });
    const after = tasks.getById(task.id)!;
    expect(after.labels).toEqual(['approved', 'go-ck', 'needs-human']);
    expect(onAnsweredTaskResume).toHaveBeenCalledWith(task.id, after.revision);
    expect(humanResponseResumeBlock({ labels: after.labels, description: after.description, archived: false, columnName: 'Executing' })).toBeNull();
  });

  it('NO archives the card with the reason', async () => {
    const task = tasks.create({ title: 'Idea', description: 'Algo.', swimlane_id: todoId, labels: ['approved'] });
    const r = await handleRecordHumanGo({ taskId: task.id, decision: 'no', comment: 'ya no aplica' }, context());
    expect(r.success).toBe(true);
    const after = tasks.getById(task.id)!;
    expect(after.archived_at).not.toBeNull();
    expect(after.description).toContain('> ya no aplica');
  });

  it('a stale question cannot be answered after the card changed', async () => {
    const task = tasks.create({ title: 'X', description: 'Y.', swimlane_id: todoId, labels: ['approved', 'no-auto'] });
    const r = await handleRecordHumanGo({ taskId: task.id, decision: 'go', expectedRevision: task.revision + 5 }, context());
    expect(r.success).toBe(false);
  });
});
