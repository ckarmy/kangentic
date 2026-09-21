import { expect, it } from 'vitest';
import { parseTaskCloseout, parseTaskCloseoutSnapshot } from '../../src/shared/task-closeout';
const valid = { version: 1, taskId: 'one', summary: 'Investigación terminada', files: ['result.md'],
  checks: [{ command: 'test', result: 'not-run', evidence: 'No aplica al informe' }],
  head: 'a'.repeat(40), delivery: 'Sin commit ni push', deployment: 'No realizado', nextAction: 'Revisar informe' };
it('keeps declared evidence without upgrading not-run to passed', () => {
  expect(parseTaskCloseout(valid, 'one')?.checks[0].result).toBe('not-run');
});
it('rejects a report from another task sharing the same checkout', () => expect(parseTaskCloseout(valid, 'two')).toBeNull());
it.each([null, [], {}, { ...valid, summary: '' }, { ...valid, head: 'main' },
  { ...valid, checks: [{ command: 'test', result: 'passed', evidence: '' }] },
  { ...valid, files: new Array(101).fill('x') }])('rejects malformed or oversized reports', (report) => {
  expect(parseTaskCloseout(report, 'one')).toBeNull();
});

it('accepts a reported snapshot only when its report belongs to the requested task', () => {
  const snapshot = parseTaskCloseoutSnapshot({
    state: 'reported', message: 'Declared result found.', report: valid,
    observedHead: 'b'.repeat(40), headMatches: false, worktreeDirty: true,
  }, 'one');

  expect(snapshot).toMatchObject({ state: 'reported', report: { taskId: 'one' }, observedHead: 'b'.repeat(40), headMatches: false, worktreeDirty: true });
  expect(parseTaskCloseoutSnapshot({ state: 'reported', message: 'Found.', report: { ...valid, taskId: 'two' } }, 'one')).toBeNull();
});

it.each([
  null,
  {},
  { state: 'unknown', message: 'Nope' },
  { state: 'missing', message: '' },
  { state: 'reported', message: 'Found.', report: valid, observedHead: 'main' },
  { state: 'reported', message: 'Found.', report: valid, headMatches: 'yes' },
  { state: 'reported', message: 'Found.', report: valid, worktreeDirty: 1 },
])('rejects malformed closeout snapshots', (snapshot) => {
  expect(parseTaskCloseoutSnapshot(snapshot, 'one')).toBeNull();
});

it('retains only state and message for missing and invalid snapshots', () => {
  expect(parseTaskCloseoutSnapshot({ state: 'missing', message: 'No result.' }, 'one'))
    .toEqual({ state: 'missing', message: 'No result.' });
  expect(parseTaskCloseoutSnapshot({ state: 'invalid', message: 'Unreadable result.', report: valid }, 'one'))
    .toEqual({ state: 'invalid', message: 'Unreadable result.' });
});
