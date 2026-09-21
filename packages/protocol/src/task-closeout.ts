export interface TaskCloseoutReport {
  version: 1;
  taskId: string;
  summary: string;
  files: string[];
  checks: Array<{ command: string; result: 'passed' | 'failed' | 'not-run'; evidence: string }>;
  head: string;
  delivery: string;
  deployment: string;
  nextAction: string;
}

export interface TaskCloseoutSnapshot {
  state: 'missing' | 'invalid' | 'reported';
  message: string;
  report?: TaskCloseoutReport;
  observedHead?: string;
  headMatches?: boolean;
  worktreeDirty?: boolean;
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** Validate at the mobile trust boundary; never render a different task's report. */
export function parseTaskCloseoutSnapshot(value: unknown, taskId: string): TaskCloseoutSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (!['missing', 'invalid', 'reported'].includes(String(snapshot.state)) || !text(snapshot.message, 4000)) return null;
  if (snapshot.state !== 'reported') return { state: snapshot.state as 'missing' | 'invalid', message: snapshot.message };
  const report = parseTaskCloseout(snapshot.report, taskId);
  if (!report) return null;
  if (snapshot.observedHead !== undefined && (typeof snapshot.observedHead !== 'string' || !/^[a-f0-9]{40,64}$/i.test(snapshot.observedHead))) return null;
  for (const key of ['headMatches', 'worktreeDirty']) {
    if (snapshot[key] !== undefined && typeof snapshot[key] !== 'boolean') return null;
  }
  return { state: 'reported', message: snapshot.message, report,
    ...(snapshot.observedHead !== undefined ? { observedHead: snapshot.observedHead as string } : {}),
    ...(snapshot.headMatches !== undefined ? { headMatches: snapshot.headMatches as boolean } : {}),
    ...(snapshot.worktreeDirty !== undefined ? { worktreeDirty: snapshot.worktreeDirty as boolean } : {}),
  };
}

/** Untrusted agent-authored data. No embedded commands or paths are executed. */
export function parseTaskCloseout(value: unknown, taskId: string): TaskCloseoutReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  if (report.version !== 1 || report.taskId !== taskId || !text(report.summary, 2000)
      || !text(report.head, 64) || !/^[a-f0-9]{40,64}$/i.test(report.head)
      || !text(report.delivery, 1000) || !text(report.deployment, 1000) || !text(report.nextAction, 2000)
      || !Array.isArray(report.files) || report.files.length > 100
      || !report.files.every((file) => text(file, 300))
      || !Array.isArray(report.checks) || report.checks.length > 30) return null;
  const checks: TaskCloseoutReport['checks'] = [];
  for (const check of report.checks) {
    if (!check || typeof check !== 'object' || Array.isArray(check)) return null;
    const entry = check as Record<string, unknown>;
    if (!text(entry.command, 1000) || !text(entry.evidence, 2000)
        || !['passed', 'failed', 'not-run'].includes(String(entry.result))) return null;
    checks.push({ command: entry.command, result: entry.result as 'passed' | 'failed' | 'not-run', evidence: entry.evidence });
  }
  return { version: 1, taskId, summary: report.summary, files: report.files as string[], checks,
    head: report.head, delivery: report.delivery, deployment: report.deployment, nextAction: report.nextAction };
}
