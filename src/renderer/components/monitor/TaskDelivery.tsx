import { useRef, useState } from 'react';
import type { TaskOverviewRow } from '../../../shared/task-overview';
import type { TaskDeliveryPreview } from '../../../shared/task-delivery';
import { useTaskOverviewStore } from '../../stores/task-overview-store';
import { TaskPush } from './TaskPush';

/** A preparation surface only; no implicit commit or push. */
export function TaskDelivery({ task }: { task: TaskOverviewRow }) {
  const [preview, setPreview] = useState<TaskDeliveryPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [commit, setCommit] = useState<string | null>(null);
  const inFlight = useRef(false);
  const prepare = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setPreview(null);
    setError(null);
    setConfirmed(false);
    setCommit(null);
    try {
      const result = await useTaskOverviewStore.getState().prepareDelivery(task.projectId, task.taskId);
      setPreview(result);
      setMessage(result.suggestedMessage);
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo preparar la entrega.'); }
    finally { setPending(false); inFlight.current = false; }
  };
  const confirm = async () => {
    if (inFlight.current || !preview || !confirmed || preview.revision !== task.revision) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    setConfirmed(false);
    try {
      const result = await useTaskOverviewStore.getState().confirmDelivery(task.projectId, task.taskId,
        { revision: preview.revision, fingerprint: preview.fingerprint, message });
      setCommit(result.commit);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudo confirmar el commit. Revisa Git antes de reintentar.');
    } finally {
      // Consume this approval even on failure. Never retry an uncertain mutation.
      setPreview(null);
      setPending(false);
      inFlight.current = false;
    }
  };
  const stale = preview && preview.revision !== task.revision;
  return <div className="mt-2 text-sm space-y-2">
    <button type="button" className="px-3 py-2 rounded border border-edge disabled:opacity-50" disabled={pending} onClick={() => void prepare()}>
      {pending ? 'Preparando...' : 'Preparar entrega'}
    </button>
    {error && <p role="alert" className="text-attention">{error}</p>}
    {commit && <p role="status">Commit local creado: {commit}. Este botón no ejecuta push ni despliegue.</p>}
    {preview && <div className="space-y-2">
      <p>Vista previa de solo lectura. No se hizo commit, push ni despliegue.</p>
      {stale && <p role="alert" className="text-attention">La tarjeta cambió. Prepara una vista nueva.</p>}
      <p>Rama: {preview.branch} · HEAD: {preview.head.slice(0, 12)}</p>
      <p>Archivos que incluiría:</p>
      <ul className="list-disc pl-4">{preview.files.map((file) => <li key={file}>{file}</li>)}</ul>
      {preview.otherChangedFiles.length > 0 && <p className="text-attention">Quedan fuera: {preview.otherChangedFiles.join(', ')}</p>}
      <label className="block">Mensaje del commit
        <input className="block w-full rounded border border-edge p-2" value={message} maxLength={500}
          disabled={pending} onChange={(event) => { setMessage(event.target.value); setConfirmed(false); }} />
      </label>
      <p>Checks declarados: {preview.checks.map((check) => `${check.command}: ${check.result}`).join('; ')}</p>
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={pending || Boolean(stale)}
        onChange={(event) => setConfirmed(event.target.checked)} />Revisé los archivos y autorizo crear este commit local.</label>
      <button type="button" className="px-3 py-2 rounded border border-edge disabled:opacity-50"
        disabled={pending || !confirmed || Boolean(stale) || !message.trim()} onClick={() => void confirm()}>Crear commit local</button>
      <p className="text-fg-muted">Git ejecutará los hooks configurados del repositorio. El push requiere una acción separada.</p>
    </div>}
    <TaskPush key={`${task.projectId}:${task.taskId}:${commit ?? ''}`} task={task} />
  </div>;
}
