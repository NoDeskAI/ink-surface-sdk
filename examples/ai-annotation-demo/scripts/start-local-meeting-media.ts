/**
 * Start the local Meeting Media ingress with the development device identity
 * expected by InkLoop Meeting Companion.
 *
 * Override any value through the environment when testing another Provider.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tokenPath = process.env.INKLOOP_LOCAL_DEVICE_AUTH_TOKEN_FILE
  || resolve(repositoryRoot, '.inkloop/meeting-validation/session-token');
if (!process.env.INKLOOP_LOCAL_DEVICE_AUTH_TOKEN) {
  let token = '';
  try {
    token = (await readFile(tokenPath, 'utf8')).trim();
  } catch {
    // Created below.
  }
  if (!/^[A-Fa-f0-9]{64}$/.test(token)) {
    token = randomBytes(32).toString('hex');
    await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  }
  process.env.INKLOOP_LOCAL_DEVICE_AUTH_TOKEN = token;
}
process.env.HOST ||= '127.0.0.1';
process.env.INKLOOP_LOCAL_DEVICE_AUTH ||= '1';
process.env.INKLOOP_LOCAL_DEVICE_AUTH_AUTO_APPROVE ||= '1';
process.env.INKLOOP_STREAMING_ASR_URL ||= 'http://127.0.0.1:8081/inference';
process.env.INKLOOP_STREAMING_ASR_MODEL ||= 'ggml-large-v3-turbo-q5_0';
process.env.INKLOOP_STREAMING_ASR_LANGUAGE ||= 'zh';
process.env.INKLOOP_STREAMING_ASR_PROMPT ||= [
  'InkLoop', 'AI Pen', '白板笔', '电子纸', '虚拟摄像头', 'Google Meet', 'Zoom',
  '硬件', '软件', '竞品', '轨迹', '入射角', '畸变', '矢量', 'SKU',
].join('，');
process.env.INKLOOP_STREAMING_ASR_MINIMUM_WINDOW_MS ||= '3000';
process.env.INKLOOP_STREAMING_ASR_REVISION_INTERVAL_MS ||= '4000';
process.env.INKLOOP_STREAMING_ASR_MAXIMUM_WINDOW_MS ||= '20000';

console.info([
  '[meeting-media:local] Companion endpoint:',
  `http://127.0.0.1:${process.env.PORT || '3000'}`,
  `token_file=${tokenPath}`,
].join(' '));
console.info([
  '[meeting-media:local] ASR Provider:',
  process.env.INKLOOP_STREAMING_ASR_PROVIDER?.trim() || 'openai-compatible-buffered',
  `endpoint=${process.env.INKLOOP_STREAMING_ASR_URL}`,
  `model=${process.env.INKLOOP_STREAMING_ASR_MODEL}`,
  `window=${process.env.INKLOOP_STREAMING_ASR_MINIMUM_WINDOW_MS}/${process.env.INKLOOP_STREAMING_ASR_REVISION_INTERVAL_MS}/${process.env.INKLOOP_STREAMING_ASR_MAXIMUM_WINDOW_MS}ms`,
].join(' '));

await import('../server/standalone');

export {};
