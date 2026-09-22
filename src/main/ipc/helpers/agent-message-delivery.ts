/**
 * Delivery plumbing shared by every path that TYPES a column's message at a
 * live agent: the board spawn's `deliverToAgent`, the warm move's enter group,
 * and "Run again".
 *
 * Two things live here because they were missing from all of those paths:
 *
 * 1. Rung 3 of the delivery ladder (`escalate`). Only the warm move's own
 *    auto_command burst had it, so a message typed by an automation that the
 *    transcript verifier could not confirm ended as a toast and nothing else:
 *    the agent kept working without the column's rules (0.42.0-luuk.1, #14).
 *    The handler is the same allowlisted in-place restart task-move uses, so it
 *    adds no spawn entry point, and the scheduler's own guards still apply: it
 *    is attempted at most once, waits for the turn to complete, re-polls for a
 *    late confirmation first, and never fires for a confirm-only adapter
 *    (`escalatable === false`).
 *
 * 2. The run row's final word. A scheduled burst resolves long after the
 *    runner wrote "Sent", so the burst's real outcome is written back onto the
 *    same `automation_runs` row. Without it the log said "succeeded - Sent" for
 *    a message the UI was simultaneously reporting as not delivered.
 */

import type { AutomationRunStatus } from '../../../shared/types';
import type { AutomationRunRepository } from '../../db/repositories/automation-run-repository';
import type { EscalationHandler, InjectionReport } from '../../transition-engine/terminal-submit-scheduler';
import type { IpcContext } from '../ipc-context';
import { withTaskLock } from '../task-lifecycle-lock';
import { restartSessionForSettingsChange } from '../handlers/session-reconcile';

/**
 * Restart the task's session with the unconfirmed message as the resume
 * prompt. Resolves true when the restart was issued.
 *
 * Takes the task lock: `restartSessionForSettingsChange` mutates per-task
 * session state and requires it. Not reentrant, because the scheduler calls
 * this long after the move that scheduled the burst released the lock.
 */
export function buildMessageEscalation(
  context: IpcContext,
  projectId: string,
  projectPath: string | null,
  taskId: string,
): EscalationHandler {
  return async (commands) => {
    if (!projectPath) return false;
    return withTaskLock(taskId, async () => {
      const restarted = await restartSessionForSettingsChange(
        context,
        projectId,
        projectPath,
        taskId,
        { phase: 'resending-command', resumePrompt: commands.join('\n') },
      );
      return restarted.ok;
    });
  };
}

/** The run-row status and detail a finished burst earns. Pure, for tests. */
export function describeMessageOutcome(report: InjectionReport): { status: AutomationRunStatus; detail: string } {
  if (report.escalated) {
    return {
      status: 'succeeded',
      detail: 'Typing it could not be confirmed, so the session was restarted with it as the prompt.',
    };
  }
  switch (report.outcome) {
    case 'confirmed':
      return { status: 'succeeded', detail: 'Confirmed in the agent transcript.' };
    case 'unconfirmed':
      return { status: 'succeeded', detail: 'Typed at the agent. This agent cannot confirm delivery.' };
    case 'cancelled':
    case 'aborted':
      return { status: 'interrupted', detail: report.reason ?? 'Cancelled before it was delivered.' };
    default:
      return { status: 'failed', detail: report.reason ?? 'The message could not be delivered.' };
  }
}

/**
 * Write a finished burst's outcome onto its automation run. Best effort: the
 * auto-command channel already recorded it on the task, and a DB hiccup here
 * must not throw inside the scheduler's outcome callback.
 */
export function recordMessageRunOutcome(
  runs: AutomationRunRepository | null | undefined,
  runId: string | undefined,
  report: InjectionReport,
): void {
  if (!runs || !runId) return;
  const { status, detail } = describeMessageOutcome(report);
  try {
    runs.finish(runId, status, detail, 1);
  } catch (caughtError) {
    console.error(`[automations] Failed to record the message outcome for run ${runId.slice(0, 8)}:`, caughtError);
  }
}
