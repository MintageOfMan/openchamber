import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { fetchEligibleScheduledTaskTargets, upsertScheduledTask } from './scheduledTasksApi';

const requestSchema = z.object({ candidates: z.array(z.object({ sessionId: z.string(), directory: z.string() })) });
const catchUpUpdateSchema = z.strictObject({ task: z.strictObject({ id: z.string(), catchUpOnStartup: z.boolean() }) });

const previousFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = previousFetch;
});

const candidates = (count: number) => Array.from({ length: count }, (_, index) => ({ sessionId: `ses_${index}`, directory: '/repo' }));

describe('fetchEligibleScheduledTaskTargets', () => {
  test('sends candidates in batches the route accepts and joins the answers', async () => {
    const batchSizes: number[] = [];
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = requestSchema.parse(JSON.parse(String(init?.body)));
      batchSizes.push(body.candidates.length);
      return Response.json({ eligible: body.candidates.filter((_, index) => index % 2 === 0).map(({ sessionId }) => ({ sessionId })) });
    }, previousFetch);

    const eligible = await fetchEligibleScheduledTaskTargets('project-1', candidates(1200));

    expect(batchSizes).toEqual([500, 500, 200]);
    expect(eligible.size).toBe(600);
  });

  test('throws on a failed request or a malformed answer instead of returning an empty set', async () => {
    globalThis.fetch = Object.assign(async () => Response.json({ error: 'Rejected' }, { status: 500 }), previousFetch);
    await expect(fetchEligibleScheduledTaskTargets('project-1', candidates(1))).rejects.toThrow();

    globalThis.fetch = Object.assign(async () => Response.json({ nope: true }), previousFetch);
    await expect(fetchEligibleScheduledTaskTargets('project-1', candidates(1))).rejects.toThrow();
  });
});

test('sends explicit catch-up opt-in and opt-out without replacing runtime state', async () => {
  const values: boolean[] = [];
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = catchUpUpdateSchema.parse(JSON.parse(String(init?.body)));
    expect(body.task.id).toBe('task-1');
    values.push(body.task.catchUpOnStartup);
    return Response.json({ tasks: [] });
  }, previousFetch);
  await upsertScheduledTask('project-1', { id: 'task-1', catchUpOnStartup: true });
  await upsertScheduledTask('project-1', { id: 'task-1', catchUpOnStartup: false });
  expect(values).toEqual([true, false]);
});
