import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = join(root, 'Lark-Meeting-Timeline-main');

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[key] == null) process.env[key] = value;
  }
}

loadDotEnv(join(root, '.env'));

const port = String(process.env.LARK_MEETING_SDK_PORT || process.env.LARK_SDK_PORT || '8789');
const env = {
  ...process.env,
  PORT: port,
  LARK_APP_ID: process.env.LARK_APP_ID || process.env.FEISHU_APP_ID || '',
  LARK_APP_SECRET: process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET || '',
  LARK_REDIRECT_URI: process.env.LARK_REDIRECT_URI || `http://localhost:${port}/api/auth/lark/callback`,
};

const child = spawn('npm', ['run', 'start:plain'], {
  cwd: sdkRoot,
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
