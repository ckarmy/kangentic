import { describe, expect, it } from 'vitest';
import { deriveTaskAttention, latestInformationRequired } from '../../src/shared/task-overview';

const base = { labels: [] as string[], columnName: 'Verify', columnRole: null, autoSpawn: true };

describe('task overview: actionable state without speculative retries', () => {
  it('shows the last explicit question bounded and verbatim, without interpreting it as approval', () => {
    expect(latestInformationRequired('No question')).toBeNull();
    expect(latestInformationRequired('## Información requerida\nOld\n## Información requerida\nWhich release?\n## Notes\nOther')).toBe('Which release?');
    expect(latestInformationRequired(`## Información requerida\n${'x'.repeat(2000)}`)?.length).toBe(800);
  });
  it('keeps an approved needs-info task blocked without asking for approval again', () => {
    const state = deriveTaskAttention({ ...base, labels: ['approved', 'needs-info', 'needs-human'] });
    expect(state.kind).toBe('blocked');
    expect(state.needsHuman).toBe(true);
    expect(state.summary).toBe('Pregunta pendiente · respóndela en la tarjeta (Información requerida)');
  });
  it('holds outrank live sessions and Ready', () => {
    expect(deriveTaskAttention({ ...base, columnName: 'Ready', labels: ['manual-hold'], sessionStatus: 'running', activity: 'thinking' }).kind).toBe('blocked');
  });
  it('Draft never claims work has started', () => {
    expect(deriveTaskAttention({ ...base, columnName: 'Draft', autoSpawn: false }).kind).toBe('draft');
  });
  it('queued is not an error', () => {
    expect(deriveTaskAttention({ ...base, sessionStatus: 'queued' }).needsHuman).toBe(false);
  });
  it('a missing live process in an active stage is not success', () => {
    expect(deriveTaskAttention({ ...base, sessionStatus: 'exited' }).kind).toBe('blocked');
    expect(deriveTaskAttention(base).needsHuman).toBe(true);
  });
  it('no telemetry on a live process is unknown, not blocked', () => {
    expect(deriveTaskAttention({ ...base, sessionStatus: 'running' }).kind).toBe('unknown');
  });
  it('permission or finished turn requires attention, not blind approval', () => {
    for (const activity of ['idle', 'permission'] as const) {
      expect(deriveTaskAttention({ ...base, sessionStatus: 'running', activity }).needsHuman).toBe(true);
    }
  });
  it('active work requires no intervention', () => {
    expect(deriveTaskAttention({ ...base, sessionStatus: 'running', activity: 'thinking' }).kind).toBe('working');
  });
  it('Ready and Done do not claim deployment', () => {
    expect(deriveTaskAttention({ ...base, columnName: 'Ready' }).kind).toBe('review');
    expect(deriveTaskAttention({ ...base, columnRole: 'done' }).nextAction).toContain('no acredita');
  });
});

const NOW = Date.parse('2026-09-22T12:00:00Z');
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;

describe('«Necesita de mí» classifier (0.42.0-luuk.2)', () => {
  it('#32: an approved card with a PROD deliverable and no go-ck is held for CK, not "pending start"', () => {
    const state = deriveTaskAttention({
      labels: ['production', 'approved'], columnName: 'Approved', columnRole: 'todo', autoSpawn: false,
      productionDeliverable: true, routerReason: 'su entregable es producción · responde k13 por Telegram', now: NOW,
    });
    expect(state.needsHuman).toBe(true);
    expect(state.reason).not.toContain('Pendiente de inicio');
    expect(state.summary).toBe('Retenida: entregable PROD (router: su entregable es producción · responde k13 por Telegram) · hazla tú o dale GO');
  });

  it('go-ck lifts the PROD hold: the card goes back to the router', () => {
    const state = deriveTaskAttention({
      labels: ['production', 'approved', 'go-ck'], columnName: 'Approved', columnRole: 'todo', autoSpawn: false,
      productionDeliverable: true, now: NOW,
    });
    expect(state.needsHuman).toBe(false);
    expect(state.kind).toBe('queued');
  });

  it('a para-ck card is always there, even in Draft', () => {
    const state = deriveTaskAttention({ labels: ['para-ck'], columnName: 'Draft', columnRole: null, autoSpawn: false, now: NOW });
    expect(state.needsHuman).toBe(true);
    expect(state.summary).toBe('Para ti · hazla tú o bórrala del tablero');
  });

  it('a Draft without para-ck is never there, whatever the router or its labels say', () => {
    for (const labels of [[], ['pedro'], ['production'], ['needs-info']]) {
      const state = deriveTaskAttention({
        labels, columnName: 'Draft', columnRole: null, autoSpawn: false,
        productionDeliverable: labels.includes('production'), routerReason: 'idea en Draft: apruébala o archívala', now: NOW,
      });
      expect(state.needsHuman).toBe(false);
      expect(state.summary).toBeNull();
    }
  });

  it('Ready waits for closing', () => {
    expect(deriveTaskAttention({ labels: [], columnName: 'Ready', columnRole: null, autoSpawn: false, now: NOW }).summary)
      .toBe('Ready · revisa y ciérrala');
  });

  it('a permission prompt is shown at once, with what to do', () => {
    const state = deriveTaskAttention({ ...base, sessionStatus: 'running', activity: 'permission', waitingSince: minutesAgo(1), now: NOW });
    expect(state.summary).toBe('Esperando tu permiso en la terminal · ábrela y responde');
  });

  it('a live session that just finished its turn is not noise; after 30 min it is "Parada"', () => {
    const fresh = deriveTaskAttention({ ...base, sessionStatus: 'running', activity: 'idle', waitingSince: minutesAgo(5), now: NOW });
    expect(fresh.needsHuman).toBe(false);
    const stuck = deriveTaskAttention({ ...base, sessionStatus: 'running', activity: 'idle', waitingSince: minutesAgo(45), now: NOW });
    expect(stuck.needsHuman).toBe(true);
    expect(stuck.summary).toBe('Parada: sesión sin actividad hace 45 min · ábrela y reanúdala, o mueve la tarjeta');
  });

  it('an agent column with no session is starting for 20 min, then "Parada"', () => {
    const starting = deriveTaskAttention({ ...base, lastChangedAt: minutesAgo(3), now: NOW });
    expect(starting.needsHuman).toBe(false);
    const stuck = deriveTaskAttention({ ...base, lastChangedAt: minutesAgo(25), now: NOW });
    expect(stuck.needsHuman).toBe(true);
    expect(stuck.summary).toContain('Parada: etapa sin sesión hace 25 min');
  });

  it('a working agent and an Approved card waiting for the router are not there', () => {
    expect(deriveTaskAttention({ ...base, sessionStatus: 'running', activity: 'thinking', now: NOW }).needsHuman).toBe(false);
    expect(deriveTaskAttention({ labels: ['approved'], columnName: 'Approved', columnRole: 'todo', autoSpawn: false, now: NOW }).needsHuman).toBe(false);
  });

  it('a manual hold and a pending decision each say what to do', () => {
    expect(deriveTaskAttention({ ...base, labels: ['manual-hold'], now: NOW }).summary)
      .toBe('Retenida manualmente · revisa el motivo y quita la retención o dale GO');
    expect(deriveTaskAttention({ ...base, labels: ['needs-human'], now: NOW }).summary)
      .toBe('Espera tu decisión · revisa la última respuesta y decide el siguiente paso');
  });
});
