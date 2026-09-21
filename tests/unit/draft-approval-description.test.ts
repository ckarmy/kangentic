import { expect, it } from 'vitest';
import { acknowledgeDraftApproval } from '../../src/shared/draft-approval-description';

it('updates stale generated approval text without removing scope or missing information', () => {
  const original = `No modificar código ni producción.\n<!-- kangentic-draft:v1 source=${'a'.repeat(64)} -->\nEstado: NECESITA APROBACIÓN\nFalta: Añade la label humana approved y luego mueve la tarjeta a Approved.\n<!-- /kangentic-draft -->\n## Información requerida\nAdjunta trazas.`;
  const result = acknowledgeDraftApproval(original);
  expect(result).toContain('APROBACIÓN HUMANA REGISTRADA');
  expect(result).not.toContain('Añade la label');
  expect(result).toContain('No modificar código ni producción.');
  expect(result).toContain('Adjunta trazas.');
  expect(acknowledgeDraftApproval(result)).toBe(result);
});
it('does not rewrite user text or risk decisions', () => {
  const original = `Estado: NECESITA APROBACIÓN\n<!-- kangentic-draft:v1 source=${'a'.repeat(64)} -->\nEstado: REQUIERE REVISIÓN HUMANA\nFalta: Define límites.\n<!-- /kangentic-draft -->`;
  expect(acknowledgeDraftApproval(original)).toBe(original);
});
