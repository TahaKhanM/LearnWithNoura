#!/usr/bin/env node
/** Run the evidence contract against a private, disposable local PostgreSQL server. */
import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
let activeChild;
let interrupted;
let scratch;
let bin;
let cleaning = false;

function interrupt(signal) {
  if (cleaning) return;
  interrupted ??= signal;
  activeChild?.kill(signal);
}
const onSigint = () => interrupt('SIGINT');
const onSigterm = () => interrupt('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);

async function run(command, args, { visible = false, cleanup = false, env = process.env } = {}) {
  if (interrupted && !cleanup) throw new Error(`Interrupted by ${interrupted}`);
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: project, env, stdio: visible ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    let output = '';
    child.stdout?.on('data', data => { output += data; });
    child.stderr?.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      if (code === 0) resolveRun(output);
      else reject(new Error(`${command} failed (${signal ?? code}).\n${output.slice(-6000)}`));
    });
  });
}

async function stopAndRemove() {
  if (!scratch) return;
  cleaning = true;
  const data = join(scratch, 'data');
  const pidFile = join(data, 'postmaster.pid');
  if (existsSync(pidFile)) {
    try {
      await run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-t', '10', '-w', 'stop'], { cleanup: true });
    } catch {
      await run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-t', '10', '-w', 'stop'], { cleanup: true });
    }
  }
  await rm(scratch, { recursive: true, force: true });
  console.log(`Removed disposable PostgreSQL cluster: ${scratch}`);
}

try {
  if (process.platform === 'win32') throw new Error('This runner requires local Unix sockets (macOS or Linux).');
  if (process.env.NOURA_POSTGRES_BIN) bin = resolve(process.env.NOURA_POSTGRES_BIN);
  else {
    try { bin = (await run('pg_config', ['--bindir'])).trim(); }
    catch { throw new Error('Install PostgreSQL separately, then put pg_config on PATH or set NOURA_POSTGRES_BIN to its bin directory.'); }
  }
  for (const executable of ['initdb', 'pg_ctl', 'createdb']) await access(join(bin, executable), constants.X_OK);
  // /tmp gives short, predictable socket paths and matches the integration-test guard.
  scratch = await mkdtemp('/tmp/noura-postgres-');
  const socket = join(scratch, 'socket');
  const data = join(scratch, 'data');
  await mkdir(socket, { mode: 0o700 });
  console.log(`Starting disposable PostgreSQL cluster: ${scratch}`);
  await run(join(bin, 'initdb'), ['-D', data, '-U', 'noura_test', '--auth=trust', '--encoding=UTF8', '--no-locale']);
  await run(join(bin, 'pg_ctl'), ['-D', data, '-l', join(scratch, 'server.log'), '-w', '-t', '15', '-o',
    `-k ${socket} -p 55438 -c listen_addresses='' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=20`, 'start']);
  await run(join(bin, 'createdb'), ['-h', socket, '-p', '55438', '-U', 'noura_test', 'noura_evidence_test']);
  await run(process.execPath, [join(project, 'node_modules/vitest/vitest.mjs'), 'run', 'server/store/evidenceSources.test.ts', '--reporter=dot'], {
    visible: true,
    env: {
      ...process.env,
      NOURA_TEST_POSTGRES_SOCKET: socket,
      NOURA_DEPLOYMENT_MODE: 'local-synthetic',
      NOURA_LESSON_COMPILER: 'fixture',
      OPENAI_API_KEY: '',
      DATABASE_URL: '',
    },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (scratch) {
    try { console.error((await readFile(join(scratch, 'server.log'), 'utf8')).slice(-4000)); }
    catch { /* startup may have failed before PostgreSQL wrote a log */ }
  }
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
} finally {
  try { await stopAndRemove(); }
  catch (error) {
    // Retain a live cluster's files if shutdown itself fails; never unlink underneath it.
    console.error(`Could not clean up ${scratch}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
}
