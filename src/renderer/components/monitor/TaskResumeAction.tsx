import { useRef, useState } from 'react';
import type { TaskOverviewRow } from '../../../shared/task-overview';
import { useTaskOverviewStore } from '../../stores/task-overview-store';

export function TaskResumeAction({ task }: { task: TaskOverviewRow }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const resume = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await useTaskOverviewStore.getState().resumeAnsweredTask(task.projectId, task.taskId, task.revision);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se confirmó la reanudación. Revisa la sesión antes de reintentar.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return <div className="mt-2 text-sm">
    <p className="text-fg-muted">Continúa solo el alcance aprobado con la respuesta guardada. No autoriza producción.</p>
    <button type="button" disabled={pending} className="underline disabled:opacity-50" onClick={() => void resume()}>{pending ? 'Reanudando...' : 'Reanudar con mi respuesta'}</button>
    {error && <p role="alert" className="text-attention mt-1">{error}</p>}
  </div>;
}
