/**
 * Browser smoke for the AI Pen V1 demo.
 *
 * It starts `vite preview`, opens `ai-pen-demo.html` in headless Chrome through
 * the Chrome DevTools Protocol, clicks both Education and Meeting flows, tests
 * Accept/Edit/Dismiss review gates, verifies Obsidian projection text, and
 * writes stable screenshots plus a JSON result under the repository
 * `test-results/` directory.
 *
 * Usage:
 *   npm run smoke:ai-pen-browser
 */
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

const require = createRequire(import.meta.url);
const cwd = process.cwd();
const chromeCandidates = [
  process.env.INKLOOP_BROWSER,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter((candidate): candidate is string => Boolean(candidate));

interface CdpResponse {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface RuntimeEvalResult {
  result?: { value?: unknown; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

class CdpClient {
  private nextId = 1;
  private callbacks = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      const message = JSON.parse(data) as CdpResponse;
      if (!message.id) return;
      const callback = this.callbacks.get(message.id);
      if (!callback) return;
      this.callbacks.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message || 'CDP command failed'));
      else callback.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const callback of this.callbacks.values()) callback.reject(new Error('CDP socket closed'));
      this.callbacks.clear();
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve: (value) => resolve(value as T), reject });
      this.socket.send(payload);
    });
  }

  close(): void {
    this.socket.close();
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolvePort(address.port);
        else reject(new Error('failed to allocate a local port'));
      });
    });
  });
}

async function findChrome(): Promise<string> {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next browser candidate.
    }
  }
  throw new Error('Chrome/Chromium executable not found. Set INKLOOP_BROWSER=/path/to/chrome to run browser smoke.');
}

async function waitForHttp(url: string, label: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String((error as Error)?.message || error);
    }
    await sleep(150);
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

async function connectCdp(port: number, pageUrl: string): Promise<CdpClient> {
  await waitForHttp(`http://127.0.0.1:${port}/json/version`, 'Chrome DevTools');
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' });
  assert(response.ok, `failed to open Chrome page: HTTP ${response.status}`);
  const target = await response.json() as { webSocketDebuggerUrl?: string };
  assert(target.webSocketDebuggerUrl, 'Chrome target did not expose webSocketDebuggerUrl');
  const socket = await new Promise<WebSocket>((resolveSocket, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl as string);
    ws.addEventListener('open', () => resolveSocket(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('failed to connect to Chrome DevTools socket')), { once: true });
  });
  const cdp = new CdpClient(socket);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

async function evaluate<T>(cdp: CdpClient, expression: string, awaitPromise = false): Promise<T> {
  const result = await cdp.send<RuntimeEvalResult>('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed';
    throw new Error(description);
  }
  return result.result?.value as T;
}

async function waitForExpression(cdp: CdpClient, expression: string, label: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await evaluate<boolean>(cdp, expression);
    if (value) return;
    await sleep(150);
  }
  const text = await evaluate<string>(cdp, 'document.body?.innerText?.slice(0, 1200) || ""');
  throw new Error(`${label} not reached. Page text:\n${text}`);
}

async function clickButton(cdp: CdpClient, text: string): Promise<void> {
  const clicked = await evaluate<boolean>(cdp, `
    (() => {
      const button = Array.from(document.querySelectorAll('button'))
        .find((item) => item.textContent?.trim() === ${JSON.stringify(text)});
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  assert(clicked, `button not found: ${text}`);
}

async function clickReview(cdp: CdpClient, action: 'accepted' | 'edited' | 'dismissed', index = 0): Promise<void> {
  await waitForExpression(cdp, `document.querySelectorAll('button[data-review-action="${action}"]').length > ${index}`, `review button ${action} at index ${index}`);
  const clicked = await evaluate<boolean>(cdp, `
    (() => {
      const button = document.querySelectorAll('button[data-review-action="${action}"]')[${index}];
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  if (!clicked) {
    const buttons = await evaluate<string[]>(cdp, 'Array.from(document.querySelectorAll("button")).map((button) => button.outerHTML)');
    throw new Error(`review button not found: ${action} at index ${index}\n${buttons.join('\n')}`);
  }
}

async function importRawLog(cdp: CdpClient, filename: string, text: string): Promise<void> {
  const imported = await evaluate<boolean>(cdp, `
    (() => {
      const input = document.querySelector('input[data-action="raw-log-file"]');
      if (!input) return false;
      const file = new File([${JSON.stringify(text)}], ${JSON.stringify(filename)}, { type: 'application/json' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  assert(imported, 'raw log import input not found');
}

async function pushRawLogThroughBridge(cdp: CdpClient, sourceName: string, text: string): Promise<void> {
  const result = await evaluate<{ ok?: boolean; accepted?: number; issues?: string[] }>(cdp, `
    (() => {
      const bridge = window.InkLoopRawPen;
      if (!bridge || typeof bridge.pushJsonl !== 'function') return { ok: false, accepted: 0, issues: ['InkLoopRawPen bridge missing'] };
      return bridge.pushJsonl(${JSON.stringify(text)}, ${JSON.stringify(sourceName)}, 'browser_bridge');
    })()
  `);
  assert(result.ok, `InkLoopRawPen bridge rejected fixture: ${(result.issues || []).join(' / ')}`);
  assert(result.accepted === 6, `InkLoopRawPen bridge accepted unexpected frame count: ${result.accepted}`);
}

async function applyReviewEdit(cdp: CdpClient, text: string, index = 0): Promise<void> {
  await waitForExpression(cdp, `document.querySelectorAll('textarea[data-review-edit-key]').length > ${index}`, `review edit textarea at index ${index}`);
  const applied = await evaluate<boolean>(cdp, `
    (() => {
      const textarea = document.querySelectorAll('textarea[data-review-edit-key]')[${index}];
      if (!textarea) return false;
      textarea.value = ${JSON.stringify(text)};
      const key = textarea.dataset.reviewEditKey;
      const button = Array.from(document.querySelectorAll('button[data-review-save-key]'))
        .find((item) => item.dataset.reviewSaveKey === key);
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  assert(applied, `failed to apply review edit at index ${index}`);
}

async function projectionText(cdp: CdpClient): Promise<string> {
  return evaluate<string>(cdp, 'document.querySelector(".projection pre")?.innerText || ""');
}

function assertIncludes(text: string, needle: string, label: string): void {
  assert(text.includes(needle), `${label} missing expected text: ${needle}\nProjection:\n${text}`);
}

function assertExcludes(text: string, needle: string, label: string): void {
  assert(!text.includes(needle), `${label} included forbidden text: ${needle}\nProjection:\n${text}`);
}

async function screenshot(cdp: CdpClient, path: string): Promise<void> {
  const result = await cdp.send<{ data?: string }>('Page.captureScreenshot', { format: 'png', fromSurface: true });
  assert(result.data, 'Chrome did not return screenshot data');
  await writeFile(path, Buffer.from(result.data, 'base64'));
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveStop();
    }, 1_500);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

async function removeWithRetry(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await sleep(250);
    }
  }
}

async function runRawImportScenario(cdp: CdpClient): Promise<void> {
  await clickButton(cdp, 'Education');
  const fixturePath = join(cwd, 'fixtures/ai-pen-run-sample.jsonl');
  const fixtureText = await readFile(fixturePath, 'utf8');
  await importRawLog(cdp, 'ai-pen-run-sample.jsonl', fixtureText);
  await waitForExpression(cdp, 'document.body.innerText.includes("imported 2 InkEvents from ai-pen-run-sample.jsonl") && document.querySelectorAll(".board svg path").length === 2', 'RawPenFrame import');
  await pushRawLogThroughBridge(cdp, 'InkLoopRawPen smoke', fixtureText);
  await waitForExpression(
    cdp,
    'document.body.innerText.includes("imported 2 InkEvents from InkLoopRawPen smoke (browser_bridge)") && document.body.innerText.includes("browser_bridge accepted 6 RawPenFrames") && document.querySelectorAll(".board svg path").length === 2',
    'InkLoopRawPen bridge import',
  );
  await clickButton(cdp, 'Generate AI');
  await waitForExpression(
    cdp,
    'document.body.innerText.toLowerCase().includes("lessongraph") && document.body.innerText.includes("AI Graph Job completed") && document.body.innerText.includes("SourceRefs validator passed")',
    'RawPenFrame import LessonGraph',
  );
}

async function runScenario(cdp: CdpClient, scenario: 'Education' | 'Meeting', screenshotPath: string): Promise<void> {
  await clickButton(cdp, scenario);
  await clickButton(cdp, 'Run Demo');
  await waitForExpression(cdp, 'document.querySelectorAll(".board svg path").length >= 4', `${scenario} strokes`);
  await clickButton(cdp, 'Generate AI');
  await waitForExpression(cdp, scenario === 'Education'
    ? 'document.body.innerText.toLowerCase().includes("lessongraph") && document.body.innerText.includes("AI Graph Job completed") && document.body.innerText.includes("SourceRefs validator passed")'
    : 'document.body.innerText.toLowerCase().includes("meetinggraph") && document.body.innerText.includes("AI Graph Job completed") && document.body.innerText.includes("SourceRefs validator passed")',
  `${scenario} graph output`);
  await clickReview(cdp, 'accepted', 0);
  await clickReview(cdp, 'edited', 1);
  const editedText = scenario === 'Education'
    ? 'User edit: complete the square as (x + 1)^2 and preserve stroke replay evidence.'
    : 'User edit: freeze PenFrame and InkEvent schemas before firmware integration.';
  await applyReviewEdit(cdp, editedText);
  if (scenario === 'Meeting') await clickReview(cdp, 'dismissed', 2);
  await waitForExpression(cdp, scenario === 'Education'
    ? 'document.body.innerText.includes("inkloop://doc/doc_ai_pen_lesson_demo") && document.body.innerText.includes("InkLoop/Reading") && document.body.innerText.includes("KnowledgeObject edited.")'
    : 'document.body.innerText.includes("inkloop://doc/doc_ai_pen_meeting_demo") && document.body.innerText.includes("InkLoop/Meetings") && document.body.innerText.includes("KnowledgeObject edited.") && document.body.innerText.includes("Dismissed. Not promoted to KnowledgeObject.")',
  `${scenario} Obsidian projection`);
  const projection = await projectionText(cdp);
  assertIncludes(projection, 'inkloop_projection_role: "source_file_unit"', `${scenario} source unit projection`);
  assertIncludes(projection, 'inkloop_projection_role: "knowledge_projection"', `${scenario} knowledge projection`);
  assertIncludes(projection, 'inkloop_projection_scope: "reviewed_knowledge_only"', `${scenario} projection boundary`);
  if (scenario === 'Education') {
    assertIncludes(projection, 'Identify the quadratic expression', `${scenario} accepted projection`);
    assertIncludes(projection, 'User edit: complete the square as (x + 1)^2 and preserve stroke replay evidence.', `${scenario} edited projection`);
  } else {
    await waitForExpression(
      cdp,
      'document.body.innerText.includes("Meeting Event Marks") && document.body.innerText.includes("board/ink evidence required") && document.body.innerText.includes("audio/subtitles/timeline optional context")',
      'Meeting evidence contract card',
    );
    assertIncludes(projection, 'Use the event ledger as the system source of truth.', `${scenario} accepted projection`);
    assertIncludes(projection, 'User edit: freeze PenFrame and InkEvent schemas before firmware integration.', `${scenario} edited projection`);
    assertIncludes(projection, 'audio:900-6200 Facilitator', `${scenario} optional audio context`);
    assertExcludes(projection, 'Surface glare can lower optical quality', `${scenario} dismissed projection`);
  }
  await screenshot(cdp, screenshotPath);
}

async function main(): Promise<void> {
  const browser = await findChrome();
  const previewPort = await freePort();
  const cdpPort = await freePort();
  const chromeProfile = await mkdtemp(join(tmpdir(), 'inkloop-chrome-'));
  const outputDir = resolve(process.env.INKLOOP_SMOKE_OUT_DIR || join(cwd, '../../test-results/ai-pen-browser-smoke'));
  const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  let preview: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: CdpClient | undefined;

  try {
    preview = spawn(process.execPath, [
      viteBin,
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(previewPort),
      '--strictPort',
      'true',
    ], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForHttp(`http://127.0.0.1:${previewPort}/ai-pen-demo.html`, 'Vite preview');

    chrome = spawn(browser, [
      '--headless=new',
      '--disable-background-networking',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${chromeProfile}`,
      '--window-size=1440,1000',
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const pageUrl = `http://127.0.0.1:${previewPort}/ai-pen-demo.html`;
    cdp = await connectCdp(cdpPort, pageUrl);
    await waitForExpression(cdp, 'document.readyState === "complete" && document.body.innerText.includes("InkLoop AI Pen")', 'AI Pen page load');
    await waitForExpression(cdp, [
      'Boolean(document.querySelector("[aria-label=\\"V1 launch chain status\\"]"))',
      'document.body.innerText.includes("AI Pen + Capture Surface")',
      'document.body.innerText.includes("AI Graph Job")',
      'document.body.innerText.includes("Source File Unit")',
      'document.body.innerText.includes("inkloop_document_id + inkloop://doc keep projections grouped")',
      'document.body.innerText.includes("Obsidian Projection Only")',
      'document.body.innerText.includes("Pre-Launch / Notify me")',
      'document.body.innerText.includes("prelaunch_page_not_ready")',
      'document.body.innerText.includes("Launch Ops Queue")',
      'document.body.innerText.includes("86 P0 inputs")',
      'document.body.innerText.includes("Launch Freeze Go/No-Go")',
      'document.body.innerText.includes("0/13 gates ready")',
      'document.body.innerText.includes("preview/legal/BOM/GTM/proof shots/human signoff missing")',
    ].join(' && '), 'V1 launch chain status panel');

    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    const educationScreenshot = join(outputDir, 'education-projection.png');
    const meetingScreenshot = join(outputDir, 'meeting-projection.png');
    const resultPath = join(outputDir, 'result.json');
    await runRawImportScenario(cdp);
    await runScenario(cdp, 'Education', educationScreenshot);
    await runScenario(cdp, 'Meeting', meetingScreenshot);

    const result = {
      ok: true,
      url: pageUrl,
      screenshots: {
        education: educationScreenshot,
        meeting: meetingScreenshot,
      },
      result: resultPath,
      checked: [
        'RawPenFrame JSONL import -> InkEvents -> AI Graph Job -> LessonGraph',
        'InkLoopRawPen browser/native bridge -> InkEvents -> AI Graph Job -> LessonGraph',
        'AI Graph Job queue completes before KnowledgeObject review',
        'Education Run Demo -> Generate AI -> Accept/Edit -> Obsidian projection',
        'Meeting Run Demo -> Generate AI -> Accept/Edit/Dismiss -> Obsidian projection',
        'Meeting action keeps board/ink evidence as required proof while retaining audio context only as optional context',
        'Edited review body is rendered into Obsidian projection',
        'Dismissed meeting risk is not promoted into projection',
        'SourceRefs validator visible in both scenarios',
        'V1 Launch Chain panel keeps product chain, source file unit, launch operations queue, pre-launch page, and launch-freeze Go/No-Go boundaries visible',
      ],
    };
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    cdp?.close();
    await stopProcess(chrome);
    await stopProcess(preview);
    await removeWithRetry(chromeProfile);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
