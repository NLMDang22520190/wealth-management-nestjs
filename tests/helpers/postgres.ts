import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test PostgreSQL port');
  await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  return address.port;
}

/** Every invocation owns a new DB; external URLs are admin connections, never reset targets. */
export async function startTestDatabase() {
  let embedded: EmbeddedPostgres | undefined;
  let ownedDirectory: string | undefined;
  let adminUrl = process.env.WMS_TEST_POSTGRES_ADMIN_URL;
  const databaseName = `wms_test_${randomUUID().replaceAll('-', '')}`;

  if (!adminUrl) {
    const tempRoot = await realpath(tmpdir());
    ownedDirectory = await mkdtemp(join(tempRoot, 'wms-pg-'));
    if (!/^[\x00-\x7f]+$/.test(ownedDirectory)) {
      throw new Error('Set an ASCII TEMP directory or WMS_TEST_POSTGRES_ADMIN_URL for embedded PostgreSQL');
    }
    const port = await availablePort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(ownedDirectory, 'data'),
      user: 'postgres',
      password: 'wms-isolated-test-password',
      port,
      persistent: true,
    });
    await embedded.initialise();
    await embedded.start();
    adminUrl = `postgresql://postgres:wms-isolated-test-password@127.0.0.1:${port}/postgres`;
  }

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  const connectionUrl = new URL(adminUrl);
  connectionUrl.pathname = `/${databaseName}`;

  return {
    databaseName,
    databaseUrl: connectionUrl.toString(),
    async stop() {
      // Drop only the generated database; never reuse or truncate the supplied admin DB.
      if (!/^wms_test_[a-f0-9]{32}$/.test(databaseName)) throw new Error('Unsafe test database name');
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
        await embedded?.stop();
      }
      if (ownedDirectory) {
        const absoluteTarget = await realpath(ownedDirectory);
        const absoluteTempRoot = await realpath(tmpdir());
        const insideTemp = relative(absoluteTempRoot, absoluteTarget);
        if (!insideTemp || insideTemp.startsWith('..') || isAbsolute(insideTemp) || resolve(absoluteTarget) === resolve(absoluteTempRoot)) {
          throw new Error('Refusing cleanup outside owned temporary PostgreSQL directory');
        }
        await rm(absoluteTarget, { recursive: true, force: true });
      }
    },
  };
}
