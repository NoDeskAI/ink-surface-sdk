/**
 * dev-only：英文手写识别端点（识别分类器选「端侧手写·OpenVINO」时走这里）。
 *
 * 持久 worker（保活）：spawn 一个 `hwr_runner.py --serve` 常驻进程，模型只加载一次；
 * 之后每次请求把临时图片路径写进 worker.stdin、读回一行 JSON。首次请求付模型加载(~2.5s)，之后只剩推理(~百毫秒)。
 * 单 stdin/stdout 流 → 请求串行化（一次一个）。worker 挂了下次请求自动重启。
 *
 * shell 到 端侧ocr方案/hwr_runner（OpenVINO handwritten-english-recognition-0001，图像式行识别，**英文 only**）。
 * ⚠️ 仅 dev：**不进生产 standalone 代理**。板上换 NPU 跑同模型，前端契约 {reading} 不变。
 *
 * REQ  { image: dataURL }   RES  { reading: string }
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNNER_DIR = process.env.HWR_RUNNER_DIR || '/Users/edy/Desktop/Nova_project/端侧ocr方案/hwr_runner';
const PYTHON = process.env.MAC_RUNNER_PYTHON || '/Users/edy/Desktop/Nova_project/端侧ocr方案/mac_runner/.venv/bin/python';

let worker = null;            // 持久 python worker（模型常驻）
let pending = null;           // 当前在途请求的 resolve（串行，一次一个）
let buf = '';

function ensureWorker() {
  if (worker && !worker.killed) return worker;
  const p = spawn(PYTHON, ['hwr_runner.py', '--serve'], { cwd: RUNNER_DIR });
  buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.ready) continue; // 启动就绪信号，跳过
      const r = pending; pending = null;
      if (r) r(obj);
    }
  });
  p.stderr.on('data', () => { /* 吞 openvino 日志 */ });
  p.on('exit', () => {
    if (worker === p) worker = null;
    const r = pending; pending = null;
    if (r) r({ reading: '', error: 'worker exited' });
  });
  worker = p;
  return p;
}

// 串行队列：单 worker 流，前一个完成才发下一个。
let queue = Promise.resolve();

export async function runInterpretHwr(payload) {
  const dataUrl = payload?.image;
  if (typeof dataUrl !== 'string' || !dataUrl) throw new Error('image (dataURL) required');
  const comma = dataUrl.indexOf(',');
  const imgBuf = Buffer.from(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, 'base64');

  const run = queue.then(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hwr-'));
    const imgPath = join(dir, 'ink.png');
    await writeFile(imgPath, imgBuf);
    try {
      const p = ensureWorker();
      return await new Promise((resolve) => {
        pending = resolve;
        const to = setTimeout(() => { if (pending === resolve) { pending = null; resolve({ reading: '', error: 'timeout' }); } }, 20000);
        const wrapped = (v) => { clearTimeout(to); resolve(v); };
        pending = wrapped;
        p.stdin.write(imgPath + '\n');
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  queue = run.then(() => {}, () => {}); // 链式串行，吞错不断链
  return run;
}
