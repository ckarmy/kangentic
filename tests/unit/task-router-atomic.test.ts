import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { handleCompleteRouteStage, handleCreateTask, handleDeleteTask, handleMoveTask, handlePrepareDraft, handleRequestHumanInput, handleRouteTask, handleSyncExternalDraft, handleUpdateTask, nextRouteStage } from '../../src/main/agent/commands/task-commands';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { TaskRepository, taskFingerprint } from '../../src/main/db/repositories/task-repository';
import { restorePendingRouteDestination, retireOrphanTaskSessions, routeLifecycleNeedsRecovery } from '../../src/main/ipc/handlers/task-move';
import { handleCreateBacklogTask, handlePromoteBacklog, handleUpdateBacklogItem } from '../../src/main/agent/commands/backlog-commands';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';

describe('atomic task router contract', () => {
  let db: Database.Database;
  let tasks: TaskRepository;
  let todoId: string;
  let draftId: string;
  let planningId: string;
  let executingId: string;
  let reviewId: string;
  let verifyId: string;
  let readyId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runProjectMigrations(db);
    tasks = new TaskRepository(db);
    todoId = (db.prepare("SELECT id FROM swimlanes WHERE role='todo'").get() as { id: string }).id;
    draftId = 'draft-lane';
    db.prepare(`INSERT INTO swimlanes (id, name, position, color, auto_spawn, created_at)
      VALUES (?, 'Draft', -1, '#64748b', 0, ?)`).run(draftId, new Date().toISOString());
    planningId = (db.prepare("SELECT id FROM swimlanes WHERE name='Planning'").get() as { id: string }).id;
    executingId = (db.prepare("SELECT id FROM swimlanes WHERE name='Executing'").get() as { id: string }).id;
    const now = new Date().toISOString();
    for (const [id, name, position] of [
      ['review-lane', 'Review', 20], ['verify-lane', 'Verify', 21], ['ready-lane', 'Ready', 22],
    ] as const) db.prepare(`INSERT INTO swimlanes (id, name, position, color, created_at)
      VALUES (?, ?, ?, '#64748b', ?)`).run(id, name, position, now);
    reviewId = 'review-lane';
    verifyId = 'verify-lane';
    readyId = 'ready-lane';
  });

  afterEach(() => db.close());

  it('commits profile, move and dispatch once, then links the first session', () => {
    const task = tasks.create({ title: 'Implement clear feature', description: 'Bounded low-risk implementation.', swimlane_id: todoId });
    const expectedFingerprint = taskFingerprint(task, 'project-1');
    const input = {
      taskId: task.id,
      targetSwimlaneId: planningId,
      targetPosition: 0,
      expectedRevision: task.revision,
      expectedFingerprint,
      policyVersion: 'policy-1',
      profileId: 'profile-balanced',
      workflow: 'review-test',
      dispatchId: '11111111-1111-4111-8111-111111111111',
      projectId: 'project-1',
    };

    expect(tasks.routeFromTodo(input)).toEqual({ status: 'applied', revision: 1 });
    const routed = tasks.getById(task.id)!;
    expect(routed.swimlane_id).toBe(planningId);
    expect(routed.profile_id).toBe('profile-balanced');
    expect(routed.pending_dispatch_id).toBe(input.dispatchId);
    expect(routed.revision).toBe(1);
    expect(tasks.routeFromTodo(input)).toEqual({ status: 'duplicate', revision: 1 });

    const sessions = new SessionRepository(db);
    const record = sessions.insert({
      id: 'session-1', task_id: task.id, session_type: 'codex', isolated_swimlane_id: null,
      agent_session_id: null, command: 'codex', cwd: 'C:/tmp', permission_mode: 'default',
      prompt: null, status: 'running', exit_code: null, started_at: new Date().toISOString(),
      suspended_at: null, exited_at: null, suspended_by: null,
    });
    expect(record.dispatch_id).toBe(input.dispatchId);
    expect(tasks.getById(task.id)!.pending_dispatch_id).toBeNull();
    expect((db.prepare('SELECT session_id FROM route_dispatches WHERE dispatch_id=?').get(input.dispatchId) as { session_id: string }).session_id)
      .toBe('session-1');
  });

  it('rejects stale content and dispatch-id reuse with different intent', () => {
    const task = tasks.create({ title: 'Implement clear feature', description: 'Bounded low-risk implementation.', swimlane_id: todoId });
    const base = {
      taskId: task.id, targetSwimlaneId: planningId, targetPosition: 0,
      expectedRevision: task.revision, expectedFingerprint: taskFingerprint(task, 'project-1'),
      policyVersion: 'policy-1', profileId: 'profile-balanced', workflow: 'direct',
      dispatchId: '22222222-2222-4222-8222-222222222222', projectId: 'project-1',
    };
    tasks.update({ id: task.id, description: 'Changed after routing decision.' });
    expect(() => tasks.routeFromTodo(base)).toThrow(/revision changed/);

    const fresh = tasks.getById(task.id)!;
    const applied = { ...base, expectedRevision: fresh.revision, expectedFingerprint: taskFingerprint(fresh, 'project-1') };
    expect(tasks.routeFromTodo(applied).status).toBe('applied');
    expect(() => tasks.routeFromTodo({ ...applied, workflow: 'review' })).toThrow(/already used/);
  });

  it('server handler holds Pedro until human approval and then accepts the route', async () => {
    const profile = { id: 'profile-balanced', name: 'Balanced', columns: {} };
    const onTaskRoute = vi.fn(async () => undefined);
    const context = {
      projectId: 'project-1', getProjectDb: () => db, getBoardProfiles: () => [profile], onTaskRoute,
    } as any;
    const pedro = tasks.create({
      title: '[Pedro] Investigate anomaly', description: 'Evidence from Sentry.', labels: ['pedro'], swimlane_id: todoId,
    });
    const refused = await handleRouteTask({
      taskId: pedro.id, destination: 'Executing', profile: 'Balanced', expectedRevision: pedro.revision,
      expectedFingerprint: taskFingerprint(pedro, 'project-1'), expectedPolicyVersion: 'p1', workflow: 'direct',
      dispatchId: '33333333-3333-4333-8333-333333333333',
    }, context);
    expect(refused.success).toBe(false);
    expect(onTaskRoute).not.toHaveBeenCalled();

    const approvedPedro = tasks.update({ id: pedro.id, labels: ['pedro', 'approved'] });
    const approved = await handleRouteTask({
      taskId: approvedPedro.id, destination: 'Executing', profile: 'Balanced', expectedRevision: approvedPedro.revision,
      expectedFingerprint: taskFingerprint(approvedPedro, 'project-1'), expectedPolicyVersion: 'p1', workflow: 'direct',
      dispatchId: '33333333-3333-4333-8333-333333333334',
    }, context);
    expect(approved.success).toBe(true);
    expect(onTaskRoute).toHaveBeenCalledOnce();
    onTaskRoute.mockClear();

    const safe = tasks.create({
      title: 'Fix bounded validation bug', description: 'Add the missing empty-string validation and its unit test.', swimlane_id: todoId,
    });
    const accepted = await handleRouteTask({
      taskId: safe.id, destination: 'Planning', profile: 'Balanced', expectedRevision: safe.revision,
      expectedFingerprint: taskFingerprint(safe, 'project-1'), expectedPolicyVersion: 'p1', workflow: 'review-test',
      dispatchId: '44444444-4444-4444-8444-444444444444',
    }, context);
    expect(accepted.success).toBe(true);
    expect(onTaskRoute).toHaveBeenCalledOnce();
    expect(onTaskRoute.mock.calls[0][0]).toMatchObject({
      taskId: safe.id, targetSwimlaneId: planningId, profileId: profile.id, workflow: 'review-test', projectId: 'project-1',
    });
  });

  it('records one bounded human question without moving the active task', () => {
    const task = tasks.create({ title: 'Need decision', description: 'Context', swimlane_id: executingId });
    const onTaskUpdated = vi.fn();
    const response = handleRequestHumanInput({ taskId: task.id, question: '¿Qué ambiente debo usar?' }, {
      getProjectDb: () => db, onTaskUpdated,
    } as any);
    expect(response.success).toBe(true);
    const updated = tasks.getById(task.id)!;
    expect(updated.swimlane_id).toBe(executingId);
    expect(updated.labels).toEqual(expect.arrayContaining(['needs-info', 'needs-human']));
    expect(updated.description).toContain('¿Qué ambiente debo usar?');
    expect(onTaskUpdated).toHaveBeenCalledOnce();

    const completion = handleCompleteRouteStage({ taskId: task.id, stage: 'Executing' }, {
      getProjectDb: () => db,
    } as any);
    expect(completion.success).toBe(false);
    expect(completion.error).toMatch(/held or sensitive/);
  });

  it('general agent moves cannot bypass Done or held-task gates', () => {
    const onTaskMove = vi.fn(async () => undefined);
    const context = { getProjectDb: () => db, onTaskMove } as any;
    const normal = tasks.create({ title: 'Normal task', description: 'A normal bounded task.', swimlane_id: todoId });
    const toDone = handleMoveTask({ taskId: normal.id, column: 'Done' }, context);
    expect(toDone.success).toBe(false);
    expect(toDone.error).toMatch(/human approval/);

    const held = tasks.create({ title: 'Held task', description: 'Must remain held.', labels: ['no-auto'], swimlane_id: todoId });
    const bypass = handleMoveTask({ taskId: held.id, column: 'Executing' }, context);
    expect(bypass.success).toBe(false);
    expect(bypass.error).toMatch(/held or sensitive/);
    expect(onTaskMove).not.toHaveBeenCalled();
  });

  it('requires UI-human GO for every move out of Draft', () => {
    const onTaskMove = vi.fn(async () => undefined);
    const context = { getProjectDb: () => db, onTaskMove } as any;
    const draft = tasks.create({ title: 'Draft proposal', description: 'Not authorized.', swimlane_id: draftId });
    for (const column of ['To Do', 'Executing']) {
      const response = handleMoveTask({ taskId: draft.id, column }, context);
      expect(response.success).toBe(false);
      expect(response.error).toMatch(/human must provide GO/);
    }
    expect(onTaskMove).not.toHaveBeenCalled();
  });

  it('prepares held Drafts through a narrow revision-checked description-only write', () => {
    const onTaskPrepared = vi.fn();
    const context = { getProjectDb: () => db, onTaskPrepared, onTaskUpdated: vi.fn() } as any;
    const draft = tasks.create({
      title: '[Pedro] Evidence', description: 'Original evidence.', labels: ['pedro', 'manual-hold'],
      priority: 3, swimlane_id: draftId,
    });
    const block = '<!-- kangentic-draft:v1 source=' + 'a'.repeat(64) + ' -->\n'
      + '## Preparación Kangentic\n\n- **Proyecto:** luukFull\n<!-- /kangentic-draft -->';
    const prepared = handlePrepareDraft({ taskId: draft.id, expectedRevision: draft.revision, block }, context);
    expect(prepared).toMatchObject({ success: true, data: { action: 'prepared', taskId: draft.id } });
    const updated = tasks.getById(draft.id)!;
    expect(updated.description).toBe(`Original evidence.\n\n${block}`);
    expect(updated.labels).toEqual(['pedro', 'manual-hold']);
    expect(updated.priority).toBe(3);
    expect(updated.swimlane_id).toBe(draftId);
    expect(updated.session_id).toBeNull();
    expect(onTaskPrepared).toHaveBeenCalledOnce();
    expect(context.onTaskUpdated).not.toHaveBeenCalled();

    expect(handlePrepareDraft({ taskId: draft.id, expectedRevision: draft.revision, block }, context))
      .toMatchObject({ success: false, error: expect.stringMatching(/revision changed/) });
    expect(handlePrepareDraft({ taskId: draft.id, expectedRevision: updated.revision, block: 'arbitrary text' }, context))
      .toMatchObject({ success: false, error: expect.stringMatching(/preparation block/) });

    const active = tasks.create({ title: 'Active', description: '', swimlane_id: todoId });
    expect(handlePrepareDraft({ taskId: active.id, expectedRevision: active.revision, block }, context))
      .toMatchObject({ success: false, error: expect.stringMatching(/no longer in Draft/) });
  });

  it('atomically upserts Trello Draft by external id and permanently detaches after promotion', () => {
    const onTaskCreated = vi.fn();
    const onTaskUpdated = vi.fn();
    const context = { getProjectDb: () => db, onTaskCreated, onTaskUpdated, onTaskPrepared: vi.fn() } as any;
    const base = {
      externalId: 'trello-card-1', externalUrl: 'https://trello.com/c/one',
      title: 'Trello idea', description: 'Evidence v1',
    };
    const created = handleSyncExternalDraft(base, context);
    expect(created.success).toBe(true);
    expect(created.data).toMatchObject({ action: 'created' });
    const taskId = (created.data as any).taskId;
    expect(onTaskCreated).toHaveBeenCalledOnce();
    expect(tasks.getById(taskId)).toMatchObject({
      swimlane_id: draftId, external_id: 'trello-card-1', external_source: 'trello_draft',
      use_worktree: null,
    });
    expect(handleUpdateTask({ taskId, title: 'Agent edit' }, context)).toMatchObject({ success: false });
    expect(handleDeleteTask({ taskId }, context)).toMatchObject({ success: false });

    const retry = handleSyncExternalDraft(base, context);
    expect(retry.success).toBe(true);
    expect(retry.data).toMatchObject({ action: 'unchanged', taskId });
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE external_id='trello-card-1'").get()).toEqual({ c: 1 });

    const beforePrepare = tasks.getById(taskId)!;
    const block = '<!-- kangentic-draft:v1 source=' + 'b'.repeat(64) + ' -->\n'
      + '## Preparación Kangentic\n\n- **Proyecto:** luukFull\n<!-- /kangentic-draft -->';
    expect(handlePrepareDraft({ taskId, expectedRevision: beforePrepare.revision, block }, context).success).toBe(true);
    const updated = handleSyncExternalDraft({ ...base, description: 'Evidence v2' }, context);
    expect(updated.data).toMatchObject({ action: 'updated', taskId });
    expect(tasks.getById(taskId)!.description).toBe(`Evidence v2\n\n${block}`);

    tasks.move({ taskId, targetSwimlaneId: executingId, targetPosition: 0 });
    const detached = handleSyncExternalDraft({ ...base, description: 'Must not overwrite active work' }, context);
    expect(detached.data).toMatchObject({ action: 'detached', taskId });
    expect(tasks.getById(taskId)).toMatchObject({
      description: `Evidence v2\n\n${block}`, external_source: 'trello_draft_detached',
    });

    tasks.move({ taskId, targetSwimlaneId: draftId, targetPosition: 0 });
    const returned = handleSyncExternalDraft({ ...base, description: 'Still must not overwrite' }, context);
    expect(returned.data).toMatchObject({ action: 'detached', taskId });
    expect(tasks.getById(taskId)!.description).toBe(`Evidence v2\n\n${block}`);
  });

  it('cannot adopt or overwrite an unrelated Draft through a claimed legacy id', () => {
    const protectedDraft = tasks.create({
      title: '[Pedro] Protected proposal', description: 'Human evidence', swimlane_id: draftId,
      labels: ['pedro'],
    });
    const context = { getProjectDb: () => db, onTaskCreated: vi.fn(), onTaskUpdated: vi.fn() } as any;
    const created = handleSyncExternalDraft({
      externalId: 'new-card', externalUrl: 'https://trello.com/c/new',
      title: 'External card', description: 'External body', knownTaskId: protectedDraft.id,
    }, context);
    expect(created.data).toMatchObject({ action: 'created' });
    expect((created.data as any).taskId).not.toBe(protectedDraft.id);
    expect(tasks.getById(protectedDraft.id)).toMatchObject({
      title: '[Pedro] Protected proposal', description: 'Human evidence', external_id: null,
    });
  });

  it('agents cannot self-grant approval or mutate held work', async () => {
    const context = { getProjectDb: () => db, getProjectPath: () => 'C:/tmp/project' } as any;
    const created = handleCreateTask({ title: 'Self approved', labels: ['approved'] }, context);
    await expect(created).resolves.toMatchObject({ success: false, error: expect.stringMatching(/human action/) });

    const normal = tasks.create({ title: 'Normal task', description: 'Bounded.', swimlane_id: todoId });
    const approve = handleUpdateTask({ taskId: normal.id, labels: ['approved'] }, context);
    expect(approve.success).toBe(false);
    expect(approve.error).toMatch(/human action/);

    const held = tasks.create({ title: 'Held task', description: 'Bounded.', labels: ['no-auto'], swimlane_id: todoId });
    const removeHold = handleUpdateTask({ taskId: held.id, labels: [] }, context);
    expect(removeHold.success).toBe(false);
    expect(removeHold.error).toMatch(/held or sensitive/);

    const directActive = await handleCreateTask({ title: 'Skip router', column: 'Executing', labels: ['no-auto'] }, context);
    expect(directActive.success).toBe(false);
    expect(directActive.error).toMatch(/only in Draft or To Do/);

    const onTaskCreated = vi.fn();
    const draftContext = { ...context, onTaskCreated, onLabelColorsChanged: vi.fn() } as any;
    const draft = await handleCreateTask({ title: 'Safe proposal', column: 'Draft', labels: ['pedro'], useWorktree: false }, draftContext);
    expect(draft.success).toBe(true);
    expect(draft.data).toMatchObject({ column: 'Draft' });
    expect(onTaskCreated).toHaveBeenCalledOnce();
  });

  it('allows an authenticated human mobile action to edit or delete held work', () => {
    const onTaskUpdated = vi.fn();
    const onTaskDeleted = vi.fn();
    const context = {
      actor: 'human', getProjectDb: () => db, getProjectPath: () => 'C:/tmp/project',
      onTaskUpdated, onTaskDeleted,
    } as any;
    const held = tasks.create({
      title: '[Pedro] Sensitive proposal', description: 'Review production evidence.',
      labels: ['pedro', 'manual-hold', 'risky'], swimlane_id: draftId,
    });

    // The mobile form sends a sparse patch, unlike the MCP schema which fills
    // omitted optional fields with null. Priority and labels must be preserved.
    const edited = handleUpdateTask({ taskId: held.id, title: '[Pedro] Edited by CK' }, context);
    expect(edited).toMatchObject({ success: true, data: { title: '[Pedro] Edited by CK' } });
    expect(tasks.getById(held.id)).toMatchObject({
      title: '[Pedro] Edited by CK', priority: held.priority, labels: held.labels,
    });
    expect(onTaskUpdated).toHaveBeenCalledOnce();

    const deleted = handleDeleteTask({ taskId: held.id }, context);
    expect(deleted).toMatchObject({ success: true, data: { id: held.id } });
    expect(tasks.getById(held.id)).toBeUndefined();
    expect(onTaskDeleted).toHaveBeenCalledOnce();
  });

  it('Backlog cannot carry agent approval or bypass To Do', async () => {
    const context = {
      getProjectDb: () => db,
      getProjectPath: () => 'C:/tmp/project',
      onBacklogChanged: vi.fn(), onLabelColorsChanged: vi.fn(), onTaskCreated: vi.fn(),
    } as any;
    const forbidden = handleCreateBacklogTask({ title: 'Forbidden', labels: ['pedro', 'approved'] }, context);
    expect(forbidden.success).toBe(false);
    expect(forbidden.error).toMatch(/human action/);

    const created = handleCreateBacklogTask({ title: 'Pedro proposal', labels: ['pedro'] }, context);
    expect(created.success).toBe(true);
    const itemId = (created.data as any).id;
    const updated = handleUpdateBacklogItem({ itemId, labels: ['pedro', 'approved'] }, context);
    expect(updated.success).toBe(false);
    const stripHold = handleUpdateBacklogItem({ itemId, labels: [] }, context);
    expect(stripHold.success).toBe(false);
    expect(stripHold.error).toMatch(/remove protected/);
    const promoted = handlePromoteBacklog({ itemIds: [itemId], column: 'Executing' }, context);
    expect(promoted.success).toBe(false);
    expect(promoted.error).toMatch(/only to To Do/);

    const viaCreateTask = await handleCreateTask({ title: 'Backlog approved', column: 'Backlog', labels: ['approved'] }, context);
    expect(viaCreateTask.success).toBe(false);
    const promoteProtected = handlePromoteBacklog({ itemIds: [itemId], column: 'To Do' }, context);
    expect(promoteProtected.success).toBe(false);
    expect(promoteProtected.error).toMatch(/promoted by a human/);
  });

  it('derives the conditional route and never maps Ready to Done', () => {
    expect(nextRouteStage('Planning', 'review-test')).toBe('Executing');
    expect(nextRouteStage('Executing', 'direct')).toBe('Ready');
    expect(nextRouteStage('Executing', 'review')).toBe('Review');
    expect(nextRouteStage('Executing', 'test')).toBe('Verify');
    expect(nextRouteStage('Review', 'review-test')).toBe('Verify');
    expect(nextRouteStage('Verify', 'review-test')).toBe('Ready');
    expect(nextRouteStage('Ready', 'review-test')).toBeNull();
  });

  it('advances each successful stage once and leaves Ready for the human', async () => {
    const task = tasks.create({
      title: 'Implement bounded feature', description: 'Implement a bounded feature with review and tests.', swimlane_id: todoId,
    });
    const dispatchId = '55555555-5555-4555-8555-555555555555';
    tasks.routeFromTodo({
      taskId: task.id, targetSwimlaneId: executingId, targetPosition: 0,
      expectedRevision: task.revision, expectedFingerprint: taskFingerprint(task, 'project-1'),
      policyVersion: 'policy-1', profileId: 'profile-balanced', workflow: 'review-test',
      dispatchId, projectId: 'project-1',
    });
    const onTaskMove = vi.fn(async (input) => tasks.move(input));
    const context = { projectId: 'project-1', getProjectDb: () => db, onTaskMove } as any;

    for (const [stage, expected] of [['Executing', reviewId], ['Review', verifyId], ['Verify', readyId]] as const) {
      const response = await handleCompleteRouteStage({ taskId: task.id, stage }, context);
      expect(response.success).toBe(true);
      await vi.waitFor(() => expect(tasks.getById(task.id)!.swimlane_id).toBe(expected));
    }
    const retry = await handleCompleteRouteStage({ taskId: task.id, stage: 'Verify' }, context);
    expect(retry.success).toBe(true);
    expect(retry.data).toMatchObject({ duplicate: true, target: 'Ready' });
    expect(onTaskMove).toHaveBeenCalledTimes(3);
  });

  it('deduplicates a repeated completion while its move is in flight', async () => {
    const task = tasks.create({ title: 'Small task', description: 'A clear bounded task.', swimlane_id: todoId });
    tasks.routeFromTodo({
      taskId: task.id, targetSwimlaneId: executingId, targetPosition: 0,
      expectedRevision: task.revision, expectedFingerprint: taskFingerprint(task, 'project-1'),
      policyVersion: 'policy-1', profileId: 'profile-balanced', workflow: 'direct',
      dispatchId: '66666666-6666-4666-8666-666666666666', projectId: 'project-1',
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const onTaskMove = vi.fn(async (input) => { await pending; tasks.move(input); });
    const context = { projectId: 'project-1', getProjectDb: () => db, onTaskMove } as any;
    const first = await handleCompleteRouteStage({ taskId: task.id, stage: 'Executing' }, context);
    const duplicate = await handleCompleteRouteStage({ taskId: task.id, stage: 'Executing' }, context);
    expect(first.success).toBe(true);
    expect(duplicate.success).toBe(true);
    expect(duplicate.data).toMatchObject({ duplicate: true });
    expect(onTaskMove).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(tasks.getById(task.id)!.swimlane_id).toBe(readyId));
  });

  it('reclaims a stale pending completion after a crash before move', async () => {
    const task = tasks.create({ title: 'Recover completion', description: 'A clear bounded task.', swimlane_id: todoId });
    const dispatchId = '67676767-6767-4767-8767-676767676767';
    tasks.routeFromTodo({
      taskId: task.id, targetSwimlaneId: executingId, targetPosition: 0,
      expectedRevision: task.revision, expectedFingerprint: taskFingerprint(task, 'project-1'),
      policyVersion: 'policy-1', profileId: 'profile-balanced', workflow: 'direct',
      dispatchId, projectId: 'project-1',
    });
    const routed = tasks.getById(task.id)!;
    expect(tasks.claimRouteStageCompletion({
      taskId: routed.id, dispatchId, stage: 'Executing', taskRevision: routed.revision,
      currentSwimlaneId: executingId, targetSwimlaneId: readyId,
    }).status).toBe('claimed');
    db.prepare(`UPDATE route_stage_completions SET updated_at = ? WHERE dispatch_id = ? AND stage = ?`)
      .run(new Date(Date.now() - 16 * 60_000).toISOString(), dispatchId, 'Executing');

    const onTaskMove = vi.fn(async (input) => tasks.move(input));
    const context = { projectId: 'project-1', getProjectDb: () => db, onTaskMove } as any;
    const recovered = await handleCompleteRouteStage({ taskId: task.id, stage: 'Executing' }, context);
    expect(recovered.success).toBe(true);
    expect(recovered.data).toMatchObject({ duplicate: false, target: 'Ready' });
    await vi.waitFor(() => expect(tasks.getById(task.id)!.swimlane_id).toBe(readyId));
    expect(onTaskMove).toHaveBeenCalledOnce();
  });

  it('a late retry cannot complete the next stage', async () => {
    const task = tasks.create({ title: 'Reviewed task', description: 'A task that requires review and verification.', swimlane_id: todoId });
    tasks.routeFromTodo({
      taskId: task.id, targetSwimlaneId: executingId, targetPosition: 0,
      expectedRevision: task.revision, expectedFingerprint: taskFingerprint(task, 'project-1'),
      policyVersion: 'policy-1', profileId: 'profile-balanced', workflow: 'review-test',
      dispatchId: '77777777-7777-4777-8777-777777777777', projectId: 'project-1',
    });
    const onTaskMove = vi.fn(async (input) => tasks.move(input));
    const context = { projectId: 'project-1', getProjectDb: () => db, onTaskMove } as any;
    expect((await handleCompleteRouteStage({ taskId: task.id, stage: 'Executing' }, context)).success).toBe(true);
    await vi.waitFor(() => expect(tasks.getById(task.id)!.swimlane_id).toBe(reviewId));
    const retry = await handleCompleteRouteStage({ taskId: task.id, stage: 'Executing' }, context);
    expect(retry.success).toBe(true);
    expect(retry.data).toMatchObject({ duplicate: true, target: 'Review' });
    expect(tasks.getById(task.id)!.swimlane_id).toBe(reviewId);
    expect(onTaskMove).toHaveBeenCalledOnce();

    // Even if a human sends the task back for rework, a delayed completion
    // from the prior Executing run remains a duplicate and cannot skip rework.
    tasks.move({ taskId: task.id, targetSwimlaneId: executingId, targetPosition: 0 });
    const staleAfterRework = await handleCompleteRouteStage({ taskId: task.id, stage: 'Executing' }, context);
    expect(staleAfterRework.success).toBe(true);
    expect(staleAfterRework.data).toMatchObject({ duplicate: true, target: 'Review' });
    expect(tasks.getById(task.id)!.swimlane_id).toBe(executingId);
    expect(onTaskMove).toHaveBeenCalledOnce();
  });

  it('recovers only the matching pending dispatch and retires orphan PTYs before retry', async () => {
    expect(routeLifecycleNeedsRecovery({ pending_dispatch_id: 'dispatch-1' } as any, 'dispatch-1')).toBe(true);
    expect(routeLifecycleNeedsRecovery({ pending_dispatch_id: null } as any, 'dispatch-1')).toBe(false);
    expect(routeLifecycleNeedsRecovery({ pending_dispatch_id: 'other' } as any, 'dispatch-1')).toBe(false);

    const sessionManager = {
      listSessions: vi.fn(() => [
        { id: 'orphan-1', taskId: 'task-1' },
        { id: 'other-1', taskId: 'other-task' },
      ]),
      killByTaskId: vi.fn(),
      awaitExit: vi.fn(async () => undefined),
      removeByTaskId: vi.fn(),
    } as any;
    await retireOrphanTaskSessions(sessionManager, 'task-1');
    expect(sessionManager.killByTaskId).toHaveBeenCalledWith('task-1');
    expect(sessionManager.awaitExit).toHaveBeenCalledOnce();
    expect(sessionManager.awaitExit).toHaveBeenCalledWith('orphan-1');
    expect(sessionManager.removeByTaskId).toHaveBeenCalledWith('task-1');
  });

  it('restores the authorized destination after a spawn rollback to To Do', () => {
    const task = tasks.create({ title: 'Recover me', description: 'A bounded route.', swimlane_id: todoId });
    const dispatchId = '88888888-8888-4888-8888-888888888888';
    tasks.routeFromTodo({
      taskId: task.id, targetSwimlaneId: executingId, targetPosition: 0,
      expectedRevision: task.revision, expectedFingerprint: taskFingerprint(task, 'project-1'),
      policyVersion: 'p1', profileId: 'profile-balanced', workflow: 'direct', dispatchId, projectId: 'project-1',
    });
    tasks.move({ taskId: task.id, targetSwimlaneId: todoId, targetPosition: 0 });
    const rolledBack = tasks.getById(task.id)!;
    expect(rolledBack.pending_dispatch_id).toBe(dispatchId);
    const restored = restorePendingRouteDestination(tasks, new SwimlaneRepository(db), rolledBack, {
      taskId: task.id, targetSwimlaneId: executingId, targetPosition: 0,
    });
    expect(restored.swimlane_id).toBe(executingId);
    expect(restored.pending_dispatch_id).toBe(dispatchId);
  });
});
