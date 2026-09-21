import { useRef, useState } from 'react';
import type { TaskOverviewRow } from '../../../shared/task-overview';
import { useTaskOverviewStore } from '../../stores/task-overview-store';
import { INPUT_CLASS } from '../settings/shared';

export function TaskAnswerForm({ task }: { task: TaskOverviewRow }) {
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState('');
  const [revision, setRevision] = useState(task.revision);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const save = async () => {
    if (inFlight.current || !answer.trim()) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      await useTaskOverviewStore.getState().answerTask(task.projectId, task.taskId, answer, revision);
      setEditing(false);
      setAnswer('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudo guardar. Tu respuesta se conserva.');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  if (!editing) return <button type="button" className="text-sm underline mt-2" onClick={() => { setRevision(task.revision); setEditing(true); }}>Responder pregunta</button>;
  return <form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label className="block text-sm">Tu respuesta
      <textarea className={`${INPUT_CLASS} block w-full mt-1`} value={answer} maxLength={4000} rows={3} disabled={saving} onChange={(event) => setAnswer(event.target.value)} />
    </label>
    <p className="text-xs text-fg-muted">Guardar no reanuda ni autoriza producción. La tarjeta seguirá pausada.</p>
    {task.revision !== revision && <p role="alert" className="text-sm text-attention">La tarjeta cambió. Cancela y revisa la pregunta actual antes de responder.</p>}
    {error && <p role="alert" className="text-sm text-attention">{error}</p>}
    <div className="flex gap-3 text-sm">
      <button type="submit" disabled={saving || !answer.trim() || task.revision !== revision} className="underline disabled:opacity-50">{saving ? 'Guardando...' : 'Guardar respuesta'}</button>
      <button type="button" disabled={saving} onClick={() => { setEditing(false); setError(null); }}>Cancelar</button>
    </div>
  </form>;
}
