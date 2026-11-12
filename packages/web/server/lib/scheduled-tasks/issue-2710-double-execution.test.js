import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression for https://github.com/openchamber/openchamber/issues/2710
 * "Scheduled daily task executes twice at the configured time"
 *
 * Root cause: each OpenChamber server process keeps its own timers. Two
 * instances that share the same on-disk project config (CLI serve on port 3000
 * + Electron on 57123, or a startup login service + desktop) each arm a timer
 * for the same occurrence and both dispatch.
 *
 * Fix: scheduled runs claim the occurrence in shared project config
 * (`lastScheduledFor` + advanced `nextRunAt`) under a cross-process write lock
 * before creating a session, so the second instance skips.
 */

import { createScheduledTasksRuntime } from './runtime.js';
import { canClaimScheduledOccurrence } from './occurrence.js';

const opencode = { sessionCreates: [] };

const jsonResponse = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

/**
 * Serves the few v2 routes a scheduled run touches so the test drives the real
 * @opencode/client over its own transport instead of replacing the module.
 * `gate` holds the prompt open the way a long-running dispatch would.
 */
const installOpenCodeFetch = (gate = null) => {
  globalThis.fetch = vi.fn(async (input) => {
    const { pathname } = new URL(input);
    if (pathname === '/api/session') {
      opencode.sessionCreates.push(Date.now());
      return jsonResponse({ data: { id: `sess-${opencode.sessionCreates.length}` } });
    }
    if (pathname === '/api/command') return jsonResponse({ data: [] });
    if (gate) await gate;
    return jsonResponse({ data: {} });
  });
};

const UTC = (y, mo, d, h, mi, s = 0) => Date.UTC(y, mo, d, h, mi, s);
const MINUTE = 60_000;
const HOUR = 3_600_000;

const makeTask = (schedule) => ({
  id: 'task-1',
  name: 'Daily Sync',
  enabled: true,
  schedule: { timezone: 'UTC', ...schedule },
  execution: { prompt: 'Summarize open issues', providerID: 'openai', modelID: 'gpt-4o' },
  state: { createdAt: UTC(2026, 0, 1, 0, 0, 0), updatedAt: UTC(2026, 0, 1, 0, 0, 0) },
});

/**
 * Shared on-disk store stand-in. Both runtimes must see the same task state so
 * occurrence claiming can serialize dispatches the way real project config does.
 */
const createSharedProjectConfigRuntime = (initialTask) => {
  let currentTask = structuredClone(initialTask);

  const applyPatch = (patch) => {
    const nextState = {
      ...(currentTask.state || {}),
      ...patch,
      updatedAt: Date.now(),
    };
    // Mirror normalizeState: explicit undefined clears optional numeric fields.
    for (const key of ['nextRunAt', 'lastRunAt', 'lastDurationMs', 'lastScheduledFor', 'lastError', 'lastSessionId']) {
      if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] === undefined) {
        delete nextState[key];
      }
    }
    currentTask = {
      ...currentTask,
      state: nextState,
    };
    return currentTask;
  };

  return {
    listScheduledTasks: vi.fn(async () => [structuredClone(currentTask)]),
    reconcileLoopTasks: vi.fn(async () => [structuredClone(currentTask)]),
    updateScheduledTaskState: vi.fn(async (_pid, _tid, patch) => {
      const task = applyPatch(patch);
      return { task: structuredClone(task), updated: true };
    }),
    updateScheduledTaskStateIf: vi.fn(async (_pid, _tid, predicate, patch) => {
      if (!predicate(currentTask)) {
        return { task: structuredClone(currentTask), updated: false };
      }
      const task = applyPatch(patch);
      return { task: structuredClone(task), updated: true };
    }),
    upsertScheduledTask: vi.fn(async (_pid, input) => {
      currentTask = structuredClone(input);
      return { task: structuredClone(currentTask) };
    }),
  };
};

const createRuntimeDeps = (projectConfigRuntime) => ({
  projectConfigRuntime,
  listProjects: vi.fn(async () => [{ id: 'p1', path: '/repo' }]),
  buildOpenCodeUrl: () => 'http://127.0.0.1:9999/',
  getOpenCodeAuthHeaders: () => ({}),
  waitForOpenCodeReady: async () => {},
  emitTaskRunEvent: vi.fn(),
  setSessionAutoAccept: async () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

const startInstances = async (count, task) => {
  const projectConfigRuntime = createSharedProjectConfigRuntime(task);
  const runtimes = [];
  for (let i = 0; i < count; i += 1) {
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    await runtime.start();
    runtimes.push(runtime);
  }
  return { runtimes, projectConfigRuntime };
};

describe('issue 2710: daily scheduled task double execution at the configured time', () => {
  it.each(['prompt', 'command'])('marks a manual task failed when its v2 %s returns an HTML app shell', async (operation) => {
    const task = makeTask({ kind: 'daily', times: ['23:59'] });
    if (operation === 'command') task.execution.prompt = '/review src';
    installOpenCodeFetch();
    const upstream = globalThis.fetch;
    const fetchMock = vi.fn(async (input, init) => {
      const { pathname } = new URL(input);
      if (operation === 'command' && pathname === '/api/command') return jsonResponse({ data: [{ name: 'review' }] });
      if (init?.method === 'POST' && pathname.endsWith(`/${operation}`)) {
        return new Response('<!doctype html><title>OpenChamber</title>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return upstream(input, init);
    });
    globalThis.fetch = fetchMock;
    const projectConfigRuntime = createSharedProjectConfigRuntime(task);
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await runtime.start();
      const result = await runtime.runNow('p1', 'task-1');
      expect(fetchMock.mock.calls.some(([url, init]) => init?.method === 'POST' && new URL(url).pathname.endsWith(`/${operation}`))).toBe(true);
      expect(result).toMatchObject({ ok: false, status: 'error' });
      const tasks = await projectConfigRuntime.listScheduledTasks('p1');
      expect(tasks[0].state.lastStatus).toBe('error');
    } finally {
      runtime.stop();
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
    opencode.sessionCreates.length = 0;
    installOpenCodeFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { kind: 'daily', times: ['09:00'] },
    { kind: 'weekly', times: ['09:00'], weekdays: [4] },
    { kind: 'cron', cron: '0 9 * * *' },
    { kind: 'once', date: '2026-01-01', time: '09:00' },
  ])('recovers one persisted $kind occurrence, then only future runs', async (schedule) => {
    vi.setSystemTime(UTC(2026, 0, 1, 12, 0));
    const missed = UTC(2026, 0, 1, 9, 0);
    const task = { ...makeTask(schedule), catchUpOnStartup: true };
    task.state.nextRunAt = missed;
    const { runtimes, projectConfigRuntime } = await startInstances(1, task);
    try {
      // Listing or saving while the startup timer waits keeps that one recovery.
      await runtimes[0].syncProject('p1');
      await runtimes[0].syncAllProjects();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(opencode.sessionCreates).toHaveLength(1);
      const [stored] = await projectConfigRuntime.listScheduledTasks('p1');
      expect(stored.state.lastScheduledFor).toBe(missed);
      if (schedule.kind === 'once') {
        expect(stored.enabled).toBe(false);
        expect(stored.state.nextRunAt).toBeUndefined();
      } else {
        expect(stored.state.nextRunAt).toBeGreaterThan(Date.now());
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(opencode.sessionCreates).toHaveLength(1);
      if (schedule.kind !== 'once') {
        await vi.advanceTimersByTimeAsync(stored.state.nextRunAt - Date.now() + 3_000);
        expect(opencode.sessionCreates).toHaveLength(2);
      } else {
        runtimes[0].stop();
        await runtimes[0].start();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(opencode.sessionCreates).toHaveLength(1);
      }
    } finally { runtimes.forEach((runtime) => runtime.stop()); }
  });

  it.each(['missing-option', 'option-false', 'invalid-option', 'disabled', 'missing-cursor', 'invalid-cursor', 'current-cursor', 'future-cursor', 'already-claimed'])('does not recover %s', async (condition) => {
    vi.setSystemTime(UTC(2026, 0, 1, 12, 0));
    const missed = UTC(2026, 0, 1, 9, 0);
    const task = { ...makeTask({ kind: 'daily', times: ['09:00'] }), catchUpOnStartup: true };
    task.state.nextRunAt = missed;
    if (condition === 'missing-option') delete task.catchUpOnStartup;
    if (condition === 'option-false') task.catchUpOnStartup = false;
    if (condition === 'invalid-option') task.catchUpOnStartup = 'true';
    if (condition === 'disabled') task.enabled = false;
    if (condition === 'missing-cursor') delete task.state.nextRunAt;
    if (condition === 'invalid-cursor') task.state.nextRunAt = NaN;
    if (condition === 'current-cursor') task.state.nextRunAt = Date.now();
    if (condition === 'future-cursor') task.state.nextRunAt = Date.now() + HOUR;
    if (condition === 'already-claimed') task.state.lastScheduledFor = missed;
    const { runtimes } = await startInstances(1, task);
    try {
      await vi.advanceTimersByTimeAsync(3_000);
      expect(opencode.sessionCreates).toHaveLength(0);
    } finally { runtimes.forEach((runtime) => runtime.stop()); }
  });

  it('ordinary sync never discovers a missed occurrence', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 12, 0));
    const task = { ...makeTask({ kind: 'daily', times: ['09:00'] }), catchUpOnStartup: true };
    const { runtimes, projectConfigRuntime } = await startInstances(1, task);
    try {
      await projectConfigRuntime.updateScheduledTaskState('p1', task.id, { nextRunAt: Date.now() - HOUR });
      await runtimes[0].syncProject('p1');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(opencode.sessionCreates).toHaveLength(0);
    } finally { runtimes.forEach((runtime) => runtime.stop()); }
  });

  it('two startup recoveries sharing a cursor dispatch once', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 12, 0));
    const task = { ...makeTask({ kind: 'daily', times: ['09:00'] }), catchUpOnStartup: true };
    task.state.nextRunAt = Date.now() - HOUR;
    const { runtimes, projectConfigRuntime } = await startInstances(2, task);
    try {
      await vi.advanceTimersByTimeAsync(3_000);
      expect(opencode.sessionCreates).toHaveLength(1);
      const [stored] = await projectConfigRuntime.listScheduledTasks('p1');
      expect(stored.state.lastScheduledFor).toBe(task.state.nextRunAt);
    } finally { runtimes.forEach((runtime) => runtime.stop()); }
  });

  it.each(['disabled', 'retimed', 'withdrawn', 'newer-claim'])('rejects startup recovery after %s at the locked claim', async (change) => {
    vi.setSystemTime(UTC(2026, 0, 1, 12, 0));
    const task = { ...makeTask({ kind: 'daily', times: ['09:00'] }), catchUpOnStartup: true };
    task.state.nextRunAt = Date.now() - HOUR;
    const { runtimes, projectConfigRuntime } = await startInstances(1, task);
    try {
      const changed = structuredClone(task);
      if (change === 'disabled') changed.enabled = false;
      if (change === 'retimed') changed.schedule.times = ['14:00'];
      if (change === 'withdrawn') changed.catchUpOnStartup = false;
      if (change === 'newer-claim') changed.state.lastScheduledFor = Date.now();
      await projectConfigRuntime.upsertScheduledTask('p1', changed);
      // Deliberately no sync: another process changed the shared file.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(opencode.sessionCreates).toHaveLength(0);
      expect((await projectConfigRuntime.listScheduledTasks('p1'))[0].state.lastScheduledFor)
        .toBe(changed.state.lastScheduledFor);
    } finally { runtimes.forEach((runtime) => runtime.stop()); }
  });

  it.each(['disabled', 'retimed', 'withdrawn'])('cancels a pending startup recovery on %s sync', async (change) => {
    vi.setSystemTime(UTC(2026, 0, 1, 12, 0));
    const task = { ...makeTask({ kind: 'daily', times: ['09:00'] }), catchUpOnStartup: true };
    task.state.nextRunAt = Date.now() - HOUR;
    const { runtimes, projectConfigRuntime } = await startInstances(1, task);
    try {
      if (change === 'disabled') task.enabled = false;
      if (change === 'retimed') task.schedule.times = ['14:00'];
      if (change === 'withdrawn') task.catchUpOnStartup = false;
      await projectConfigRuntime.upsertScheduledTask('p1', task);
      await runtimes[0].syncProject('p1');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(opencode.sessionCreates).toHaveLength(0);
    } finally { runtimes.forEach((runtime) => runtime.stop()); }
  });

  it('waits for startup readiness before claiming and keeps the manual queue guard', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 12, 0));
    const task = { ...makeTask({ kind: 'daily', times: ['09:00'] }), catchUpOnStartup: true };
    task.state.nextRunAt = Date.now() - HOUR;
    const projectConfigRuntime = createSharedProjectConfigRuntime(task);
    const ready = Promise.withResolvers();
    const runtime = createScheduledTasksRuntime({ ...createRuntimeDeps(projectConfigRuntime), waitForOpenCodeStartup: () => ready.promise });
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(3_000);
      await runtime.syncProject('p1');
      expect(projectConfigRuntime.updateScheduledTaskStateIf).not.toHaveBeenCalled();
      expect(await runtime.runNow('p1', task.id)).toMatchObject({ running: true });
      ready.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(opencode.sessionCreates).toHaveLength(1);
    } finally { ready.resolve(); runtime.stop(); }
  });

  it('cancels a recovery disabled while startup readiness is pending', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 12, 0));
    const task = { ...makeTask({ kind: 'daily', times: ['09:00'] }), catchUpOnStartup: true };
    task.state.nextRunAt = Date.now() - HOUR;
    const projectConfigRuntime = createSharedProjectConfigRuntime(task);
    const ready = Promise.withResolvers();
    const runtime = createScheduledTasksRuntime({ ...createRuntimeDeps(projectConfigRuntime), waitForOpenCodeStartup: () => ready.promise });
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(3_000);
      await projectConfigRuntime.upsertScheduledTask('p1', { ...task, enabled: false });
      await runtime.syncProject('p1');
      ready.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(projectConfigRuntime.updateScheduledTaskStateIf).not.toHaveBeenCalled();
      expect(opencode.sessionCreates).toHaveLength(0);
      expect(runtime.getStatus().runningScheduledTasksCount).toBe(0);
    } finally { ready.resolve(); runtime.stop(); }
  });

  it.each(['opt-out', 'retime'])('keeps normal occurrences runnable after %s cancels a readiness wait', async (change) => {
    vi.setSystemTime(UTC(2026, 0, 1, 12, 0, 50));
    const schedule = change === 'retime'
      ? { kind: 'daily', times: ['09:00'] }
      : { kind: 'cron', cron: '* * * * *' };
    const task = { ...makeTask(schedule), catchUpOnStartup: true };
    task.state.nextRunAt = UTC(2026, 0, 1, 9, 0);
    const projectConfigRuntime = createSharedProjectConfigRuntime(task);
    const ready = Promise.withResolvers();
    const runtime = createScheduledTasksRuntime({ ...createRuntimeDeps(projectConfigRuntime), waitForOpenCodeStartup: () => ready.promise });
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(runtime.getStatus().runningScheduledTasksCount).toBe(1);
      if (change === 'opt-out') task.catchUpOnStartup = false;
      else task.schedule.times = ['12:01'];
      await projectConfigRuntime.upsertScheduledTask('p1', task);
      await runtime.syncProject('p1');
      expect(runtime.getStatus().runningScheduledTasksCount).toBe(0);
      // The replacement becomes due while the cancelled wait is unresolved.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(opencode.sessionCreates).toHaveLength(1);
      ready.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(opencode.sessionCreates).toHaveLength(1);
      const [stored] = await projectConfigRuntime.listScheduledTasks('p1');
      expect(stored.state.lastScheduledFor).toBe(UTC(2026, 0, 1, 12, 1));
      await vi.advanceTimersByTimeAsync(stored.state.nextRunAt - Date.now() + 3_000);
      expect(opencode.sessionCreates).toHaveLength(2);
    } finally { ready.resolve(); runtime.stop(); }
  });

  it('a cancelled startup wait cannot release a replacement manual run slot', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 12, 0));
    const task = { ...makeTask({ kind: 'daily', times: ['09:00'] }), catchUpOnStartup: true };
    task.state.nextRunAt = Date.now() - HOUR;
    const projectConfigRuntime = createSharedProjectConfigRuntime(task);
    const ready = Promise.withResolvers();
    const dispatch = Promise.withResolvers();
    const runtime = createScheduledTasksRuntime({ ...createRuntimeDeps(projectConfigRuntime), waitForOpenCodeStartup: () => ready.promise });
    let manual;
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(3_000);
      await projectConfigRuntime.upsertScheduledTask('p1', { ...task, catchUpOnStartup: false });
      await runtime.syncProject('p1');
      installOpenCodeFetch(dispatch.promise);
      manual = runtime.runNow('p1', task.id);
      await vi.advanceTimersByTimeAsync(1);
      expect(opencode.sessionCreates).toHaveLength(1);
      ready.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.getStatus().runningScheduledTasksCount).toBe(1);
      expect(await runtime.runNow('p1', task.id)).toMatchObject({ running: true });
    } finally {
      ready.resolve();
      dispatch.resolve();
      await manual;
      runtime.stop();
    }
  });

  it.each(['daily', 'once'])('records a %s startup readiness failure and releases the slot without dispatch or retry', async (kind) => {
    vi.setSystemTime(UTC(2026, 0, 1, 12, 0));
    const schedule = kind === 'once'
      ? { kind, date: '2026-01-01', time: '09:00' }
      : { kind, times: ['09:00'] };
    const task = { ...makeTask(schedule), catchUpOnStartup: true };
    task.state.nextRunAt = Date.now() - HOUR;
    const projectConfigRuntime = createSharedProjectConfigRuntime(task);
    const runtime = createScheduledTasksRuntime({
      ...createRuntimeDeps(projectConfigRuntime),
      waitForOpenCodeStartup: async () => { throw new Error('Synthetic readiness failure'); },
    });
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(projectConfigRuntime.updateScheduledTaskStateIf).toHaveBeenCalledOnce();
      expect(opencode.sessionCreates).toHaveLength(0);
      expect(runtime.getStatus().runningScheduledTasksCount).toBe(0);
      const [stored] = await projectConfigRuntime.listScheduledTasks('p1');
      expect(stored.state).toMatchObject({
        lastScheduledFor: task.state.nextRunAt,
        lastStatus: 'error',
        lastError: 'OpenCode startup readiness failed: Synthetic readiness failure',
      });
      expect(stored.enabled).toBe(kind !== 'once');
      if (kind === 'once') expect(stored.state.nextRunAt).toBeUndefined();
      else expect(stored.state.nextRunAt).toBeGreaterThan(Date.now());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(projectConfigRuntime.updateScheduledTaskStateIf).toHaveBeenCalledOnce();
      expect(await runtime.runNow('p1', task.id)).toMatchObject({ ok: true });
    } finally { runtime.stop(); }
  });

  it.each([
    [-5_001, true], [-5_000, false], [0, false], [5_000, false], [5_001, true],
  ])('keeps the ordinary absolute duplicate window at offset %s', (offset, expected) => {
    const task = makeTask({ kind: 'daily', times: ['09:00'] });
    const candidate = {
      ...task, catchUpOnStartup: false,
      schedule: { kind: 'daily', times: ['10:00'], timezone: 'UTC' },
      state: { lastScheduledFor: 100_000 + offset },
    };
    expect(canClaimScheduledOccurrence(candidate, task, 100_000)).toBe(expected);
    expect(canClaimScheduledOccurrence(candidate, task, 100_000, true)).toBe(false);
  });

  it('rejects a newer claim only for catch-up, even outside the duplicate window', () => {
    const task = { ...makeTask({ kind: 'daily', times: ['09:00'] }), catchUpOnStartup: true };
    const candidate = { ...task, state: { lastScheduledFor: 110_000 } };
    expect(canClaimScheduledOccurrence(candidate, task, 100_000)).toBe(true);
    expect(canClaimScheduledOccurrence(candidate, task, 100_000, true)).toBe(false);
  });

  it('does not overwrite a newer winner when startup readiness fails', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 12, 0));
    const task = { ...makeTask({ kind: 'daily', times: ['09:00'] }), catchUpOnStartup: true };
    task.state.nextRunAt = Date.now() - HOUR;
    const projectConfigRuntime = createSharedProjectConfigRuntime(task);
    const ready = Promise.withResolvers();
    const runtime = createScheduledTasksRuntime({ ...createRuntimeDeps(projectConfigRuntime), waitForOpenCodeStartup: () => ready.promise });
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(3_000);
      const winner = { lastScheduledFor: Date.now(), lastStatus: 'sent', lastSessionId: 'winner-session' };
      await projectConfigRuntime.updateScheduledTaskState('p1', task.id, winner);
      ready.reject(new Error('Synthetic readiness failure'));
      await vi.advanceTimersByTimeAsync(1);
      expect((await projectConfigRuntime.listScheduledTasks('p1'))[0].state).toMatchObject(winner);
      expect(opencode.sessionCreates).toHaveLength(0);
      expect(runtime.getStatus().runningScheduledTasksCount).toBe(0);
    } finally { ready.resolve(); runtime.stop(); }
  });

  it('preserves a startup recovery waiting behind another task in the concurrency queue', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 12, 0));
    const task = { ...makeTask({ kind: 'daily', times: ['09:00'] }), catchUpOnStartup: true };
    task.state.nextRunAt = Date.now() - HOUR;
    const recovering = createSharedProjectConfigRuntime(task);
    const blocker = createSharedProjectConfigRuntime({ ...makeTask({ kind: 'daily', times: ['09:00'] }), id: 'blocker' });
    const select = (id) => id === 'p1' ? recovering : blocker;
    const projectConfigRuntime = Object.fromEntries([
      'listScheduledTasks', 'reconcileLoopTasks', 'updateScheduledTaskState', 'updateScheduledTaskStateIf', 'upsertScheduledTask',
    ].map((name) => [name, (id, ...args) => select(id)[name](id, ...args)]));
    const gate = Promise.withResolvers();
    installOpenCodeFetch(gate.promise);
    const runtime = createScheduledTasksRuntime({
      ...createRuntimeDeps(projectConfigRuntime), maxGlobalConcurrency: 1,
      listProjects: async () => [{ id: 'p1', path: '/repo' }, { id: 'p2', path: '/other' }],
    });
    let manual;
    try {
      await runtime.start();
      manual = runtime.runNow('p2', 'blocker');
      await vi.advanceTimersByTimeAsync(3_000);
      await runtime.syncProject('p1');
      expect(recovering.updateScheduledTaskStateIf).not.toHaveBeenCalled();
      expect(await runtime.runNow('p1', task.id)).toMatchObject({ queued: true });
      gate.resolve();
      await manual;
      await vi.advanceTimersByTimeAsync(1);
      expect(opencode.sessionCreates).toHaveLength(2);
      expect((await recovering.listScheduledTasks('p1'))[0].state.lastScheduledFor).toBe(task.state.nextRunAt);
    } finally { gate.resolve(); await manual; runtime.stop(); }
  });

  it('consumes a recovered once task even when dispatch fails', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 12, 0));
    const task = { ...makeTask({ kind: 'once', date: '2026-01-01', time: '09:00' }), catchUpOnStartup: true };
    task.state.nextRunAt = Date.now() - HOUR;
    globalThis.fetch = vi.fn(async () => { throw new Error('Synthetic dispatch failure'); });
    const { runtimes, projectConfigRuntime } = await startInstances(1, task);
    try {
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await projectConfigRuntime.listScheduledTasks('p1'))[0]).toMatchObject({
        enabled: false, state: { lastStatus: 'error', lastScheduledFor: task.state.nextRunAt },
      });
      expect((await projectConfigRuntime.listScheduledTasks('p1'))[0].state.nextRunAt).toBeUndefined();
    } finally { runtimes.forEach((runtime) => runtime.stop()); }
  });

  it('ONE instance fires a daily 15:00 task exactly once at 15:00', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const { runtimes } = await startInstances(1, makeTask({ kind: 'daily', times: ['15:00'] }));
    await vi.advanceTimersByTimeAsync(HOUR + 3_000);

    expect(opencode.sessionCreates.length).toBe(1);
    const firedAt = new Date(opencode.sessionCreates[0]);
    expect(firedAt.getUTCHours()).toBe(15);

    runtimes.forEach((runtime) => runtime.stop());
  });

  it('ONE instance firing daily 15:00 across 4 days never double-fires', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const { runtimes } = await startInstances(1, makeTask({ kind: 'daily', times: ['15:00'] }));
    await vi.advanceTimersByTimeAsync((4 * 24 * HOUR) + 3_000);

    expect(opencode.sessionCreates.length).toBe(4);
    const byHourBucket = new Map();
    for (const timestamp of opencode.sessionCreates) {
      const date = new Date(timestamp);
      expect(date.getUTCHours()).toBe(15);
      expect(date.getUTCMinutes()).toBe(0);
      const bucket = Math.floor(timestamp / HOUR);
      byHourBucket.set(bucket, (byHourBucket.get(bucket) || 0) + 1);
    }
    for (const count of byHourBucket.values()) {
      expect(count).toBe(1);
    }

    runtimes.forEach((runtime) => runtime.stop());
  });

  it('TWO instances fire a daily 15:00 task exactly ONCE (occurrence claim)', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const { runtimes, projectConfigRuntime } = await startInstances(
      2,
      makeTask({ kind: 'daily', times: ['15:00'] }),
    );
    await vi.advanceTimersByTimeAsync(HOUR + 3_000);

    expect(opencode.sessionCreates.length).toBe(1);
    const firedAt = new Date(opencode.sessionCreates[0]);
    expect(firedAt.getUTCHours()).toBe(15);
    expect(firedAt.getUTCMinutes()).toBe(0);
    expect(projectConfigRuntime.updateScheduledTaskStateIf).toHaveBeenCalled();

    runtimes.forEach((runtime) => runtime.stop());
  });

  it('TWO instances fire a weekly task exactly once', async () => {
    // 2026-01-04 is a Sunday. Weekly Mon/Wed/Fri 09:00.
    vi.setSystemTime(UTC(2026, 0, 4, 8, 0, 0));
    const { runtimes } = await startInstances(2, makeTask({
      kind: 'weekly',
      times: ['09:00'],
      weekdays: [1, 3, 5],
    }));
    await vi.advanceTimersByTimeAsync((25 * HOUR) + 3_000);

    expect(opencode.sessionCreates.length).toBe(1);

    runtimes.forEach((runtime) => runtime.stop());
  });

  it('TWO instances fire a cron task exactly once', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 3, 0));
    const { runtimes } = await startInstances(2, makeTask({ kind: 'cron', cron: '*/5 * * * *' }));
    await vi.advanceTimersByTimeAsync(3 * MINUTE);

    expect(opencode.sessionCreates.length).toBe(1);

    runtimes.forEach((runtime) => runtime.stop());
  });

  it('TWO instances fire a once task exactly once', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 8, 0, 0));
    const { runtimes } = await startInstances(2, makeTask({
      kind: 'once',
      date: '2026-01-01',
      time: '09:00',
    }));
    await vi.advanceTimersByTimeAsync(HOUR + 3_000);

    expect(opencode.sessionCreates.length).toBe(1);

    runtimes.forEach((runtime) => runtime.stop());
  });

  it('claim failure releases the running slot and does not reject unhandled', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const projectConfigRuntime = createSharedProjectConfigRuntime(
      makeTask({ kind: 'daily', times: ['15:00'] }),
    );
    projectConfigRuntime.updateScheduledTaskStateIf = vi.fn(async () => {
      throw new Error('timeout acquiring project config lock for p1');
    });
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    await runtime.start();

    await vi.advanceTimersByTimeAsync(HOUR + 3_000);

    expect(opencode.sessionCreates.length).toBe(0);
    expect(runtime.getStatus().runningScheduledTasksCount).toBe(0);
    expect(runtime.getStatus().hasRunningScheduledTasks).toBe(false);

    // Manual runNow must not be stuck behind a permanently "running" claim failure.
    const manual = await runtime.runNow('p1', 'task-1');
    expect(manual.ok).toBe(true);
    expect(opencode.sessionCreates.length).toBe(1);

    runtime.stop();
  });

  it('completion state write failure releases the running slot', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const projectConfigRuntime = createSharedProjectConfigRuntime(
      makeTask({ kind: 'daily', times: ['15:00'] }),
    );
    const originalUpdate = projectConfigRuntime.updateScheduledTaskState;
    let completionWrites = 0;
    projectConfigRuntime.updateScheduledTaskState = vi.fn(async (pid, tid, patch) => {
      // syncTaskSchedule + claim path may write; fail the post-run completion write.
      if (patch?.lastStatus === 'sent' || patch?.lastStatus === 'error') {
        completionWrites += 1;
        throw new Error('timeout acquiring project config lock for p1');
      }
      return originalUpdate(pid, tid, patch);
    });

    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    await runtime.start();
    await vi.advanceTimersByTimeAsync(HOUR + 3_000);

    // Initial completion write + best-effort retry.
    expect(completionWrites).toBeGreaterThanOrEqual(2);
    expect(opencode.sessionCreates.length).toBe(1);
    expect(runtime.getStatus().runningScheduledTasksCount).toBe(0);

    const manual = await runtime.runNow('p1', 'task-1');
    expect(manual.ok).toBe(true);
    expect(manual.sessionID).toBeTruthy();
    expect(runtime.getStatus().runningScheduledTasksCount).toBe(0);

    runtime.stop();
  });

  it('manual run completion write failure returns session and clears running status', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const projectConfigRuntime = createSharedProjectConfigRuntime(
      makeTask({ kind: 'daily', times: ['15:00'] }),
    );
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    await runtime.start();

    const originalUpdate = projectConfigRuntime.updateScheduledTaskState;
    projectConfigRuntime.updateScheduledTaskState = vi.fn(async (pid, tid, patch) => {
      if (patch?.lastStatus === 'sent' || patch?.lastStatus === 'error') {
        throw new Error('timeout acquiring project config lock for p1');
      }
      return originalUpdate(pid, tid, patch);
    });

    const manual = await runtime.runNow('p1', 'task-1');
    expect(manual.ok).toBe(true);
    expect(manual.sessionID).toBeTruthy();
    expect(manual.reason).toBe('completion-state-failed');
    expect(manual.persistError).toMatch(/timeout acquiring project config lock/);
    expect(manual.task?.state?.lastStatus).toBe('sent');
    expect(runtime.getStatus().runningScheduledTasksCount).toBe(0);

    runtime.stop();
  });

  it('manual start state write failure releases the running slot', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const projectConfigRuntime = createSharedProjectConfigRuntime(
      makeTask({ kind: 'daily', times: ['15:00'] }),
    );
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    await runtime.start();

    projectConfigRuntime.updateScheduledTaskState = vi.fn(async () => {
      throw new Error('timeout acquiring project config lock for p1');
    });

    const manual = await runtime.runNow('p1', 'task-1');
    expect(manual.ok).toBe(false);
    expect(manual.reason).toBe('start-state-failed');
    expect(opencode.sessionCreates.length).toBe(0);
    expect(runtime.getStatus().runningScheduledTasksCount).toBe(0);

    runtime.stop();
  });

  it('armed instance still fires when another instance syncs inside the due-slack window', async () => {
    // Instance A arms for 15:00 outside the slack window. Instance B then starts
    // inside TASK_DUE_SLACK_MS and syncTaskSchedule advances disk nextRunAt to
    // tomorrow. A must still claim today's occurrence.
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const task = makeTask({ kind: 'daily', times: ['15:00'] });
    const projectConfigRuntime = createSharedProjectConfigRuntime(task);

    const runtimeA = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    await runtimeA.start();

    // Enter the due-slack window (T-5s .. T) and sync a second instance.
    await vi.advanceTimersByTimeAsync(HOUR - 2_000);
    const runtimeB = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    await runtimeB.start();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(opencode.sessionCreates.length).toBe(1);

    runtimeA.stop();
    runtimeB.stop();
  });

  it('armed instance still fires on a later day when lastScheduledFor is already set', async () => {
    // After day 1 has claimed, lastScheduledFor is finite. On day 2 a second
    // instance syncing inside the due-slack window must not suppress the armed fire.
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const task = makeTask({ kind: 'daily', times: ['15:00'] });
    const projectConfigRuntime = createSharedProjectConfigRuntime(task);

    const runtimeA = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    await runtimeA.start();
    await vi.advanceTimersByTimeAsync(HOUR + 3_000);
    expect(opencode.sessionCreates.length).toBe(1);

    // Advance to day-2 afternoon, still outside slack, so A re-arms for 15:00.
    await vi.advanceTimersByTimeAsync((23 * HOUR) - 3_000);
    // Enter day-2 due-slack window and sync instance B (advances nextRunAt).
    await vi.advanceTimersByTimeAsync(HOUR - 2_000);
    const runtimeB = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    await runtimeB.start();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(opencode.sessionCreates.length).toBe(2);

    runtimeA.stop();
    runtimeB.stop();
  });

  it('once-task loser does not spin-rearm a past nextRunAt while the winner runs', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 8, 0, 0));

    let releaseFetch;
    const fetchGate = new Promise((resolve) => {
      releaseFetch = resolve;
    });
    installOpenCodeFetch(fetchGate);

    const { runtimes, projectConfigRuntime } = await startInstances(2, makeTask({
      kind: 'once',
      date: '2026-01-01',
      time: '09:00',
    }));

    await vi.advanceTimersByTimeAsync(HOUR + 3_000);

    // Winner claimed and is blocked in the prompt dispatch; exactly one session.
    expect(opencode.sessionCreates.length).toBe(1);
    const claimsAfterFire = projectConfigRuntime.updateScheduledTaskStateIf.mock.calls.length;
    expect(claimsAfterFire).toBeGreaterThanOrEqual(1);

    // Advance through many jitter windows. Loser must not keep re-entering claim.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(projectConfigRuntime.updateScheduledTaskStateIf.mock.calls.length).toBe(claimsAfterFire);
    expect(opencode.sessionCreates.length).toBe(1);

    releaseFetch();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(opencode.sessionCreates.length).toBe(1);
    expect(runtimes.every((runtime) => runtime.getStatus().runningScheduledTasksCount === 0)).toBe(true);

    runtimes.forEach((runtime) => runtime.stop());
  });

  it('claim-failed re-arms the next occurrence, not an immediate retry of the past slot', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const projectConfigRuntime = createSharedProjectConfigRuntime(
      makeTask({ kind: 'daily', times: ['15:00'] }),
    );

    let claimAttempts = 0;
    const originalClaim = projectConfigRuntime.updateScheduledTaskStateIf;
    projectConfigRuntime.updateScheduledTaskStateIf = vi.fn(async (pid, tid, predicate, patch) => {
      // Claim patches set lastScheduledFor; failure-recording patches set lastStatus error.
      if (Object.prototype.hasOwnProperty.call(patch || {}, 'lastScheduledFor')) {
        claimAttempts += 1;
        throw new Error('timeout acquiring project config lock for p1');
      }
      return originalClaim(pid, tid, predicate, patch);
    });

    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    await runtime.start();

    await vi.advanceTimersByTimeAsync(HOUR + 3_000);
    expect(claimAttempts).toBe(1);

    // Must not immediately retry the same past occurrence on a ~jitter cadence.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(claimAttempts).toBe(1);

    // Next calendar occurrence (tomorrow 15:00) may attempt once more.
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(claimAttempts).toBe(2);

    runtime.stop();
  });

  it('once claim failure records an error status instead of leaving the task silently inert', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 8, 0, 0));
    const projectConfigRuntime = createSharedProjectConfigRuntime(makeTask({
      kind: 'once',
      date: '2026-01-01',
      time: '09:00',
    }));

    const originalClaim = projectConfigRuntime.updateScheduledTaskStateIf;
    projectConfigRuntime.updateScheduledTaskStateIf = vi.fn(async (pid, tid, predicate, patch) => {
      if (Object.prototype.hasOwnProperty.call(patch || {}, 'lastScheduledFor')) {
        throw new Error('timeout acquiring project config lock for p1');
      }
      return originalClaim(pid, tid, predicate, patch);
    });

    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    await runtime.start();
    await vi.advanceTimersByTimeAsync(HOUR + 3_000);

    expect(opencode.sessionCreates.length).toBe(0);
    const tasks = await projectConfigRuntime.listScheduledTasks('p1');
    expect(tasks[0].state.lastStatus).toBe('error');
    expect(tasks[0].state.lastError).toMatch(/Scheduled claim failed/);
    expect(tasks[0].enabled).toBe(true);

    // No silent delay-0 spin after the failed once claim.
    const errorWrites = projectConfigRuntime.updateScheduledTaskStateIf.mock.calls
      .filter(([, , , patch]) => patch?.lastStatus === 'error')
      .length;
    await vi.advanceTimersByTimeAsync(30_000);
    const errorWritesAfter = projectConfigRuntime.updateScheduledTaskStateIf.mock.calls
      .filter(([, , , patch]) => patch?.lastStatus === 'error')
      .length;
    expect(errorWritesAfter).toBe(errorWrites);

    runtime.stop();
  });

  it('manual runNow runs a paused task but does not schedule future runs', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const task = { ...makeTask({ kind: 'daily', times: ['15:00'] }), enabled: false };
    const projectConfigRuntime = createSharedProjectConfigRuntime(task);

    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    await runtime.start();

    // The scheduler must not fire a disabled task on its own.
    await vi.advanceTimersByTimeAsync(HOUR + 3_000);
    expect(opencode.sessionCreates.length).toBe(0);

    const manual = await runtime.runNow('p1', 'task-1');
    expect(manual.ok).toBe(true);
    expect(manual.sessionID).toBeTruthy();
    expect(opencode.sessionCreates.length).toBe(1);
    expect(runtime.getStatus().runningScheduledTasksCount).toBe(0);

    // Completion records state but leaves the task paused with no next run.
    const tasks = await projectConfigRuntime.listScheduledTasks('p1');
    expect(tasks[0].enabled).toBe(false);
    expect(tasks[0].state.lastStatus).toBe('sent');
    expect(tasks[0].state.lastSessionId).toBe('sess-1');
    expect(tasks[0].state.nextRunAt).toBeUndefined();

    runtime.stop();
  });
});
