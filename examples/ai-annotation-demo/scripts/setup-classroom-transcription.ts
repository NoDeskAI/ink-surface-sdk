import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const provider = process.env.INKLOOP_CLASSROOM_TRANSCRIPTION_PROVIDER || 'sherpa';
if (provider !== 'whisper') {
  const directory = resolve('.inkloop/models');
  const name = 'sherpa-onnx-streaming-paraformer-bilingual-zh-en';
  const target = resolve(directory, name);
  const archive = resolve(directory, `${name}.tar.bz2`);
  const partial = `${archive}.download`;
  const url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${name}.tar.bz2`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(target) && statSync(target).isDirectory()) {
    console.log(`[InkLoop classroom] 中英双语流式模型已存在：${target}`);
    process.exit(0);
  }
  console.log('[InkLoop classroom] 正在下载 sherpa-onnx 中英双语流式 Paraformer（约 1 GB，仅保存在本机）...');
  const downloaded = spawnSync('curl', ['-fL', '--retry', '8', '--retry-all-errors', '--connect-timeout', '20', '-C', '-', '-o', partial, url], { stdio: 'inherit' });
  if (downloaded.status !== 0) throw new Error('Paraformer 模型下载失败，请检查网络后重试（支持断点续传）');
  if (statSync(partial).size < 100_000_000) throw new Error('Paraformer 模型文件异常小，拒绝启用');
  renameSync(partial, archive);
  const extracted = spawnSync('tar', ['-xjf', archive, '-C', directory], { stdio: 'inherit' });
  if (extracted.status !== 0 || !existsSync(target)) throw new Error('Paraformer 模型解压失败');
  console.log(`[InkLoop classroom] 中英双语流式模型就绪：${target}`);
  process.exit(0);
}

const model = process.env.INKLOOP_WHISPER_MODEL_NAME || 'base';
if (!/^(tiny|base|small)(-q5_1|-q8_0)?$/.test(model)) throw new Error('INKLOOP_WHISPER_MODEL_NAME 只允许多语种 tiny/base/small 模型');
const directory = resolve('.inkloop/models');
const target = resolve(directory, `ggml-${model}.bin`);
const partial = `${target}.download`;
const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
mkdirSync(directory, { recursive: true, mode: 0o700 });

if (existsSync(target) && statSync(target).size > 1_000_000) {
  console.log(`[InkLoop classroom] Whisper 模型已存在：${target}`);
  process.exit(0);
}

console.log(`[InkLoop classroom] 正在下载多语种 Whisper ${model} 模型（仅保存在本机，不进入 Git）...`);
const response = await fetch(url, { redirect: 'follow' });
if (!response.ok || !response.body) throw new Error(`Whisper 模型下载失败：HTTP ${response.status}`);
await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(partial, { mode: 0o600 }));
if (statSync(partial).size < 1_000_000) throw new Error('Whisper 模型文件异常小，拒绝启用');
renameSync(partial, target);
const hash = createHash('sha256');
for await (const chunk of (await import('node:fs')).createReadStream(target)) hash.update(chunk);
console.log(`[InkLoop classroom] 模型就绪：${target}`);
console.log(`[InkLoop classroom] SHA-256：${hash.digest('hex')}`);
