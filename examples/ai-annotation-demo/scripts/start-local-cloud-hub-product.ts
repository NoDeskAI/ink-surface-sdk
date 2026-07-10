import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function loadDotEnv(file: string): void {
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

loadDotEnv(resolve('.env'));

process.env.PORT ||= '8731';
process.env.INKLOOP_HTTPS_PORT ||= '8732';
process.env.INKLOOP_LOCAL_DEVICE_AUTH ||= '1';
process.env.INKLOOP_LOCAL_DEVICE_AUTH_AUTO_APPROVE ||= '1';
process.env.INKLOOP_LIBRARY_REQUIRE_SESSION ||= '1';
process.env.INKLOOP_RUNTIME_SYNC_REQUIRE_SESSION ||= '1';
process.env.INKLOOP_KNOWLEDGE_REQUIRE_SESSION ||= '1';
process.env.INKLOOP_DEVICE_REQUIRE_SESSION ||= '1';
process.env.INKLOOP_LOCAL_AUTH_STORE ||= '.inkloop/auth-sessions.json';
process.env.INKLOOP_LIBRARY_STORE ||= '.inkloop/library';
process.env.INKLOOP_RUNTIME_SYNC_STORE ||= '.inkloop/runtime-events.jsonl';
process.env.INKLOOP_KNOWLEDGE_STORE ||= '.inkloop/knowledge';
process.env.INKLOOP_DEVICE_STORE ||= '.inkloop/devices';
process.env.INKLOOP_LOCAL_AUTH_TENANT_ID ||= process.env.INKLOOP_TENANT_ID || 'local';
process.env.INKLOOP_LOCAL_AUTH_USER_ID ||= process.env.INKLOOP_USER_ID || 'local_demo';

const certDir = resolve('.inkloop/dev-cert');
const keyPath = resolve(certDir, 'cloud-hub.key.pem');
const certPath = resolve(certDir, 'cloud-hub.cert.pem');

function ensureLocalHttpsCert(): void {
  if (existsSync(keyPath) && existsSync(certPath)) return;
  mkdirSync(certDir, { recursive: true });
  const result = spawnSync('openssl', [
    'req',
    '-x509',
    '-newkey', 'rsa:2048',
    '-nodes',
    '-keyout', keyPath,
    '-out', certPath,
    '-days', '825',
    '-subj', '/CN=InkLoop Local Cloud Hub',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:10.0.2.2,IP:0.0.0.0',
  ], { stdio: 'ignore' });
  if (result.status !== 0) {
    console.warn('[inkloop cloud-hub] openssl failed; HTTPS endpoint disabled');
    process.env.INKLOOP_HTTPS_PORT = '0';
  }
}

ensureLocalHttpsCert();
process.env.INKLOOP_HTTPS_KEY_PATH ||= keyPath;
process.env.INKLOOP_HTTPS_CERT_PATH ||= certPath;

await import('../server/standalone');

export {};
