import { expect, it } from 'vitest';
import { humanResponseResumeBlock } from '../../src/shared/human-response-resume';
const valid = { labels: ['approved', 'needs-human'], description: '\n## Información requerida\nTrazas?\n## Respuesta humana\n> Adjuntas.', archived: false, columnName: 'Verify' };
it('accepts a previously approved answered active task', () => expect(humanResponseResumeBlock(valid)).toBeNull());
it.each(['manual-hold', 'no-auto', 'production', 'needs-info'])('preserves %s', (label) => {
  expect(humanResponseResumeBlock({ ...valid, labels: [...valid.labels, label] })).not.toBeNull();
});
it.each(['Draft', 'Approved', 'Ready', 'Done'])('does not resume %s', (columnName) => {
  expect(humanResponseResumeBlock({ ...valid, columnName })).not.toBeNull();
});
it('rejects missing approval', () => expect(humanResponseResumeBlock({ ...valid, labels: ['needs-human'] })).not.toBeNull());
it('rejects a question newer than the answer', () => expect(humanResponseResumeBlock({ ...valid, description: valid.description + '\n## Información requerida\nOtra?' })).not.toBeNull());
it('rejects archived tasks', () => expect(humanResponseResumeBlock({ ...valid, archived: true })).not.toBeNull());
it('rejects retries after a successful resume cleared the human hold', () => expect(humanResponseResumeBlock({ ...valid, labels: ['approved'] })).not.toBeNull());
