import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pollDelay } from 'node:timers/promises';

export const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
export const runtimeSecret = 's5a-synthetic-only-signing-key-at-least-32-characters';

export async function reserveHttpPort() {
  const socket = createServer();
  await new Promise<void>((accept, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', accept); });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No owned HTTP port');
  await new Promise<void>((accept, reject) => socket.close(error => error ? reject(error) : accept()));
  return address.port;
}

export function runtimeEnvironment(databaseUrl: string, port: number, overrides: Record<string, string> = {}) {
  return { DATABASE_URL: databaseUrl, NODE_ENV: 'test', MOCK_AUTH_ENABLED: 'true', JWT_SECRET: runtimeSecret,
    PORT: String(port), ...overrides };
}

/** A direct Node child only: no shell, detached task, process enumeration, or tree-wide kill. */
export function startRuntimeProcess(args: string[], environment: Record<string, string>) {
  const hostEnvironment: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP']) {
    if (process.env[key]) hostEnvironment[key] = process.env[key];
  }
  const child = spawn(process.execPath, args, { cwd: runtimeRoot, env: { ...hostEnvironment, ...environment },
    shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', value => { output += String(value); });
  child.stderr.on('data', value => { output += String(value); });
  let exited = false;
  const completion = new Promise<{ code: number | null; output: string }>((accept, reject) => {
    child.once('error', reject);
    child.once('close', code => { exited = true; accept({ code, output }); });
  });
  // Observe launch errors even if readiness detects the exit first.
  void completion.catch(() => {});
  async function finishWithin(milliseconds: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([completion, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned runtime process exceeded its bounded deadline')), milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  }
  return {
    get output() { return output; },
    async waitForExit() { return finishWithin(15_000); },
    async waitUntilReady(baseUrl: string) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (exited) throw new Error('Owned runtime CLI exited before HTTP readiness');
        try {
          const response = await fetch(`${baseUrl}/api/v1/health/ready`, { signal: AbortSignal.timeout(500) });
          if (response.status === 200 && (await response.json()).database === 'up') return;
        } catch { /* Startup connection refusal is expected until the readiness boundary responds. */ }
        await pollDelay(40);
      }
      throw new Error('Owned runtime CLI did not reach HTTP readiness within deadline');
    },
    async stop() {
      if (!exited) child.kill('SIGTERM');
      await finishWithin(5_000);
    },
  };
}

export async function ownedEnvironmentFile(environment: Record<string, string>) {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'wms-s5a-env-'));
  const path = join(directory, '.env');
  await writeFile(path, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
  return { path, async stop() {
    const target = await realpath(directory);
    const inside = relative(parent, target);
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || !inside.startsWith('wms-s5a-env-')) {
      throw new Error('Refusing cleanup outside owned runtime environment directory');
    }
    await rm(target, { recursive: true, force: true });
  } };
}
