/**
 * Durable job store for in-flight generations.
 *
 * A generation is persisted to disk the moment it's submitted to the provider,
 * and removed the moment it reaches a terminal state (delivered, failed, blocked,
 * timed out). If the process is killed mid-render — an OOM SIGKILL, a deploy, a
 * host reap — the record survives, and on the next boot the bot re-polls the
 * generation and delivers it to the original message instead of losing it.
 *
 * One JSON file per job, written atomically (write temp + rename) so a kill
 * during a write can never leave a half-written, unparseable record.
 *
 * Note: records contain the disposable account's session token so the generation
 * can be re-polled after a restart. These are throwaway per-generation accounts,
 * but keep the store directory off any public path regardless.
 */
import { mkdir, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';

export function createJobStore({ dir = './.jobs' } = {}) {
  let ready = null;
  const ensure = () => {
    ready ??= mkdir(dir, { recursive: true }).then(() => {}).catch(() => {});
    return ready;
  };

  const fileFor = (jobId) => path.join(dir, `${encodeURIComponent(jobId)}.json`);

  return {
    /** Persist (or overwrite) a job record. Atomic. */
    async save(record) {
      if (!record?.jobId) throw new Error('job record needs a jobId');
      await ensure();
      const file = fileFor(record.jobId);
      const tmp = `${file}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(record), 'utf8');
      await rename(tmp, file); // atomic on the same filesystem
    },

    /** Remove a job record. Safe to call for an unknown / already-gone id. */
    async remove(jobId) {
      try { await unlink(fileFor(jobId)); } catch { /* already gone */ }
    },

    /** Every persisted job record. Corrupt files are skipped, not fatal. */
    async list() {
      await ensure();
      let names;
      try { names = await readdir(dir); } catch { return []; }
      const records = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const raw = await readFile(path.join(dir, name), 'utf8');
          records.push(JSON.parse(raw));
        } catch { /* skip a corrupt / partial record */ }
      }
      return records;
    },
  };
}
