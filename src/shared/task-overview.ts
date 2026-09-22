import { requiresUserInteraction } from './activity-state';
import type { ActivityState } from './types';

export interface TaskAttention {
  kind: 'draft' | 'queued' | 'working' | 'unknown' | 'blocked' | 'review' | 'done';
  /** True exactly when the task belongs in «Necesita de mí». */
  needsHuman: boolean;
  reason: string;
  nextAction: string;
  /**
   * One line for «Necesita de mí»: why it is there and what to do, e.g.
   * «Retenida: entregable PROD · hazla tú o dale GO». Null when the task does
   * not need the human.
   */
  summary: string | null;
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

/** A live session idle this long in an agent column is shown as stopped. */
export const STALLED_SESSION_MS = 30 * 60_000;
/** An agent column this long without a running session is shown as stopped. */
export const STALLED_NO_SESSION_MS = 20 * 60_000;

/** Labels that hold a card until a human acts (the router's hold set). */
const MANUAL_HOLD_LABELS = ['manual-hold', 'no-auto'];

export interface TaskAttentionInput {
  labels: string[];
  columnName: string;
  columnRole: string | null;
  autoSpawn: boolean;
  sessionStatus?: string;
  activity?: ActivityState;
  /**
   * When the live session entered its current waiting state (the activity
   * reason's `since`, epoch ms). Null or absent when unknown.
   */
  waitingSince?: number | null;
  /**
   * The card declares a PROD deliverable (label `production`/`prod-deploy`, or
   * the `Requiere producción: sí` / `Entregable en vivo: sí` field). Computed
   * by the caller with the same rule the server guard uses.
   */
  productionDeliverable?: boolean;
  /** The router's latest reason for handing this card to CK, if it gave one. */
  routerReason?: string | null;
  /**
   * Best available instant the card last changed (a move updates it), epoch
   * ms. Used only to tell a stage that is still starting from one that stopped.
   * Null or absent is treated as "long ago": a stage with no session and no
   * evidence it just started is not reported as fine.
   */
  lastChangedAt?: number | null;
  now?: number;
}

function minutesSince(since: number, now: number): number {
  return Math.max(0, Math.round((now - since) / 60_000));
}

/**
 * Board facts, the server guard and live process state, never inferred from
 * prose approval.
 *
 * `needsHuman` is the «Necesita de mí» membership and is deliberately narrow:
 * a `para-ck` card, a card held for CK (a PROD deliverable without `go-ck`, a
 * manual hold, an open question or decision), a card in Ready, a session
 * waiting on a permission, and a stage that has STOPPED (a live session idle
 * past `STALLED_SESSION_MS`, or an agent column with no session past
 * `STALLED_NO_SESSION_MS`). A Draft is never there unless it carries `para-ck`.
 * Everything else is the router's or the agent's business and stays in «Todas».
 */
export function deriveTaskAttention(input: TaskAttentionInput): TaskAttention {
  const labels = new Set(input.labels.map((label) => label.trim().toLowerCase()));
  const now = input.now ?? Date.now();
  const quiet = (kind: TaskAttention['kind'], reason: string, nextAction: string): TaskAttention =>
    ({ kind, needsHuman: false, reason, nextAction, summary: null });
  const forMe = (kind: TaskAttention['kind'], reason: string, nextAction: string): TaskAttention =>
    ({ kind, needsHuman: true, reason, nextAction, summary: `${reason} · ${nextAction}` });
  const routerNote = input.routerReason?.trim() ? ` (router: ${input.routerReason.trim()})` : '';

  const isDraft = /^(draft|backlog)$/i.test(input.columnName);
  if (labels.has('para-ck')) {
    return forMe('blocked', 'Para ti', 'hazla tú o bórrala del tablero');
  }
  if (isDraft) {
    return quiet('draft', 'Borrador sin ejecución', 'Edita el alcance y muévela a Approved cuando quieras ejecutarla.');
  }
  if (input.columnRole === 'done') return quiet('done', 'Cerrada en el tablero', 'El cierre no acredita por sí solo un despliegue.');

  if (labels.has('needs-info')) {
    return forMe('blocked', 'Pregunta pendiente', 'respóndela en la tarjeta (Información requerida)');
  }
  if (input.productionDeliverable && !labels.has('go-ck')) {
    return forMe('blocked', `Retenida: entregable PROD${routerNote}`, 'hazla tú o dale GO');
  }
  if (MANUAL_HOLD_LABELS.some((label) => labels.has(label))) {
    return forMe('blocked', 'Retenida manualmente', 'revisa el motivo y quita la retención o dale GO');
  }
  if (labels.has('pedro') && !labels.has('approved') && !labels.has('go-ck')) {
    return forMe('blocked', 'Retenida: propuesta de Pedro sin aprobar', 'apruébala o archívala');
  }
  if (labels.has('needs-human')) {
    return forMe('blocked', 'Espera tu decisión', 'revisa la última respuesta y decide el siguiente paso');
  }
  if (/^(ready|ready to merge|merge)$/i.test(input.columnName)) {
    return forMe('review', 'Ready', 'revisa y ciérrala');
  }

  if (input.sessionStatus === 'running') {
    if (requiresUserInteraction(input.activity)) {
      // activity-state-ok: permission-specific text, the bucket is decided above.
      if (input.activity === 'permission') {
        return forMe('blocked', 'Esperando tu permiso en la terminal', 'ábrela y responde');
      }
      const since = input.waitingSince ?? null;
      if (since !== null && now - since < STALLED_SESSION_MS) {
        return quiet('working', 'Terminó su turno hace poco', 'Espera a que complete la etapa; no requiere intervención todavía.');
      }
      const detail = since === null ? 'sesión sin actividad' : `sesión sin actividad hace ${minutesSince(since, now)} min`;
      return forMe('blocked', `Parada: ${detail}`, 'ábrela y reanúdala, o mueve la tarjeta');
    }
    if (input.activity === undefined) {
      return quiet('unknown', 'Sesión viva, actividad sin confirmar', 'Consulta la sesión; la ausencia de telemetría no demuestra un bloqueo.');
    }
    return quiet('working', 'Trabajando', 'No requiere intervención.');
  }
  if (input.routerReason?.trim()) {
    return forMe('blocked', `Retenida por el router: ${input.routerReason.trim()}`, 'revísala y decide');
  }
  if (input.columnRole === 'todo' || /^(approved|to do)$/i.test(input.columnName)) {
    return quiet('queued', 'Pendiente de inicio', 'El router la tomará cuando haya ruta y capacidad.');
  }
  if (input.sessionStatus === 'queued') return quiet('queued', 'Sesión en cola', 'Espera a que haya capacidad disponible.');
  if (input.autoSpawn) {
    const changed = input.lastChangedAt ?? null;
    if (changed !== null && now - changed < STALLED_NO_SESSION_MS) {
      return quiet('queued', 'Arrancando la etapa', 'La sesión debería iniciar en breve.');
    }
    const detail = changed === null ? 'etapa sin sesión' : `etapa sin sesión hace ${minutesSince(changed, now)} min`;
    return forMe('blocked', `Parada: ${detail}`, 'reanúdala o mueve la tarjeta; revisa antes el motivo de salida');
  }
  return quiet('unknown', 'Sin ejecución automática', 'Abre la tarjeta para elegir el siguiente paso.');
}
