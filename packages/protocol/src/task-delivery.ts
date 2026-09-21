import type { TaskCloseoutReport } from './task-closeout';

export interface TaskDeliveryConfirmation { revision: number; fingerprint: string; message: string }
export interface TaskDeliveryCommitResult { commit: string; branch: string }
export interface TaskDeliveryOperation {
  id: string;
  taskId: string;
  kind: 'commit' | 'push';
  status: 'running' | 'succeeded' | 'uncertain';
  message: string;
  result?: TaskDeliveryCommitResult;
}
export interface TaskPushPreview { revision: number; branch: string; head: string; destination: string; fingerprint: string }
export interface TaskDeliveryPreview {
  taskId: string;
  revision: number;
  branch: string;
  head: string;
  fingerprint: string;
  files: string[];
  otherChangedFiles: string[];
  suggestedMessage: string;
  checks: TaskCloseoutReport['checks'];
}
