/**
 * A column's message MUST reach the agent (0.42.0-luuk.2).
 *
 * The regression this pins (0.42.0-luuk.1, luukFull task #14): a card entered
 * Executing, the agent spawned FRESH with the task prompt, and the column's
 * `send_message` row was then TYPED at it. The transcript verifier could not
 * confirm the burst, and the spawn path's burst had no escalation handler, so
 * the failure ended as a toast while the run row said "succeeded - Sent".
 *
 * Now:
 *  - a spawn that this move starts carries the message in its own argv prompt
 *    (`columnMessage`), whatever the resume/fresh/template shape, and the row
 *    is NOT typed a second time;
 *  - a message typed at a session that already exists gets rung 3 (restart
 *    with the message as the prompt when it cannot be confirmed), and its
 *    final outcome is written back onto the automation run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';
import type { InjectionReport } from '../../src/main/transition-engine/terminal-submit-scheduler';

const hoisted = vi.hoisted(() => ({
  columnMessages: new Map<string, string>(),
  restartSessionForSettingsChange: vi.fn(async () => ({ ok: true as const })),
  finishRun: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => ({ sessionType: 'claude_agent' })) },
}));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  emitSpawnWaiting: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
  getInFlightSpawnProgress: vi.fn(() => ({})),
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  restartSessionForSettingsChange: hoisted.restartSessionForSettingsChange,
}));

function messageRows(swimlaneId: string) {
  const message = hoisted.columnMessages.get(swimlaneId);
  if (!message) return [];
  return [{
    id: `automation-${swimlaneId}`,
    swimlane_id: swimlaneId,
    name: 'Message',
    type: 'send_message' as const,
    trigger: 'enter' as const,
    position: 0,
    enabled: true,
    config: { message, mode: 'deferred' as const },
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
  }];
}

vi.mock('../../src/main/db/repositories/automation-repository', () => ({
  AutomationRepository: class {
    listForColumn(swimlaneId: string) { return messageRows(swimlaneId); }
  },
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    automations: { listForColumn: (swimlaneId: string) => messageRows(swimlaneId) },
    automationRuns: { finish: hoisted.finishRun },
    swimlanes: { getById: vi.fn(() => null) },
  })),
}));

import { spawnAgent } from '../../src/main/ipc/helpers/agent-spawn';
import { resolveSpawnIntent } from '../../src/main/transition-engine/spawn-intent';

const TASK_ID = 'task-col-msg-1';
const LANE_ID = 'lane-executing';
const PROJECT_ID = 'proj-1';
const LIVE_SESSION_ID = 'pty-live-1';
const RULES = 'Implementa solamente el alcance.\n\nDelegacion: trabaja solo.';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 14,
    title: 'Pedro/Hermes',
    description: 'Revisa la instalacion',
    swimlane_id: LANE_ID,
    position: 0,
    agent: 'claude',
    agent_override: null,
    model_override: null,
    effort_override: null,
    session_id: null,
    worktree_path: '/mock/project/.kangentic/worktrees/14',
    branch_name: 'task-14',
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeLane(): Swimlane {
  hoisted.columnMessages.set(LANE_ID, RULES);
  return {
    id: LANE_ID,
    name: 'Executing',
    role: null,
    position: 3,
    color: '#888',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2025-01-01T00:00:00.000Z',
  };
}

/**
 * `liveFromStart` models a session that already exists when the enter group
 * runs (the runner then never calls `startAgent`). Otherwise the engine mock
 * behaves like the runner does for a `send_message` row: start the agent with
 * the row's text as the candidate prompt, then deliver the row.
 */
function makeDeps(args: { liveFromStart: boolean }) {
  let sessionStarted = args.liveFromStart;
  const tasks = {
    getById: vi.fn(() => makeTask({ session_id: sessionStarted ? LIVE_SESSION_ID : null })),
    recordAutoCommandOutcome: vi.fn(),
  };
  const sessionRepo = {
    getLatestForTask: vi.fn(() => null),
    getLatestForTaskByTypeAndIsolation: vi.fn(() => undefined),
  };
  const deliveries: unknown[] = [];
  const engine = {
    executeTransition: vi.fn(async (
      _task: Task,
      lane: Swimlane,
      _trigger: string,
      runOptions: {
        startAgent: (pendingPrompt?: string) => Promise<void>;
        deliverToAgent: (message: string, mode: 'immediate' | 'deferred', signal: AbortSignal, runId?: string) => Promise<unknown>;
      },
    ) => {
      const message = hoisted.columnMessages.get(lane.id);
      if (!message) return { outcomes: [], failures: [], startedAgent: false };
      if (!sessionStarted) await runOptions.startAgent(message);
      deliveries.push(await runOptions.deliverToAgent(message, 'deferred', new AbortController().signal, 'run-1'));
      return { outcomes: [], failures: [], startedAgent: !args.liveFromStart };
    }),
    resumeSuspendedSession: vi.fn(async () => { sessionStarted = true; }),
  };
  const scheduleKeystrokes = vi.fn();
  const context = {
    terminalSubmitScheduler: { scheduleKeystrokes },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    projectRepo: { getById: vi.fn(() => null) },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { permissionMode: 'acceptEdits' },
        git: { defaultBaseBranch: 'main' },
      })),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => undefined) },
  };
  return { tasks, sessionRepo, engine, scheduleKeystrokes, context, deliveries };
}

async function runSpawn(deps: ReturnType<typeof makeDeps>, liveTask: boolean): Promise<void> {
  await spawnAgent({
    context: deps.context as never,
    engine: deps.engine as never,
    tasks: deps.tasks as never,
    sessionRepo: deps.sessionRepo as never,
    task: makeTask({ session_id: liveTask ? LIVE_SESSION_ID : null }),
    fromSwimlaneId: 'lane-planning',
    toLane: makeLane(),
    skipPromptTemplate: false,
    projectId: PROJECT_ID,
    projectPath: '/mock/project',
  });
}

function spawnOverridesArg(deps: ReturnType<typeof makeDeps>): { columnMessage?: string } | undefined {
  return deps.engine.resumeSuspendedSession.mock.calls[0]?.[7] as { columnMessage?: string } | undefined;
}

function report(overrides: Partial<InjectionReport>): InjectionReport {
  return {
    taskId: TASK_ID,
    sessionId: LIVE_SESSION_ID,
    commands: [RULES],
    outcome: 'failed',
    unconfirmedCommands: [RULES],
    discardedDraft: null,
    interruptedTurn: false,
    escalated: false,
    ...overrides,
  };
}

describe('column message delivery: new spawn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.columnMessages.clear();
  });

  it('a fresh spawn with a task prompt carries the column message in its argv, and never types it', async () => {
    const deps = makeDeps({ liveFromStart: false });

    await runSpawn(deps, false);

    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(spawnOverridesArg(deps)?.columnMessage).toBe(RULES);
    // No double delivery: the row reports it rode the spawn, and no burst.
    expect(deps.deliveries).toEqual(['spawn-prompt']);
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('the intent resolver appends the message after {{task_xml}}/attachments on a fresh spawn, keeping its newlines', () => {
    const intent = resolveSpawnIntent({
      taskId: TASK_ID,
      sessionType: 'claude_agent',
      sessionRepo: { getLatestForTaskByTypeAndIsolation: () => undefined } as never,
      promptTemplate: '{{task_xml}}{{attachments}}',
      templateVars: { task_xml: '<task>\n  <title>T</title>\n</task>', attachments: '' },
      resumePrompt: undefined,
      columnMessage: RULES,
    });

    expect(intent.mode).toBe('fresh');
    expect(intent.prompt).toBe(`<task>\n  <title>T</title>\n</task>\n\n${RULES}`);
  });

  it('on a resume the column message is the prompt and wins over the plan-exit continuation', () => {
    const intent = resolveSpawnIntent({
      taskId: TASK_ID,
      sessionType: 'claude_agent',
      sessionRepo: {
        getLatestForTaskByTypeAndIsolation: () => ({
          id: 'rec-1', agent_session_id: 'agent-1', session_type: 'claude_agent', status: 'suspended', cwd: '/w',
        }),
      } as never,
      promptTemplate: undefined,
      templateVars: {},
      resumePrompt: 'Your plan was approved, proceed.',
      columnMessage: RULES,
    });

    expect(intent.mode).toBe('resume');
    expect(intent.prompt).toBe(RULES);
  });

  it('without a column message the fresh prompt is the task template alone (unchanged)', () => {
    const intent = resolveSpawnIntent({
      taskId: TASK_ID,
      sessionType: 'claude_agent',
      sessionRepo: { getLatestForTaskByTypeAndIsolation: () => undefined } as never,
      promptTemplate: '{{task_xml}}',
      templateVars: { task_xml: '<task/>' },
      resumePrompt: undefined,
    });

    expect(intent.prompt).toBe('<task/>');
  });
});

describe('column message delivery: existing session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.columnMessages.clear();
  });

  it('types the message with an escalation handler that restarts the session with it as the prompt', async () => {
    const deps = makeDeps({ liveFromStart: true });

    await runSpawn(deps, true);

    expect(deps.engine.resumeSuspendedSession).not.toHaveBeenCalled();
    expect(deps.deliveries).toEqual(['keystrokes']);
    expect(deps.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    const [taskId, sessionId, commands, options] = deps.scheduleKeystrokes.mock.calls[0] as [
      string, string, Array<{ text: string; verify: string }>, { escalate?: (commands: string[]) => Promise<boolean>; mode: string },
    ];
    expect(taskId).toBe(TASK_ID);
    expect(sessionId).toBe(LIVE_SESSION_ID);
    expect(commands).toEqual([{ text: RULES, verify: 'submitted' }]);
    expect(options.mode).toBe('deferred');
    expect(typeof options.escalate).toBe('function');

    // Rung 3: what the scheduler calls after the burst could not be confirmed.
    await expect(options.escalate!([RULES])).resolves.toBe(true);
    expect(hoisted.restartSessionForSettingsChange).toHaveBeenCalledWith(
      expect.anything(), PROJECT_ID, '/mock/project', TASK_ID,
      { phase: 'resending-command', resumePrompt: RULES },
    );
  });

  it('writes the burst\'s final outcome back onto the automation run', async () => {
    const deps = makeDeps({ liveFromStart: true });
    await runSpawn(deps, true);
    const options = deps.scheduleKeystrokes.mock.calls[0]?.[3] as { onOutcome: (report: InjectionReport) => void };

    options.onOutcome(report({ outcome: 'failed', reason: 'The command could not be confirmed, and the session restart did not run.' }));
    expect(hoisted.finishRun).toHaveBeenLastCalledWith(
      'run-1', 'failed', 'The command could not be confirmed, and the session restart did not run.', 1,
    );

    options.onOutcome(report({ outcome: 'failed', escalated: true, unconfirmedCommands: [] }));
    expect(hoisted.finishRun).toHaveBeenLastCalledWith(
      'run-1', 'succeeded', 'Typing it could not be confirmed, so the session was restarted with it as the prompt.', 1,
    );

    options.onOutcome(report({ outcome: 'confirmed', unconfirmedCommands: [] }));
    expect(hoisted.finishRun).toHaveBeenLastCalledWith('run-1', 'succeeded', 'Confirmed in the agent transcript.', 1);
  });
});
