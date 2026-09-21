import type { IpcContext } from '../ipc/ipc-context';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import { deriveTaskAttention, latestInformationRequired, type TaskOverviewSnapshot } from '../../shared/task-overview';

/** Read-only task inventory, including Drafts with no session and inactive projects. */
export function buildTaskOverview(context: IpcContext): TaskOverviewSnapshot {
  const snapshot: TaskOverviewSnapshot = { tasks: [], unavailableProjects: [], generatedAt: new Date().toISOString() };
  const managedSessions = context.sessionManager.listManagedSummaries();
  const activity = context.sessionManager.getActivityCache();
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
        snapshot.tasks.push({
          projectId: project.id, projectName: project.name, taskId: task.id,
          displayId: task.display_id, title: task.title, labels: task.labels,
          revision: task.revision,
          priority: task.priority, updatedAt: task.updated_at, columnName: column?.name ?? '',
          informationRequired: latestInformationRequired(task.description ?? ''),
          attention: deriveTaskAttention({
            labels: task.labels, columnName: column?.name ?? '', columnRole: column?.role ?? null,
            autoSpawn: column?.auto_spawn ?? false, sessionStatus: session?.status,
            activity: session ? activity[session.id] : undefined,
          }),
        });
      }
    } catch {
      snapshot.unavailableProjects.push({ projectId: project.id, projectName: project.name });
    }
  }
  return snapshot;
}
