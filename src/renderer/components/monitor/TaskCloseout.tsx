import { useRef, useState } from 'react';
import type { TaskOverviewRow } from '../../../shared/task-overview';
import type { TaskCloseoutSnapshot } from '../../../shared/task-closeout';
import { useTaskOverviewStore } from '../../stores/task-overview-store';

export function TaskCloseout({ task }: { task: TaskOverviewRow }) {
  const [snapshot, setSnapshot] = useState<TaskCloseoutSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try { setSnapshot(await useTaskOverviewStore.getState().getTaskCloseout(task.projectId, task.taskId)); }
    catch { setSnapshot({ state: 'missing', message: 'No se pudo leer el resultado. Reintenta cuando haya conexión.' }); }
    finally { setLoading(false); inFlight.current = false; }
  };
  const report = snapshot?.report;
  return <div className="mt-2 text-sm">
    <button type="button" className="underline disabled:opacity-50" disabled={loading} onClick={() => void load()}>{loading ? 'Leyendo resultado...' : snapshot ? 'Actualizar resultado' : 'Ver resultado y pruebas'}</button>
    {snapshot && <p className="text-fg-muted mt-2">{snapshot.message}</p>}
    {report && <div className="mt-2 space-y-2">
      <p className="whitespace-pre-wrap">{report.summary}</p>
      <p>Archivos declarados: {report.files.join(', ') || 'ninguno'}</p>
      <p>Git observado: {snapshot.observedHead?.slice(0, 12) ?? 'no disponible'}.
        {snapshot.headMatches === false ? ' El commit cambió desde el informe.' : snapshot.headMatches ? ' Coincide con el informe.' : ''}
        {snapshot.worktreeDirty === true ? ' Hay cambios sin commit; la coincidencia de HEAD no verifica esos cambios.' : snapshot.worktreeDirty === false ? ' Árbol limpio salvo el informe.' : ''}</p>
      <ul className="list-disc pl-4">{report.checks.map((check, index) => <li key={index}>{check.command}: {check.result} (declarado). {check.evidence}</li>)}</ul>
      {!report.checks.length && <p>No hay checks declarados.</p>}
      <p>Entrega: {report.delivery}</p><p>Despliegue: {report.deployment}</p>
      <p>Siguiente acción: {report.nextAction}</p>
    </div>}
  </div>;
}
