/**
 * dev-only：图片版/扫描 PDF 的「带坐标 OCR」端点（Phase 2 位置文本层用）。
 *
 * shell 到 端侧ocr方案/mac_runner（RapidOCR，与板上 PP-OCR 同一套 det/rec 模型），拿每行 box+text+score。
 * 前端 src/evidence/page-ocr.ts 把它转成带 bbox 的 OcrTextBlock → SurfaceIndex。
 *
 * ⚠️ 仅 dev（本机有 mac_runner venv）：**不进生产 standalone 代理**。
 *    板子到位后换成 PpOcrBridge 透出 box（com.paddle.ocr 的 OCRBox+BoxSorter），前端契约 {blocks,width,height} 不变。
 *
 * REQ  { image: dataURL }
 * RES  { blocks: [{ text, box:[[x,y]*4(像素)], score }], width, height }
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNNER_DIR = process.env.MAC_RUNNER_DIR
  || '/Users/edy/Desktop/Nova_project/端侧ocr方案/mac_runner';
const PYTHON = process.env.MAC_RUNNER_PYTHON || join(RUNNER_DIR, '.venv/bin/python');

export async function runOcrLayout(payload) {
  const dataUrl = payload?.image;
  if (typeof dataUrl !== 'string' || !dataUrl) throw new Error('image (dataURL) required');
  const comma = dataUrl.indexOf(',');
  const buf = Buffer.from(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, 'base64');
  const dir = await mkdtemp(join(tmpdir(), 'ocrlayout-'));
  const imgPath = join(dir, 'page.png');
  await writeFile(imgPath, buf);
  try {
    try {
      return await runRapidOcr(imgPath);
    } catch (error) {
      if (process.env.OCR_LAYOUT_STRICT === '1') throw error;
      return await runTesseractLayout(imgPath);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runRapidOcr(imgPath) {
  if (!existsSync(PYTHON) || !existsSync(join(RUNNER_DIR, 'runner.py'))) {
    throw new Error(`RapidOCR runner not found: ${RUNNER_DIR}`);
  }
  const stdout = await new Promise((resolve, reject) => {
    const p = spawn(PYTHON, ['runner.py', '--json', imgPath], { cwd: RUNNER_DIR });
    let so = '', se = '';
    p.stdout.on('data', (d) => (so += d));
    p.stderr.on('data', (d) => (se += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(so) : reject(new Error(`runner exit ${code}: ${se.slice(-400)}`))));
  });
  // runner 可能在 JSON 前打印别的 → 取最后一行非空作 JSON
  const line = stdout.trim().split('\n').filter(Boolean).pop() || '{}';
  return JSON.parse(line);
}

async function runTesseractLayout(imgPath) {
  const lang = process.env.OCR_TESSERACT_LANG || await defaultTesseractLang();
  const tsv = await new Promise((resolve, reject) => {
    const p = spawn('tesseract', [imgPath, 'stdout', '-l', lang, '--psm', '6', 'tsv']);
    let so = '', se = '';
    p.stdout.on('data', (d) => (so += d));
    p.stderr.on('data', (d) => (se += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(so) : reject(new Error(`tesseract exit ${code}: ${se.slice(-400)}`))));
  });
  return tsvToLayout(tsv);
}

async function defaultTesseractLang() {
  try {
    const out = await new Promise((resolve, reject) => {
      const p = spawn('tesseract', ['--list-langs']);
      let so = '', se = '';
      p.stdout.on('data', (d) => (so += d));
      p.stderr.on('data', (d) => (se += d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(so + se) : reject(new Error(se))));
    });
    const langs = new Set(out.split(/\s+/).filter(Boolean));
    if (langs.has('chi_sim')) return langs.has('eng') ? 'chi_sim+eng' : 'chi_sim';
    return langs.has('eng') ? 'eng' : [...langs].find((x) => x !== 'List' && x !== 'of' && x !== 'available' && x !== 'languages') || 'eng';
  } catch {
    return 'eng';
  }
}

function tsvToLayout(tsv) {
  const lines = tsv.trim().split(/\r?\n/);
  const head = lines.shift()?.split('\t') || [];
  const idx = Object.fromEntries(head.map((name, i) => [name, i]));
  const groups = new Map();
  let pageW = 0, pageH = 0;
  for (const line of lines) {
    const cols = line.split('\t');
    const level = Number(cols[idx.level]);
    const left = Number(cols[idx.left]) || 0;
    const top = Number(cols[idx.top]) || 0;
    const width = Number(cols[idx.width]) || 0;
    const height = Number(cols[idx.height]) || 0;
    if (level === 1) { pageW = Math.max(pageW, width); pageH = Math.max(pageH, height); }
    const text = String(cols[idx.text] || '').trim();
    if (level !== 5 || !text) continue;
    const conf = Number(cols[idx.conf]);
    if (Number.isFinite(conf) && conf < 20) continue;
    const key = [cols[idx.block_num], cols[idx.par_num], cols[idx.line_num]].join(':');
    const g = groups.get(key) || { words: [], left, top, right: left + width, bottom: top + height, scores: [] };
    g.words.push(text);
    g.left = Math.min(g.left, left);
    g.top = Math.min(g.top, top);
    g.right = Math.max(g.right, left + width);
    g.bottom = Math.max(g.bottom, top + height);
    if (Number.isFinite(conf)) g.scores.push(conf / 100);
    groups.set(key, g);
  }
  const blocks = [...groups.values()].map((g) => ({
    text: g.words.join(' ').replace(/\s+([,.;:!?，。；：！？])/g, '$1'),
    box: [[g.left, g.top], [g.right, g.top], [g.right, g.bottom], [g.left, g.bottom]],
    score: g.scores.length ? g.scores.reduce((a, b) => a + b, 0) / g.scores.length : 0,
  }));
  return { blocks, width: pageW, height: pageH };
}
