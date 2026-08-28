/**
 * Per-user concurrency slots.
 *
 * Deliberately in-memory: restarting the bot clears every slot, so a crash
 * mid-render can never leave someone permanently locked out.
 *
 * Slots are timestamped job records rather than a bare counter. A counter only
 * stays correct if every increment is matched by a decrement — miss one release
 * and the user is stuck at "3 running" forever with nothing actually running.
 * Timestamped records expire on their own, so the worst case is a temporary
 * miscount instead of a permanent lockout.
 */
import { randomUUID } from 'node:crypto';

export function createSlotManager({ maxPerUser = 3, maxJobAgeMs = 960_000, now = Date.now } = {}) {
  const users = new Map(); // userId -> Map<jobId, startedAt>

  const prune = (userId) => {
    const jobs = users.get(userId);
    if (!jobs) return [];
    const cutoff = now() - maxJobAgeMs;
    const reclaimed = [];
    for (const [jobId, startedAt] of jobs) {
      if (startedAt < cutoff) {
        jobs.delete(jobId);
        reclaimed.push(jobId);
      }
    }
    if (jobs.size === 0) users.delete(userId);
    return reclaimed;
  };

  return {
    /** Returns a job id, or null when the user is at their limit.
     *  Pass unlimited=true to bypass the per-user cap entirely. */
    take(userId, unlimited = false) {
      prune(userId);
      const jobs = users.get(userId) ?? new Map();
      if (!unlimited && jobs.size >= maxPerUser) return null;
      const jobId = randomUUID();
      jobs.set(jobId, now());
      users.set(userId, jobs);
      return jobId;
    },

    /** Idempotent — releasing twice, or releasing an unknown id, is harmless. */
    release(userId, jobId) {
      const jobs = users.get(userId);
      if (!jobs) return;
      jobs.delete(jobId);
      if (jobs.size === 0) users.delete(userId);
    },

    running(userId) {
      prune(userId);
      return users.get(userId)?.size ?? 0;
    },

    /** Exposed for the reclaim log line. */
    prune,

    /** Total across all users — handy for diagnostics. */
    total() {
      let n = 0;
      for (const jobs of users.values()) n += jobs.size;
      return n;
    },
  };
}
