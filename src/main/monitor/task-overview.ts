import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IpcContext } from '../ipc/ipc-context';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import { routerProductionDeliverable } from '../agent/commands/task-commands';
import { deriveTaskAttention, latestInformationRequired, type TaskOverviewSnapshot } from '../../shared/task-overview';

/** The router's summary is only trusted while fresh; a stale hold is not evidence. */
const ROUTER_SUMMARY_MAX_AGE_MS = 2 * 60 * 60_000;

/**
 * Where the external router writes its summary. Overridable for tests and for
 * a machine that keeps the agenda repo elsewhere.
 */
export function routerSummaryPath(): string {
  return process.env.KANGENTIC_ROUTER_SUMMARY
    || path.join(os.homedir(), 'Documents', 'luuk-agenda', 'kangentic-resumen.json');
}

/**
 * The router's latest "for CK" reasons, keyed `projectName#displayId`.
 * Optional by design: a missing, unreadable, malformed or stale file yields an
 * empty map, and the classifier then relies on the labels and the guard alone.
 */
export function readRouterReasons(filePath: string = routerSummaryPath(), now: number = Date.now()): Map<string, string> {
  const reasons = new Map<string, string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      generado?: string;
      paraCK?: Array<{ proyecto?: string; n?: number; motivo?: string }>;
    };
    const generatedAt = Date.parse(parsed.generado ?? '');
    if (Number.isNaN(generatedAt) || now - generatedAt > ROUTER_SUMMARY_MAX_AGE_MS) return reasons;
    for (const entry of parsed.paraCK ?? []) {
      if (typeof entry.proyecto !== 'string' || typeof entry.n !== 'number' || typeof entry.motivo !== 'string') continue;
      reasons.set(`${entry.proyecto}#${entry.n}`, entry.motivo.slice(0, 200));
    }
  } catch {
    // Optional input; see above.
  }
  return reasons;
}

/** Read-only task inventory, including Drafts with no session and inactive projects. */
export function buildTaskOverview(context: IpcContext): TaskOverviewSnapshot {
  const snapshot: TaskOverviewSnapshot = { tasks: [], unavailableProjects: [], generatedAt: new Date().toISOString() };
  const managedSessions = context.sessionManager.listManagedSummaries();
  const activity = context.sessionManager.getActivityCache();
  const reasons = context.sessionManager.getActivityReasonsCache?.() ?? {};
  const routerReasons = readRouterReasons();
  const now = Date.now();
  for (const project of context.projectRepo.list()) {
    try {
      const repositories = getProjectRepos(context, project.id);
      const columns = new Map(repositories.swimlanes.list().map((column) => [column.id, column]));
      for (const task of repositories.tasks.list()) {
        const column = columns.get(task.swimlane_id);
        // Isolated review sessions need not be the task's main session_id.
        const sessions = managedSessions.filter((session) => !session.transient
          && session.projectId === project.id && session.taskId === task.id);
        const session = sessions.find((entry) => entry.status === 'running')
          ?? sessions.find((entry) => entry.status === 'queued');
        const reason = session ? reasons[session.id] : undefined;
        const labels = task.labels ?? [];
        const normalizedLabels = labels.map((label) => label.trim().toLowerCase());
        const updatedAt = Date.parse(task.updated_at ?? '');
        snapshot.tasks.push({
          projectId: project.id, projectName: project.name, taskId: task.id,
          displayId: task.display_id, title: task.title, labels,
          revision: task.revision,
          priority: task.priority, updatedAt: task.updated_at, columnName: column?.name ?? '',
          informationRequired: latestInformationRequired(task.description ?? ''),
          attention: deriveTaskAttention({
            labels, columnName: column?.name ?? '', columnRole: column?.role ?? null,
            autoSpawn: column?.auto_spawn ?? false, sessionStatus: session?.status,
            activity: session ? activity[session.id] : undefined,
            waitingSince: reason && 'since' in reason ? reason.since : null,
            // The server guard's own rule, so the monitor cannot call a card
            // "pending start" while the guard is holding it for CK.
            productionDeliverable: routerProductionDeliverable(normalizedLabels, `${task.title}\n${task.description ?? ''}`),
            routerReason: routerReasons.get(`${project.name}#${task.display_id}`) ?? null,
            lastChangedAt: Number.isNaN(updatedAt) ? null : updatedAt,
            now,
          }),
        });
      }
    } catch {
      snapshot.unavailableProjects.push({ projectId: project.id, projectName: project.name });
    }
  }
  return snapshot;
}
