import type { Task } from '../../../shared/types';

const HUMAN_HOLD_LABELS = new Set(['needs-info', 'needs-human', 'manual-hold', 'no-auto']);

/** Human-attention labels suppress every automatic startup path. */
export function isHeldForHuman(task: Pick<Task, 'labels'>): boolean {
  return (task.labels ?? []).some((label) => HUMAN_HOLD_LABELS.has(label.trim().toLowerCase()));
}
