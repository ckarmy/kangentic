import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTaskOverviewStore } from '../../stores/task-overview-store';
import { requestMonitorDetail } from './MonitorDetailLayer';
import { Select, INPUT_CLASS } from '../settings/shared';
import { TaskAnswerForm } from './TaskAnswerForm';
import { TaskResumeAction } from './TaskResumeAction';
import { TaskCloseout } from './TaskCloseout';
import { TaskDelivery } from './TaskDelivery';

export function TaskOverview({ attentionOnly }: { attentionOnly: boolean }) {
  const { snapshot, loading, error, refresh } = useTaskOverviewStore();
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState('');
  useEffect(() => {
    void refresh();
    // Only while this surface is mounted. No LLM, transcript or repository scans.
    const timer = setInterval(() => { void refresh(); }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  const projects = useMemo(() => [...new Map((snapshot?.tasks ?? [])
    .map((task) => [task.projectId, task.projectName])).entries()], [snapshot]);
  const tasks = (snapshot?.tasks ?? []).filter((task) => (!attentionOnly || task.attention.needsHuman)
    && (!projectId || task.projectId === projectId)
    && `${task.title} ${task.projectName} ${task.columnName} ${task.labels.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <section className="flex-1 min-h-0 flex flex-col" data-testid="task-overview">
      <div className="flex flex-wrap gap-2 p-3 border-b border-edge">
        <input className={`${INPUT_CLASS} flex-1 min-w-40`} aria-label="Buscar tarjetas" placeholder="Buscar tarjetas" value={query} onChange={(event) => setQuery(event.target.value)} />
        <Select aria-label="Proyecto" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">Todos los proyectos</option>
          {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </Select>
        <button type="button" className="p-2 rounded hover:bg-surface-hover" onClick={() => void refresh()} disabled={loading} aria-label="Actualizar tarjetas"><RefreshCw size={16} /></button>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {error && <p role="alert" className="text-sm text-attention">{error}</p>}
        {snapshot?.unavailableProjects.length ? <p role="alert" className="text-sm text-attention">No se pudieron leer: {snapshot.unavailableProjects.map((project) => project.projectName).join(', ')}. Esta vista está incompleta.</p> : null}
        {!snapshot && loading && <p className="text-sm text-fg-muted">Cargando tarjetas...</p>}
        {snapshot && tasks.length === 0 && <p className="text-sm text-fg-muted">{attentionOnly ? 'No hay tarjetas que requieran tu intervención en esta selección.' : 'No hay tarjetas en esta selección.'}</p>}
        {tasks.map((task) => (
          <article key={`${task.projectId}:${task.taskId}`}
            className="block w-full text-left p-4 rounded-lg border border-edge bg-surface hover:bg-surface-hover" data-testid="overview-task">
            <p className="text-xs text-fg-muted">{task.projectName} · {task.columnName} · #{task.displayId}</p>
            <h2 className="text-sm font-semibold text-fg mt-1"><button type="button" onClick={() => requestMonitorDetail(task.projectId, task.taskId)} className="text-left hover:underline">{task.title}</button></h2>
            {attentionOnly && task.attention.summary
              ? <p className="text-sm mt-2 text-attention" data-testid="overview-task-summary">{task.attention.summary}</p>
              : <>
                <p className={`text-sm mt-2 ${task.attention.needsHuman ? 'text-attention' : 'text-fg-muted'}`}>{task.attention.reason}</p>
                <p className="text-sm text-fg-muted mt-1">{task.attention.nextAction}</p>
              </>}
            {task.attention.needsHuman && task.informationRequired && <p className="text-sm text-fg mt-1 whitespace-pre-wrap">Pregunta registrada: {task.informationRequired}</p>}
            <TaskCloseout task={task} />
            {task.columnName === 'Ready' && <TaskDelivery task={task} />}
            {task.labels.some((label) => label.trim().toLowerCase() === 'needs-info') && <TaskAnswerForm task={task} />}
            {task.labels.some((label) => label.trim().toLowerCase() === 'needs-human')
              && !task.labels.some((label) => ['needs-info', 'manual-hold', 'no-auto', 'production'].includes(label.trim().toLowerCase()))
              && <TaskResumeAction task={task} />}
          </article>
        ))}
        {snapshot && <p className="text-xs text-fg-muted">Actualizado: {new Date(snapshot.generatedAt).toLocaleTimeString()} · Incluye tarjetas sin sesión. Archivadas: consulta el archivo del proyecto.</p>}
      </div>
    </section>
  );
}
