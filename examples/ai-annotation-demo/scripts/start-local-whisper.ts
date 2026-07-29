/**
 * Start the project-owned local Whisper development provider with the same VAD
 * and non-speech policy used by real Meeting Media validation.
 *
 * Model paths and tuning stay overridable so this script remains a launcher,
 * not a production Provider decision.
 */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const whisperExecutable = process.env.INKLOOP_WHISPER_SERVER_BIN?.trim() || 'whisper-server';
const modelPath = process.env.INKLOOP_WHISPER_MODEL_PATH?.trim()
  || resolve(homedir(), 'Library/Application Support/InkLoop/Models/ggml-large-v3-turbo-q5_0.bin');
const vadModelPath = process.env.INKLOOP_WHISPER_VAD_MODEL_PATH?.trim()
  || resolve(homedir(), 'Library/Application Support/InkLoop/Models/ggml-silero-v6.2.0.bin');
const language = process.env.INKLOOP_WHISPER_LANGUAGE?.trim() || 'zh';
const host = process.env.INKLOOP_WHISPER_HOST?.trim() || '127.0.0.1';
const port = process.env.INKLOOP_WHISPER_PORT?.trim() || '8081';

await Promise.all([
  access(modelPath).catch(() => { throw new Error(`whisper_model_missing:${modelPath}`); }),
  access(vadModelPath).catch(() => { throw new Error(`whisper_vad_model_missing:${vadModelPath}`); }),
]);

const args = [
  '-m', modelPath,
  '-l', language,
  '--host', host,
  '--port', port,
  '--convert',
  '--vad',
  '-vm', vadModelPath,
  '-vt', process.env.INKLOOP_WHISPER_VAD_THRESHOLD?.trim() || '0.55',
  '-vspd', process.env.INKLOOP_WHISPER_MIN_SPEECH_MS?.trim() || '120',
  '-vsd', process.env.INKLOOP_WHISPER_MIN_SILENCE_MS?.trim() || '500',
  '-vmsd', process.env.INKLOOP_WHISPER_MAX_SPEECH_SECONDS?.trim() || '20',
  '-vp', process.env.INKLOOP_WHISPER_SPEECH_PAD_MS?.trim() || '200',
  '-vo', process.env.INKLOOP_WHISPER_OVERLAP_SECONDS?.trim() || '0.5',
  '--prompt', process.env.INKLOOP_STREAMING_ASR_PROMPT?.trim()
    || 'InkLoop，AI Pen，白板笔，电子纸，虚拟摄像头，Google Meet，Zoom，硬件，软件，竞品，轨迹，入射角，畸变，矢量，SKU。',
  '-sns',
];

console.info([
  '[meeting-media:whisper]',
  `http://${host}:${port}/inference`,
  `model=${modelPath}`,
  `vad_model=${vadModelPath}`,
  `language=${language}`,
].join(' '));

const child = spawn(whisperExecutable, args, { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    child.kill(signal);
  });
}
child.once('error', (error) => {
  console.error(`[meeting-media:whisper] ${String(error)}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
