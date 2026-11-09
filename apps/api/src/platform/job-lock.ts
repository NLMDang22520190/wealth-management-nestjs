import type { DataSource } from 'typeorm';

/** A session-level advisory lock on a dedicated connection keeps a job to one instance at a time. `undefined` means another run holds it. */
export async function withJobLock<T>(database: DataSource, name: string, work: () => Promise<T>): Promise<{ value: T } | undefined> {
  const session = database.createQueryRunner();
  await session.connect();
  try {
    const [row] = await session.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [name]);
    if (!row.locked) return undefined;
    try {
      return { value: await work() };
    } finally {
      await session.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [name]);
    }
  } finally {
    await session.release();
  }
}
