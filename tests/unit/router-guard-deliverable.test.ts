import { describe, expect, it } from 'vitest';
import {
  routerDeleteGuarded,
  routerGuarded,
  routerProductionDeliverable,
  routerTaskHeld,
} from '../../src/main/agent/commands/task-commands';

const guarded = (labels: string[], title: string, description = '') =>
  routerGuarded(labels, `${title}\n${description}`);

describe('server guard holds on a declared PROD deliverable, not on words', () => {
  it('does not hold a card that only mentions main.js', () => {
    expect(guarded([], 'Arreglar GetAcciones en cloud/main.js', 'Editar main.js y probar en QA.')).toBe(false);
  });

  it('does not hold a card that says it has no deploy', () => {
    expect(guarded([], 'Revisar logs', 'Solo lectura, sin deploy. Borrar datos: no.')).toBe(false);
    expect(guarded([], 'Haz deploy a production y migra la DB.')).toBe(false);
  });

  it('holds «Requiere producción: sí» in the description', () => {
    expect(guarded([], 'Cobranza', 'Contexto.\nRequiere producción: sí\n')).toBe(true);
    expect(guarded([], 'Cobranza', 'Requiere produccion: si')).toBe(true);
    expect(guarded([], 'Cobranza', 'Requiere producción: no')).toBe(false);
  });

  it('holds the router Draft field «Entregable en vivo: sí» and the old «Entregable PROD: sí»', () => {
    expect(guarded([], 'x', 'DATOS PARA EL ROUTER\nEntregable en vivo: sí\nRuta: Executing')).toBe(true);
    expect(guarded([], 'x', '- **Entregable PROD:** sí')).toBe(true);
    expect(guarded([], 'x', 'Entregable en vivo: no')).toBe(false);
  });

  it('holds the production and prod-deploy labels', () => {
    expect(guarded(['production'], 'Tarea normal')).toBe(true);
    expect(guarded(['prod-deploy'], 'Tarea normal')).toBe(true);
    expect(routerProductionDeliverable(['prod-deploy'], '')).toBe(true);
  });

  it('go-ck releases a PROD deliverable but not a question or a manual pause', () => {
    expect(guarded(['production', 'go-ck'], 'x', 'Requiere producción: sí')).toBe(false);
    expect(guarded(['prod-deploy', 'go-ck'], 'x')).toBe(false);
    expect(guarded(['production', 'go-ck', 'needs-info'], 'x')).toBe(true);
    expect(guarded(['go-ck', 'manual-hold'], 'x')).toBe(true);
  });

  it('risky only raises review; it no longer holds', () => {
    expect(routerTaskHeld(['risky'])).toBe(false);
    expect(guarded(['risky'], 'Refactor grande')).toBe(false);
  });

  it('deletion by an agent stays strict and never honors go-ck', () => {
    expect(routerDeleteGuarded(['production', 'go-ck'], 'x')).toBe(true);
    expect(routerDeleteGuarded(['go-ck'], 'x\nRequiere producción: sí')).toBe(true);
    expect(routerDeleteGuarded(['risky'], 'x')).toBe(true);
    expect(routerDeleteGuarded([], 'Haz deploy a production')).toBe(true);
    expect(routerDeleteGuarded([], 'Tarea normal de QA')).toBe(false);
  });
});
