import { useRef, useState } from 'react';
import type { TaskOverviewRow } from '../../../shared/task-overview';
import type { TaskPushPreview } from '../../../shared/task-delivery';
import { useTaskOverviewStore } from '../../stores/task-overview-store';

export function TaskPush({ task }: { task: TaskOverviewRow }) {
  const [preview, setPreview] = useState<TaskPushPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const busy = useRef(false);
  const prepare = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true); setPreview(null); setConfirmed(false); setNotice('');
    try { setPreview(await useTaskOverviewStore.getState().preparePush(task.projectId, task.taskId)); }
    catch (failure) { setNotice(failure instanceof Error ? failure.message : 'No se pudo preparar el push.'); }
    finally { busy.current = false; setPending(false); }
  };
  const push = async () => {
    if (busy.current || !preview || !confirmed || preview.revision !== task.revision) return;
    busy.current = true;
    setPending(true); setConfirmed(false); setNotice('');
    try {
      const result = await useTaskOverviewStore.getState().confirmPush(task.projectId, task.taskId, preview.revision, preview.fingerprint);
      setNotice(`Push confirmado: ${result.commit} en ${result.branch}. No se hizo merge ni despliegue desde este botón.`);
    } catch (failure) { setNotice(failure instanceof Error ? failure.message : 'Resultado incierto. Revisa el remoto antes de reintentar.'); }
    finally { busy.current = false; setPending(false); setPreview(null); }
  };
  return <div className="mt-2 space-y-2 text-sm">
    <button type="button" disabled={pending} onClick={() => void prepare()} className="rounded border border-edge px-3 py-2 disabled:opacity-50">Preparar push</button>
    {notice && <p role="status">{notice}</p>}
    {preview && <div className="space-y-2">
      <p>Destino: {preview.destination}</p><p>Rama: {preview.branch}</p><p>Commit: {preview.head}</p>
      <p>Se sube este commit y su historial. Los hooks y CI del repositorio pueden activarse.</p>
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={pending || preview.revision !== task.revision}
        onChange={(event) => setConfirmed(event.target.checked)} />Autorizo subir esta rama a este destino.</label>
      <button type="button" disabled={pending || !confirmed || preview.revision !== task.revision} onClick={() => void push()}
        className="rounded border border-edge px-3 py-2 disabled:opacity-50">Confirmar push</button>
    </div>}
  </div>;
}
