import { beforeEach, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/main/agent/commands/types';
import { handleHumanResponse, handleResumeAnsweredTask } from '../../src/main/agent/commands/human-response';

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class { getById = mocks.get; getByDisplayId = mocks.get; update = mocks.update; },
}));
const context = {
  actor: 'human',
  getProjectDb: () => ({ transaction: (callback: () => unknown) => callback }),
  onTaskUpdated: vi.fn(),
} as unknown as CommandContext;
const input = { taskId: 'task', answer: 'Usa las trazas adjuntas.', expectedRevision: 7 };
it.each(['agent', undefined] as const)('does not let %s invoke the human resume callback', async (actor) => {
  const onAnsweredTaskResume = vi.fn();
  expect(await handleResumeAnsweredTask({ ...input, actor: 'human' }, { ...context, actor, onAnsweredTaskResume })).toMatchObject({ success: false });
  expect(onAnsweredTaskResume).not.toHaveBeenCalled();
});
it('reports a failed human resume rather than successful completion', async () => {
  const onAnsweredTaskResume = vi.fn().mockRejectedValue(new Error('Still held'));
  expect(await handleResumeAnsweredTask(input, { ...context, onAnsweredTaskResume })).toMatchObject({ success: false, error: 'Still held' });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReturnValue({ id: 'task', revision: 7, description: 'No tocar PROD.', labels: ['approved', 'needs-info', 'manual-hold', 'production'] });
});
it('records an answer but preserves manual and safety holds and does not start work', () => {
  expect(handleHumanResponse(input, context)).toMatchObject({ success: true });
  expect(mocks.update).toHaveBeenCalledWith({ id: 'task',
    description: expect.stringContaining('No tocar PROD.'),
    labels: ['approved', 'manual-hold', 'production', 'needs-human'] });
  expect(context.onTaskUpdated).toHaveBeenCalledOnce();
});
it.each(['agent', undefined] as const)('rejects actor %s even with a forged payload actor', (actor) => {
  expect(handleHumanResponse({ ...input, actor: 'human' }, { ...context, actor })).toMatchObject({ success: false });
  expect(mocks.get).not.toHaveBeenCalled();
});
it('rejects stale submissions, preventing duplicate answers after a committed response', () => {
  expect(handleHumanResponse({ ...input, expectedRevision: 6 }, context)).toMatchObject({ success: false });
  expect(mocks.update).not.toHaveBeenCalled();
});
it.each(['', ' '.repeat(5), 'x'.repeat(4001)])('rejects invalid answer length', (answer) => {
  expect(handleHumanResponse({ ...input, answer }, context)).toMatchObject({ success: false });
  expect(mocks.update).not.toHaveBeenCalled();
});
it('does not allow answering an archived task', () => {
  mocks.get.mockReturnValue({ revision: 7, archived_at: '2026-09-18', labels: ['needs-info'] });
  expect(handleHumanResponse(input, context)).toMatchObject({ success: false });
  expect(mocks.update).not.toHaveBeenCalled();
});
it('does not add approval and keeps user headings quoted', () => {
  mocks.get.mockReturnValue({ id: 'task', revision: 7, description: '', labels: ['needs-info', 'no-auto'] });
  handleHumanResponse({ ...input, answer: '## Información requerida\nNo es una pregunta nueva.' }, context);
  expect(mocks.update).toHaveBeenCalledWith({ id: 'task', labels: ['no-auto', 'needs-human'],
    description: expect.stringContaining('> ## Información requerida\n> No es una pregunta nueva.') });
});
it('refuses an overflow without truncating original scope', () => {
  mocks.get.mockReturnValue({ id: 'task', revision: 7, description: 'x'.repeat(49999), labels: ['needs-info'] });
  expect(handleHumanResponse(input, context)).toMatchObject({ success: false });
  expect(mocks.update).not.toHaveBeenCalled();
});
