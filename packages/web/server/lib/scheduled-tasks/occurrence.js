import { isDeepStrictEqual } from 'node:util';

export const TASK_DUE_SLACK_MS = 5_000;

// Both dispatch paths evaluate this against the latest task under its project
// lock. A newer claim also wins over an older startup recovery.
export const canClaimScheduledOccurrence = (candidate, task, scheduledFor, catchUp = false) => {
  if (!candidate?.enabled || !Number.isFinite(scheduledFor)) return false;
  const last = candidate.state?.lastScheduledFor;
  if (!catchUp) return !Number.isFinite(last) || Math.abs(last - scheduledFor) > TASK_DUE_SLACK_MS;
  if (!isDeepStrictEqual(candidate.schedule, task.schedule)) return false;
  if (candidate.catchUpOnStartup !== true) return false;
  return !Number.isFinite(last) || last < scheduledFor - TASK_DUE_SLACK_MS;
};
