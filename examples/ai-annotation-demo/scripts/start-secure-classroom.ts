import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { ensureClassroomCertificates, resolveClassroomHostAddresses } from './classroom-certificates';
import { startLocalWhisperTranscriptionServer, transcribeFloat32WithWhisper } from '../server/local-whisper-transcription';
import { startLocalSherpaTranscriptionServer } from '../server/local-sherpa-transcription';

const hostAddresses = resolveClassroomHostAddresses(networkInterfaces());
const certDir = resolve('.inkloop/classroom-cert');
const certificates = ensureClassroomCertificates(certDir, hostAddresses);

process.env.INKLOOP_HTTPS_PORT ||= '8872';
process.env.INKLOOP_HTTPS_KEY_PATH ||= certificates.serverKeyPath;
process.env.INKLOOP_HTTPS_CERT_PATH ||= certificates.serverCertPath;
process.env.INKLOOP_CLASSROOM_STORE ||= resolve('.inkloop/classrooms');

const localTranscriptionEnabled = process.env.INKLOOP_CLASSROOM_TRANSCRIPTION_MODE !== 'external'
  && process.env.INKLOOP_CLASSROOM_TRANSCRIPTION_LOCAL !== '0';
if (!process.env.INKLOOP_CLASSROOM_TRANSCRIPTION_URL && localTranscriptionEnabled) {
  const provider = process.env.INKLOOP_CLASSROOM_TRANSCRIPTION_PROVIDER || 'sherpa';
  if (provider === 'whisper') {
    const cliPath = process.env.INKLOOP_WHISPER_CLI || '/opt/homebrew/bin/whisper-cli';
    const modelPath = resolve(process.env.INKLOOP_WHISPER_MODEL || '.inkloop/models/ggml-base.bin');
    if (!existsSync(cliPath)) throw new Error(`本地实时字幕缺少 whisper-cli：${cliPath}（可用 brew install whisper-cpp 安装）`);
    accessSync(cliPath, constants.X_OK);
    if (!existsSync(modelPath)) throw new Error(`本地实时字幕缺少 Whisper 模型：${modelPath}（请运行 npm run setup:classroom-transcription:whisper）`);
    const localWhisper = await startLocalWhisperTranscriptionServer({
      port: Number(process.env.INKLOOP_WHISPER_PORT || 8178), cliPath, modelPath,
      timeoutMs: Number(process.env.INKLOOP_WHISPER_TIMEOUT_MS || 60_000),
    });
    process.env.INKLOOP_CLASSROOM_TRANSCRIPTION_URL = localWhisper.url;
    console.log(`[InkLoop classroom] Whisper 兼容字幕已启动：${localWhisper.url}`);
  } else {
    const modelDirectory = resolve(process.env.INKLOOP_SHERPA_MODEL || '.inkloop/models/sherpa-onnx-streaming-paraformer-bilingual-zh-en');
    if (!existsSync(modelDirectory)) throw new Error(`本地实时字幕缺少中英双语 Paraformer 模型：${modelDirectory}（请运行 npm run setup:classroom-transcription）`);
    const whisperCliPath = process.env.INKLOOP_WHISPER_CLI || '/opt/homebrew/bin/whisper-cli';
    const whisperModelPath = resolve(process.env.INKLOOP_WHISPER_MODEL || '.inkloop/models/ggml-base.bin');
    const finalVerifier = existsSync(whisperCliPath) && existsSync(whisperModelPath)
      ? ({ samples, sampleRate, language }: { samples: Float32Array; sampleRate: number; language: 'zh' | 'en' }) => transcribeFloat32WithWhisper({
        samples, sampleRate, language, cliPath: whisperCliPath, modelPath: whisperModelPath,
        timeoutMs: Number(process.env.INKLOOP_WHISPER_TIMEOUT_MS || 60_000),
      })
      : undefined;
    const localSherpa = await startLocalSherpaTranscriptionServer({
      port: Number(process.env.INKLOOP_SHERPA_PORT || 8178), modelDirectory,
      numThreads: Number(process.env.INKLOOP_SHERPA_THREADS || 2),
      ...(finalVerifier ? { finalVerifier } : {}),
    });
    process.env.INKLOOP_CLASSROOM_TRANSCRIPTION_URL = localSherpa.url;
    console.log(`[InkLoop classroom] 中英双语流式字幕已启动（${finalVerifier ? 'Whisper 整句收尾复核' : '单模型稳定流'}）：${localSherpa.url}`);
  }
  process.env.INKLOOP_CLASSROOM_TRANSCRIPTION_MODE = 'local';
}

console.log('[InkLoop classroom] 首次使用请把下面的根 CA（不是 server 证书）加入系统钥匙串并设为“始终信任”：');
console.log(`  ${certificates.rootCertPath}`);
console.log('[InkLoop classroom] 教师/学生从同一 HTTPS origin 打开：');
console.log(`  https://localhost:${process.env.INKLOOP_HTTPS_PORT}/classroom`);
for (const address of hostAddresses) console.log(`  https://${address}:${process.env.INKLOOP_HTTPS_PORT}/classroom`);
void readFileSync(certificates.serverCertPath);
await import('../server/classroom-only');

export {};
