import { requiresUserInteraction } from './activity-state';
import type { ActivityState } from './types';

export interface TaskAttention {
  kind: 'draft' | 'queued' | 'working' | 'unknown' | 'blocked' | 'review' | 'done';
  needsHuman: boolean;
  reason: string;
  nextAction: string;
}

export interface TaskOverviewRow {
  projectId: string;
  projectName: string;
  taskId: string;
  displayId: number;
  title: string;
  columnName: string;
  labels: string[];
  priority: number;
  updatedAt: string;
  revision: number;
  attention: TaskAttention;
  /** Verbatim bounded question from the task, not an LLM instruction or approval. */
  informationRequired: string | null;
}

export function latestInformationRequired(description: string): string | null {
  const sections = description.split(/^## Información requerida\s*$/m);
  if (sections.length < 2) return null;
  return sections[sections.length - 1].split(/^## /m)[0].trim().slice(0, 800) || null;
}

export interface TaskOverviewSnapshot {
  tasks: TaskOverviewRow[];
  unavailableProjects: Array<{ projectId: string; projectName: string }>;
  generatedAt: string;
}

/** Board facts and live process state, never inferred from elapsed silence or prose approval. */
export function deriveTaskAttention(input: {
  labels: string[];
  columnName: string;
  columnRole: string | null;
  autoSpawn: boolean;
  sessionStatus?: string;
  activity?: ActivityState;
}): TaskAttention {
  const labels = new Set(input.labels.map((label) => label.trim().toLowerCase()));
  const result = (kind: TaskAttention['kind'], needsHuman: boolean, reason: string, nextAction: string): TaskAttention =>
    ({ kind, needsHuman, reason, nextAction });
  if (labels.has('no-auto') || labels.has('manual-hold')) {
    return result('blocked', true, 'Retenida manualmente', 'Revisa el motivo antes de autorizar la reanudación.');
  }
  if (labels.has('needs-info')) {
    return result('blocked', true, 'Falta información o acceso', 'Abre la tarjeta y revisa Información requerida; no hace falta aprobarla otra vez si ya tiene approved.');
  }
  if (labels.has('needs-human')) {
    return result('blocked', true, 'Requiere una decisión humana', 'Revisa la última respuesta y decide el siguiente paso; no se reanudará sola.');
  }
  if (input.columnRole === 'done') return result('done', false, 'Cerrada en el tablero', 'El cierre no acredita por sí solo un despliegue.');
  if (/^(ready|ready to merge|merge)$/i.test(input.columnName)) {
    return result('review', true, 'Resultado pendiente de revisión', 'Comprueba entregable, pruebas y estado Git antes de cerrar o autorizar operaciones.');
  }
  if (input.sessionStatus === 'running') {
    if (requiresUserInteraction(input.activity)) {
      return result('blocked', true, 'El agente está esperando', 'Abre la última respuesta o solicitud de permiso; no se autoriza automáticamente.');
    }
    if (input.activity === undefined) {
      return result('unknown', false, 'Sesión viva, actividad sin confirmar', 'Consulta la sesión; la ausencia de telemetría no demuestra un bloqueo.');
    }
    return result('working', false, 'Trabajando', 'No requiere intervención.');
  }
  if (/^(draft|backlog)$/i.test(input.columnName)) {
    return result('draft', false, 'Borrador sin ejecución', 'Edita el alcance y muévela a Approved cuando quieras ejecutarla.');
  }
  if (input.columnRole === 'todo' || /^(approved|to do)$/i.test(input.columnName)) {
    return result('queued', false, 'Pendiente de inicio', 'El router debe evaluar ruta y capacidad; no hay una sesión trabajando todavía.');
  }
  if (input.sessionStatus === 'queued') return result('queued', false, 'Sesión en cola', 'Espera a que haya capacidad disponible.');
  if (input.autoSpawn) {
    return result('blocked', true, 'Etapa activa sin sesión en ejecución', 'Revisa la última respuesta y el motivo de salida antes de reintentar; no se da por terminada.');
  }
  return result('unknown', false, 'Sin ejecución automática', 'Abre la tarjeta para elegir el siguiente paso.');
}
