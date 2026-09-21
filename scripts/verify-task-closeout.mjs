import { build } from 'esbuild';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const betterSqliteEntry = require.resolve('better-sqlite3');
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'kangentic-task-closeout-'));
const bundlePath = path.join(temporaryDirectory, 'verify-task-closeout.cjs');

const probeSource = `
  import Database from ${JSON.stringify(betterSqliteEntry)};
  import { runProjectMigrations } from './src/main/db/migrations/project-schema';
  import { TaskCloseoutRepository } from './src/main/db/repositories/task-closeout-repository';

  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runProjectMigrations(database);
  runProjectMigrations(database);
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_closeouts'").get();
  if (!table) throw new Error('task_closeouts migration did not create the table');

  const swimlane = database.prepare('SELECT id FROM swimlanes ORDER BY position LIMIT 1').get();
  if (!swimlane) throw new Error('migration did not seed a swimlane');
  database.prepare('INSERT INTO tasks (id, revision, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('closeout-task', 7, 'Closeout verification', '', swimlane.id, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

  const report = {
    version: 1, taskId: 'closeout-task', summary: 'Saved in memory.', files: [],
    checks: [{ command: 'probe', result: 'passed', evidence: 'verified' }],
    head: 'a'.repeat(40), delivery: 'No push.', deployment: 'No deployment.', nextAction: 'Review.',
  };
  const closeouts = new TaskCloseoutRepository(database);
  closeouts.save('closeout-task', 7, report);
  if (JSON.stringify(closeouts.get('closeout-task')) !== JSON.stringify(report)) throw new Error('saved report was not readable');
  if (closeouts.get('closeout-task', 8) !== null) throw new Error('a closeout from a different task revision was accepted');

  database.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', 'closeout-task');
  if (!closeouts.get('closeout-task')) throw new Error('archiving removed the closeout');
  database.prepare('DELETE FROM tasks WHERE id = ?').run('closeout-task');
  const remaining = database.prepare('SELECT COUNT(*) AS count FROM task_closeouts').get();
  if (remaining.count !== 0) throw new Error('deleting a task did not cascade its closeout');
  database.close();
  console.log('task-closeout SQLite probe passed');
`;

try {
  const result = await build({
    stdin: {
      contents: probeSource,
      resolveDir: process.cwd(),
      sourcefile: 'verify-task-closeout.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    write: false,
    external: [betterSqliteEntry],
  });
  writeFileSync(bundlePath, result.outputFiles[0].text);
  const execution = spawnSync(electronPath, ['-e', `require(${JSON.stringify(bundlePath)})`], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (execution.status !== 0) {
    throw new Error(execution.stderr || execution.stdout || `Electron exited with status ${execution.status}`);
  }
  if (!execution.stdout.includes('task-closeout SQLite probe passed')) {
    throw new Error('Electron exited without the task-closeout SQLite probe success marker');
  }
  process.stdout.write(execution.stdout);
} finally {
  if (existsSync(bundlePath)) unlinkSync(bundlePath);
  rmdirSync(temporaryDirectory);
}
