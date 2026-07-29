/**
 * One-shot OBS Camera Adapter launcher.
 *
 * It temporarily restarts OBS with an authenticated IPv4-localhost WebSocket,
 * configures the InkLoop scene, restores the user's exact WebSocket config,
 * then relaunches OBS with the persisted scene and virtual camera. The control
 * port is never left enabled after setup.
 */
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { access, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { connect } from 'node:net';
import { parseArgs, promisify } from 'node:util';
import {
  OBS_INTERVIEW_SCENE,
  obsExecutableProcessPattern,
  obsRelaunchArgs,
  obsSentinelBackupName,
  obsStartupBlocker,
  obsVirtualCameraStarted,
  parseObsProcessIds,
  temporaryObsWebSocketConfig,
  type ObsWebSocketConfig,
} from './obs-interview-camera-core';

const execFileAsync = promisify(execFile);
const obsApplication = process.env.INKLOOP_OBS_APP || '/Applications/OBS.app';
const obsExecutable = resolve(obsApplication, 'Contents/MacOS/OBS');
const websocketPort = Number(process.env.INKLOOP_OBS_WEBSOCKET_PORT || 4455);
const websocketConfig = resolve(
  homedir(),
  'Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json',
);
const projectRoot = resolve(import.meta.dirname, '..');
const obsProcessPattern = obsExecutableProcessPattern(obsExecutable);
const obsSentinelDirectory = resolve(homedir(), 'Library/Application Support/obs-studio/.sentinel');
const obsLogsDirectory = resolve(homedir(), 'Library/Application Support/obs-studio/logs');
const parsedArguments = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'force-restart': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
  allowPositionals: false,
});

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

async function obsRunning(): Promise<boolean> {
  try {
    await execFileAsync('pgrep', ['-f', obsProcessPattern]);
    return true;
  } catch { return false; }
}

async function obsProcessIds(): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', obsProcessPattern]);
    return parseObsProcessIds(stdout);
  } catch {
    return [];
  }
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error('obs_launcher_timeout');
}

async function waitUntilResult(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  try {
    await waitUntil(predicate, timeoutMs);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'obs_launcher_timeout') return false;
    throw error;
  }
}

async function portOpen(): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port: websocketPort });
    const done = (open: boolean) => { socket.destroy(); resolvePromise(open); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

async function quitObs(): Promise<void> {
  if (!await obsRunning()) return;
  try {
    await execFileAsync('osascript', ['-e', 'tell application "OBS" to quit']);
  } catch { /* Continue with the process-scoped fallback below. */ }
  if (await waitUntilResult(async () => !await obsRunning(), 3_000)) return;

  // OBS can reject AppleScript quit while an output is active because its
  // confirmation sheet has no operator in unattended launches. SIGTERM is a
  // normal, catchable termination request and gives OBS another chance to
  // persist its scene collection.
  let pids = await obsProcessIds();
  if (!pids.length) return;
  await Promise.all(pids.map((pid) => execFileAsync('kill', ['-TERM', String(pid)])));
  if (await waitUntilResult(async () => !await obsRunning(), 5_000)) return;

  // Active virtual-camera output can leave OBS waiting on the same sheet even
  // after SIGTERM. Re-resolve the exact executable-scoped PIDs before the last
  // resort so an exited/replaced process can never inherit the earlier PID.
  pids = await obsProcessIds();
  if (!pids.length) return;
  await Promise.all(pids.map((pid) => execFileAsync('kill', ['-KILL', String(pid)])));
  await waitUntil(async () => !await obsRunning(), 5_000);
}

async function recoverStaleObsSentinels(): Promise<string[]> {
  if (await obsRunning() || !await exists(obsSentinelDirectory)) return [];
  const names = (await readdir(obsSentinelDirectory))
    .filter((name) => /^run_[0-9a-f-]+$/i.test(name));
  if (!names.length) return [];
  const batchId = randomBytes(8).toString('hex');
  const backupDirectory = resolve(obsSentinelDirectory, 'inkloop-recovered');
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const recovered: string[] = [];
  for (const name of names) {
    const backupName = obsSentinelBackupName(name, batchId);
    await rename(resolve(obsSentinelDirectory, name), resolve(backupDirectory, backupName));
    recovered.push(backupName);
  }
  return recovered;
}

async function latestObsLogSince(sinceMs: number): Promise<string> {
  if (!await exists(obsLogsDirectory)) return '';
  const candidates = await Promise.all((await readdir(obsLogsDirectory))
    .filter((name) => name.endsWith('.txt'))
    .map(async (name) => {
      const path = resolve(obsLogsDirectory, name);
      return { path, modifiedMs: (await stat(path)).mtimeMs };
    }));
  const latest = candidates
    .filter((candidate) => candidate.modifiedMs >= sinceMs - 2_000)
    .sort((left, right) => right.modifiedMs - left.modifiedMs)[0];
  return latest ? await readFile(latest.path, 'utf8') : '';
}

function startObs(args: string[]): void {
  const child = spawn(obsExecutable, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function configure(password: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync('npm', ['run', '--silent', 'configure:obs-interview-camera'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      INKLOOP_OBS_WEBSOCKET_URL: `ws://127.0.0.1:${websocketPort}`,
      INKLOOP_OBS_WEBSOCKET_PASSWORD: password,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function main(): Promise<void> {
  if (parsedArguments.values.help) {
    process.stdout.write([
      'Usage: npm run launch:obs-interview-camera -- --dry-run',
      '       npm run launch:obs-interview-camera -- --force-restart',
      '',
      '--dry-run        Report the exact OBS process/config targets without mutation.',
      '--force-restart  Explicitly allow OBS restart and temporary config replacement.',
      '',
    ].join('\n'));
    return;
  }
  if (!Number.isInteger(websocketPort) || websocketPort < 1024 || websocketPort > 65_535) {
    throw new Error('obs_websocket_port_invalid');
  }
  if (!await exists(obsExecutable)) throw new Error(`obs_not_installed:${obsApplication}`);
  if (parsedArguments.values['dry-run']) {
    process.stdout.write(`${JSON.stringify({
      schema_version: 'inkloop.obs_interview_camera_dry_run.v1',
      mutation_authorized: false,
      obs_running: await obsRunning(),
      targeted_process_ids: await obsProcessIds(),
      executable: obsExecutable,
      websocket_config: websocketConfig,
      scene: OBS_INTERVIEW_SCENE,
    }, null, 2)}\n`);
    return;
  }
  if (!parsedArguments.values['force-restart']) {
    throw new Error('obs_force_restart_required');
  }

  const wasRunning = await obsRunning();
  const originalExists = await exists(websocketConfig);
  const originalBytes = originalExists ? await readFile(websocketConfig) : null;
  const existing = originalBytes
    ? JSON.parse(originalBytes.toString('utf8')) as ObsWebSocketConfig
    : {};
  const password = randomBytes(32).toString('base64url');
  let report: Record<string, unknown> | null = null;
  let finalVirtualCameraStarted = false;

  await quitObs();
  const recoveredStaleSentinels = {
    before_automation: await recoverStaleObsSentinels(),
    after_automation: [] as string[],
  };
  await mkdir(dirname(websocketConfig), { recursive: true, mode: 0o700 });
  await writeFile(
    websocketConfig,
    `${JSON.stringify(temporaryObsWebSocketConfig(existing, password, websocketPort), null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(websocketConfig, 0o600);

  try {
    const automationStartedAt = Date.now();
    startObs([
      '--websocket_port', String(websocketPort),
      '--websocket_ipv4_only',
      '--scene', OBS_INTERVIEW_SCENE,
    ]);
    try {
      await waitUntil(portOpen, 20_000);
    } catch (error) {
      const blocker = obsStartupBlocker(await latestObsLogSince(automationStartedAt));
      if (blocker) throw new Error(blocker);
      throw error;
    }
    report = await configure(password);
  } finally {
    let automationStopped = false;
    try {
      await quitObs();
      automationStopped = true;
      recoveredStaleSentinels.after_automation = await recoverStaleObsSentinels();
    } catch {
      // The exact original WebSocket bytes are still restored below, but a
      // second OBS instance must never be launched if the automation instance
      // could not be stopped and verified absent.
    }
    if (originalBytes) {
      await writeFile(websocketConfig, originalBytes, { mode: 0o600 });
      await chmod(websocketConfig, 0o600);
    } else {
      await rm(websocketConfig, { force: true });
    }
    if (!automationStopped) throw new Error('obs_automation_cleanup_failed');
    const relaunchArgs = obsRelaunchArgs(report?.ok === true, wasRunning);
    if (relaunchArgs) {
      const finalStartedAt = Date.now();
      startObs(relaunchArgs);
      await waitUntil(obsRunning, 15_000);
      if (report?.ok === true) {
        await waitUntil(async () => {
          finalVirtualCameraStarted = obsVirtualCameraStarted(
            await latestObsLogSince(finalStartedAt),
          );
          return finalVirtualCameraStarted;
        }, 20_000);
      }
    }
  }

  const websocketListeningAfterSetup = await portOpen();
  const websocketExpectedAfterSetup = existing.server_enabled === true;
  const output = {
    schema_version: 'inkloop.obs_interview_camera_launcher.v1',
    ok: report?.ok === true,
    websocket_restored: originalBytes
      ? (await readFile(websocketConfig)).equals(originalBytes)
      : !await exists(websocketConfig),
    websocket_listening_after_setup: websocketListeningAfterSetup,
    websocket_expected_after_setup: websocketExpectedAfterSetup,
    obs_relaunched: await obsRunning(),
    final_virtual_camera_started: finalVirtualCameraStarted,
    recovered_stale_sentinels: recoveredStaleSentinels,
    camera_adapter: report,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.ok
    || !output.final_virtual_camera_started
    || !output.websocket_restored
    || websocketListeningAfterSetup !== websocketExpectedAfterSetup) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${String((error as Error)?.message || error)}\n`
    + 'Run with --help for safe invocation details.\n',
  );
  process.exitCode = 2;
}
