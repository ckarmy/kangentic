import { create } from 'zustand';
import type { TaskOverviewSnapshot } from '../../shared/task-overview';
import type { TaskCloseoutSnapshot } from '../../shared/task-closeout';
import type { TaskDeliveryPreview } from '../../shared/task-delivery';

interface TaskOverviewState {
  snapshot: TaskOverviewSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  getTaskCloseout: (projectId: string, taskId: string) => Promise<TaskCloseoutSnapshot>;
  prepareDelivery: (projectId: string, taskId: string) => Promise<TaskDeliveryPreview>;
  preparePush: (projectId: string, taskId: string) => Promise<import('../../shared/task-delivery').TaskPushPreview>;
  confirmPush: (projectId: string, taskId: string, revision: number, fingerprint: string) => Promise<import('../../shared/task-delivery').TaskDeliveryCommitResult>;
  confirmDelivery: (projectId: string, taskId: string, confirmation: import('../../shared/task-delivery').TaskDeliveryConfirmation) => Promise<import('../../shared/task-delivery').TaskDeliveryCommitResult>;
  answerTask: (projectId: string, taskId: string, answer: string, revision: number) => Promise<void>;
  resumeAnsweredTask: (projectId: string, taskId: string, revision: number) => Promise<void>;
}

function createTaskOverviewStore() {
  return create<TaskOverviewState>((set, get) => ({
    snapshot: null, loading: false, error: null,
    getTaskCloseout: (projectId, taskId) => window.electronAPI.monitor.getTaskCloseout(taskId, projectId),
    prepareDelivery: (projectId, taskId) => window.electronAPI.monitor.prepareDelivery(taskId, projectId),
    preparePush: (projectId, taskId) => window.electronAPI.monitor.preparePush(taskId, projectId),
    confirmPush: (projectId, taskId, revision, fingerprint) => window.electronAPI.monitor.confirmPush(taskId, revision, fingerprint, projectId),
    confirmDelivery: (projectId, taskId, confirmation) => window.electronAPI.monitor.confirmDelivery(taskId, confirmation, projectId),
    resumeAnsweredTask: async (projectId, taskId, revision) => {
      await window.electronAPI.monitor.resumeAnsweredTask(taskId, revision, projectId);
      await get().refresh();
    },
    answerTask: async (projectId, taskId, answer, revision) => {
      const result = await window.electronAPI.monitor.answerTask(taskId, answer, revision, projectId);
      if (!result.success) throw new Error(result.error ?? 'No se pudo guardar la respuesta.');
      await get().refresh();
    },
    refresh: async () => {
      if (get().loading) return;
      set({ loading: true });
      try {
        const snapshot = await window.electronAPI.monitor.getTaskOverview();
        set({ snapshot, error: null });
      } catch {
        set({ error: 'No se pudo actualizar. Los datos anteriores pueden estar desactualizados.' });
      } finally { set({ loading: false }); }
    },
  }));
}

// @ts-expect-error -- Vite supplies import.meta.hot in this CommonJS-typed project.
export const useTaskOverviewStore: ReturnType<typeof createTaskOverviewStore> = import.meta.hot?.data?.taskOverviewStore ?? createTaskOverviewStore();
// @ts-expect-error -- Vite HMR preserves the in-flight state and snapshot.
if (import.meta.hot) {
  // @ts-expect-error -- Vite provides this object.
  import.meta.hot.data.taskOverviewStore = useTaskOverviewStore;
  // @ts-expect-error -- Vite updates non-component consumers.
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
