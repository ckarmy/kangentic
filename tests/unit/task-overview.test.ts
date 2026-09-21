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
    expect(state.reason).toBe('Falta información o acceso');
    expect(state.nextAction).toContain('no hace falta aprobarla otra vez');
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
