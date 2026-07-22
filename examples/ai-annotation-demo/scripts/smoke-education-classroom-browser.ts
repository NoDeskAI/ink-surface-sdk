import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createClassroomHandler } from '../server/classroom-handler';
import { ClassroomService } from '../server/classroom-service';
import { JsonClassroomStore } from '../server/classroom-store';
import { ClassroomAiService } from '../server/classroom-ai';
import { ClassroomLessonService } from '../server/classroom-lesson';
import { ClassroomMaterialService } from '../server/classroom-materials';
import { ClassroomRecognitionService } from '../server/classroom-recognition';
import { ClassroomAudioService } from '../server/classroom-audio';
import { ClassroomTranscriptionService } from '../server/classroom-transcription';
import { createClassroomStaticHandler } from '../server/classroom-static';
import { CLASSROOM_SCHEMA_VERSION, CLASSROOM_WORLD_GEOMETRY_VERSION, type ClassroomRecognitionRevision } from 'ink-surface-sdk/runtime-schema';

const chrome = process.env.INKLOOP_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const cwd = process.cwd();
const resultsPath = join(cwd, 'test-results/education-classroom-browser.json');
const latencyPath = join(cwd, 'test-results/education-classroom-latency.csv');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const server = createNetServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('port'))); }); });
}

class Browser {
  process?: ChildProcess;
  socket?: WebSocket;
  nextId = 1;
  callbacks = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  constructor(readonly name: string, readonly port: number, readonly profile: string) {}
  async start(url: string): Promise<void> {
    let ready = false;
    for (let launch = 0; launch < 2 && !ready; launch += 1) {
      this.process = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profile}`, 'about:blank'], { stdio: 'ignore' });
      for (let attempt = 0; attempt < 120; attempt += 1) { try { if ((await fetch(`http://127.0.0.1:${this.port}/json/version`)).ok) { ready = true; break; } } catch {} if (this.process.exitCode !== null) break; await sleep(100); }
      if (!ready && this.process.exitCode === null) this.process.kill('SIGTERM');
      if (!ready) await sleep(250);
    }
    if (!ready) throw new Error(`${this.name} Chrome DevTools did not start on ${this.port} (exit=${this.process?.exitCode ?? 'running'})`);
    const targetResponse = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT' });
    const target = await targetResponse.json() as { webSocketDebuggerUrl?: string }; assert(target.webSocketDebuggerUrl, `${this.name} missing CDP target`);
    this.socket = await new Promise((resolve, reject) => { const socket = new WebSocket(target.webSocketDebuggerUrl!); socket.addEventListener('open', () => resolve(socket), { once: true }); socket.addEventListener('error', () => reject(new Error('cdp')), { once: true }); });
    this.socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } }; if (!message.id) return; const callback = this.callbacks.get(message.id); if (!callback) return; this.callbacks.delete(message.id); message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result); });
    this.socket.addEventListener('close', () => { for (const callback of this.callbacks.values()) callback.reject(new Error(`${this.name} CDP socket closed`)); this.callbacks.clear(); });
    await this.send('Runtime.enable'); await this.send('Page.enable');
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `globalThis.__studentMediaCaptureCalls=0;if(navigator.mediaDevices?.getUserMedia){const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=(...args)=>{globalThis.__studentMediaCaptureCalls+=1;return original(...args)}}` });
    await this.send('Page.navigate', { url });
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.callbacks.delete(id); reject(new Error(`${this.name} CDP timeout: ${method}`)); }, 15_000);
      this.callbacks.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval<T>(expression: string, awaitPromise = false): Promise<T> { const result = await this.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(`${this.name} evaluation failed: ${JSON.stringify(result.exceptionDetails)}`); return result.result?.value as T; }
  async wait(expression: string, label: string): Promise<void> { for (let i = 0; i < 80; i += 1) { if (await this.eval(expression)) return; await sleep(100); } throw new Error(`${this.name} timeout: ${label}\n${await this.eval('document.body.innerText')}`); }
  async click(text: string): Promise<void> { const ok = await this.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent?.includes(${JSON.stringify(text)})&&!x.disabled);if(!b)return false;b.click();return true})()`); assert(ok, `${this.name} button missing: ${text}`); }
  async fill(id: string, value: string): Promise<void> { await this.eval(`(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e)return false;e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`); }
  async stop(): Promise<void> {
    this.socket?.close();
    const process = this.process;
    if (!process || process.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { process.kill('SIGKILL'); resolve(); }, 1_500);
      process.once('exit', () => { clearTimeout(timer); resolve(); });
      process.kill('SIGTERM');
    });
  }
}

async function removeWithRetry(path: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await rm(path, { recursive: true, force: true }); return; } catch (error) {
      if (attempt === 5) throw error;
      await sleep(200);
    }
  }
}

async function main(): Promise<void> {
  const stage = (message: string): void => console.log(`[education-smoke] ${message}`);
  await access(chrome, constants.X_OK);
  const previewPort = await freePort(); const origin = `http://127.0.0.1:${previewPort}`;
  const root = await mkdtemp(join(tmpdir(), 'inkloop-education-browser-')); const storeRoot = join(root, 'store');
  let store = await JsonClassroomStore.open(storeRoot);
  const classroomServices = () => {
    const service = new ClassroomService(store);
    const transcription = new ClassroomTranscriptionService(store, service, { provider: async (input) => ({
      provider: 'browser_fixture_stt', processing_mode: 'local' as const,
      segments: [{ segment_id: input.chunk_id, status: 'final' as const, relative_start_ms: input.relative_start_ms, relative_end_ms: input.relative_end_ms, text: '等式两边同时加四', confidence: 1 }],
    }) });
    const audio = new ClassroomAudioService(store, transcription);
    return {
      store, service, materials: new ClassroomMaterialService(store, service), recognition: new ClassroomRecognitionService(store), audio, transcription,
      allowOrigins: [origin], allowInsecureAudio: true,
      ai: new ClassroomAiService(store, { gateway: async (input) => ({ title: input.kind === 'practice' ? '我的练习' : input.kind === 'class_summary' ? '我的总结' : input.intent === 'missed_segment' ? '错过片段讲解' : input.intent === 'selected_region' ? '框选区域讲解' : '我的讲解', sections: [{ content: `private-${input.kind}-${input.intent}`, event_ids: [input.evidence[0].event_id] }] }) }),
      lesson: new ClassroomLessonService(store, async (evidence) => {
        const events = evidence.filter((item) => (item as { evidence_type?: string }).evidence_type === 'ink_event').slice(0, 3) as Array<{ event_id: string }>;
        return { candidates: events.map((item, index) => ({ kind: index === 2 ? 'conclusion' as const : 'derivation' as const, content: `规范步骤 ${index + 1}`, confidence: 0.9, event_ids: [item.event_id] })) };
      }),
    };
  };
  let handler = createClassroomHandler(classroomServices());
  const staticHandler = createClassroomStaticHandler(join(cwd, 'dist'));
  let api = createServer((req, res) => void handler(req, res).then((handled) => { if (!handled && !staticHandler(req, res)) { res.statusCode = 404; res.end(); } }));
  await new Promise<void>((resolve) => api.listen(previewPort, '127.0.0.1', resolve));
  for (let i = 0; i < 80; i += 1) { try { if ((await fetch(`${origin}/teacher-classroom.html`)).ok) break; } catch {} await sleep(100); }
  const profiles = await Promise.all(['teacher', 'student1', 'student2', 'student3'].map((name) => mkdtemp(join(root, `${name}-`))));
  const ports = await Promise.all(profiles.map(() => freePort()));
  const [teacher, student1, student2, student3] = profiles.map((profile, index) => new Browser(['teacher', 'student1', 'student2', 'student3'][index], ports[index], profile));
  const browsers = [teacher, student1, student2, student3];
  const apiJson = async (path: string, method: 'GET' | 'POST' | 'DELETE', token: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { origin, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  try {
    stage('opening teacher');
    await teacher.start(`${origin}/teacher-classroom.html`);
    await teacher.wait('!!document.getElementById("classroom-title")', 'teacher setup');
    await teacher.fill('classroom-title', '浏览器多设备课堂'); await teacher.click('创建课堂'); await teacher.wait('document.body.innerText.includes("开始上课")', 'created');
    const teacherSession = await teacher.eval<{ class_code: string; teacher_credential: string; classroom: { classroom_id: string } }>('JSON.parse(localStorage.getItem("inkloop.classroom.teacher.v1"))'); await teacher.click('开始上课');
    // The smoke injects trusted recognition fixtures below; decline the optional
    // auto-recognition consent so a native confirm dialog cannot block CDP.
    await teacher.eval('window.confirm=()=>false');
    await teacher.wait('(()=>{const p=document.querySelector(".page-label")?.textContent||"";const z=document.querySelector(".zoom-label")?.textContent||"";return p.includes(" / ")&&z.endsWith("%")&&Number.isFinite(Number(z.slice(0,-1)))})()', 'built-in textbook teacher view');
    stage(`class live ${teacherSession.class_code}`);
    for (const student of [student1, student2]) {
      await student.start(`${origin}/student-classroom.html`); await student.wait('!!document.getElementById("class-code")', 'join');
      await student.fill('class-code', teacherSession.class_code); await student.fill('nickname', '同名学生'); await student.click('进入课堂'); await student.wait('document.body.innerText.includes("跟随老师")', 'live');
      await student.eval('window.__latencies=[];window.__viewLatencies=[];document.querySelector(".classroom-board").addEventListener("inkloop:classroom-render",e=>window.__latencies.push(e.detail));document.querySelector(".board-frame").addEventListener("inkloop:classroom-view-render",e=>window.__viewLatencies.push(e.detail))');
    }
    stage('two students joined');
    const studentSessions = await Promise.all([student1, student2].map((student) => student.eval<{ participant_credential: string }>('JSON.parse(localStorage.getItem("inkloop.classroom.student.v1"))')));
    const initialTeacherLabels = await teacher.eval<{ page: string; zoom: string }>('({page:document.querySelector(".page-label")?.textContent||"",zoom:document.querySelector(".zoom-label")?.textContent||""})');
    const pageMatch = /^(\d+) \/ (\d+)$/.exec(initialTeacherLabels.page); const zoomMatch = /^(\d+)%$/.exec(initialTeacherLabels.zoom);
    assert(pageMatch && zoomMatch, 'teacher view labels were malformed');
    const initialPageLabel = initialTeacherLabels.page;
    await Promise.all([student1, student2].map((student) => student.wait(`document.querySelector(".page-label")?.textContent?.startsWith(${JSON.stringify(initialPageLabel)})`, 'student textbook')));
    for (const browser of [teacher, student1, student2]) {
      const layout = await browser.eval<{ frames: number; frameOverflow: string; pageOverflow: string; pageScrolls: boolean }>('(()=>{const f=document.querySelector(".textbook-frame");const p=document.querySelector(".textbook-page-layer");return{frames:document.querySelectorAll(".board-frame").length,frameOverflow:getComputedStyle(f).overflow,pageOverflow:getComputedStyle(p).overflow,pageScrolls:p.scrollWidth>p.clientWidth||p.scrollHeight>p.clientHeight}})()');
      assert(layout.frames === 1 && layout.frameOverflow === 'hidden' && layout.pageOverflow === 'visible' && !layout.pageScrolls, `${browser.name} did not use one clipped teaching viewport`);
    }
    const initialSnapshot = await store.getSnapshot(teacherSession.classroom.classroom_id);
    assert(initialSnapshot.teacher_view, 'teacher view was not durably published after students joined');
    const initialMaterial = (initialSnapshot.materials ?? []).find((item) => item.material_id === initialSnapshot.teacher_view?.material_id);
    assert(initialMaterial && initialSnapshot.teacher_view.page_index === Number(pageMatch[1]) - 1, 'student-visible teacher page did not match durable snapshot');
    await teacher.eval('document.querySelector(".board-frame").scrollIntoView({block:"center"})'); await sleep(100);
    const panFrame = await teacher.eval<{ left: number; top: number; width: number; height: number }>('(()=>{const r=document.querySelector(".board-frame").getBoundingClientRect();return{left:r.left,top:r.top,width:r.width,height:r.height}})()');
    const panX = panFrame.left + panFrame.width * 0.6; const panY = panFrame.top + panFrame.height * 0.6;
    await teacher.eval('document.querySelector(".board-frame").focus()');
    await teacher.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: panX, y: panY, button: 'middle', clickCount: 1 });
    for (let step = 1; step <= 4; step += 1) { await teacher.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panX + step * 8, y: panY + step * 3, button: 'middle', buttons: 4 }); await sleep(100); }
    await teacher.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: panX + 32, y: panY + 12, button: 'middle', clickCount: 1 });
    await student1.wait('window.__viewLatencies.some(x=>x.kind==="transient_view")&&window.__viewLatencies.some(x=>x.kind==="durable_view")', 'transient and durable teacher view render');
    const pannedSnapshot = await store.getSnapshot(teacherSession.classroom.classroom_id); assert(pannedSnapshot.teacher_view, 'panned teacher view was not durable');
    const freePageIndex = initialSnapshot.teacher_view.page_index < initialMaterial.page_count - 1 ? initialSnapshot.teacher_view.page_index + 1 : initialSnapshot.teacher_view.page_index - 1;
    assert(freePageIndex >= 0, 'demo textbook needs at least two pages for free-browse acceptance');
    await student2.click('自由浏览');
    await student2.click(freePageIndex > initialSnapshot.teacher_view.page_index ? '下一页' : '上一页');
    const freePageLabel = `${freePageIndex + 1} / ${initialMaterial.page_count}`;
    await student2.wait(`document.body.innerText.includes("自由浏览")&&document.querySelector(".page-label")?.textContent?.includes(${JSON.stringify(freePageLabel)})`, 'free browse');
    await teacher.click('＋');
    let zoomedSnapshot = await store.getSnapshot(teacherSession.classroom.classroom_id);
    for (let attempt = 0; attempt < 80 && (zoomedSnapshot.teacher_view?.revision ?? 0) <= pannedSnapshot.teacher_view.revision; attempt += 1) { await sleep(100); zoomedSnapshot = await store.getSnapshot(teacherSession.classroom.classroom_id); }
    assert(zoomedSnapshot.teacher_view && zoomedSnapshot.teacher_view.revision > pannedSnapshot.teacher_view.revision, 'teacher zoom was not durably published');
    const followingPage = `${zoomedSnapshot.teacher_view.page_index + 1} / ${initialMaterial.page_count}`;
    await student1.wait(`document.querySelector(".page-label")?.textContent?.startsWith(${JSON.stringify(followingPage)})`, 'following teacher zoom');
    assert((await student2.eval<string>('document.querySelector(".page-label")?.textContent||""')).includes(freePageLabel), 'free-browse student followed teacher unexpectedly');
    await student2.click('回到老师'); await student2.wait(`document.body.innerText.includes("跟随老师")&&document.querySelector(".page-label")?.textContent?.startsWith(${JSON.stringify(followingPage)})`, 'return to teacher');
    stage('textbook follow/free-browse/return complete');
    const draw = async (index: number) => {
      await teacher.eval('document.querySelector(".board-frame").scrollIntoView({block:"center"})');
      const teacherBoard = await teacher.eval<{ left: number; top: number; width: number; height: number }>('(()=>{const r=document.querySelector(".textbook-page-layer").getBoundingClientRect();return{left:r.left,top:r.top,width:r.width,height:r.height}})()');
      const x = teacherBoard.left + teacherBoard.width * (0.1 + index * 0.035);
      const y = teacherBoard.top + teacherBoard.height * 0.2;
      const dx = Math.min(30, teacherBoard.width * 0.025); const dy = Math.min(5, teacherBoard.height * 0.02);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await teacher.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await teacher.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx, y: y + dy, button: 'left', buttons: 1 });
        await teacher.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
        for (let wait = 0; wait < 20; wait += 1) {
          if ((await store.getSnapshot(teacherSession.classroom.classroom_id)).board_events.length >= index + 1) return;
          await sleep(50);
        }
      }
      const diagnostics = await teacher.eval(`(()=>{const f=document.querySelector('.board-frame');const p=document.elementFromPoint(${x},${y});return{live:f?.dataset.live,target:p?.tagName,targetClass:p?.getAttribute('class'),frame:f?.getBoundingClientRect().toJSON(),page:document.querySelector('.textbook-page-layer')?.getBoundingClientRect().toJSON(),body:document.body.innerText.slice(0,500)}})()`);
      throw new Error(`teacher stroke ${index + 1} was not committed: ${JSON.stringify(diagnostics)}`);
    };
    for (let i = 0; i < 5; i += 1) await draw(i);
    const firstFive = (await store.getSnapshot(teacherSession.classroom.classroom_id)).board_events;
    assert(firstFive.every((entry) => entry.geometry_version === CLASSROOM_WORLD_GEOMETRY_VERSION && 'points_world' in entry.stroke && !('points' in entry.stroke)), 'teacher committed a non-world classroom stroke');
    await teacher.click('设为全班焦点');
    for (const student of [student1, student2]) await student.wait('!!document.querySelector(".textbook-focus:not([hidden])")', 'confirmed focus');
    stage('five strokes sent');
    await student3.start(`${origin}/student-classroom.html`); await student3.wait('!!document.getElementById("class-code")', 'late join'); await student3.fill('class-code', teacherSession.class_code); await student3.fill('nickname', '晚加入'); await student3.click('进入课堂'); await student3.wait('document.querySelectorAll(".classroom-board>g:first-child path").length===5', 'late snapshot'); await student3.eval('window.__latencies=[];window.__viewLatencies=[];document.querySelector(".classroom-board").addEventListener("inkloop:classroom-render",e=>window.__latencies.push(e.detail));document.querySelector(".board-frame").addEventListener("inkloop:classroom-view-render",e=>window.__viewLatencies.push(e.detail))');
    stage('late student joined from snapshot');
    await student2.click('自由浏览');
    await student2.click(freePageIndex > zoomedSnapshot.teacher_view.page_index ? '下一页' : '上一页');
    await student2.wait(`document.body.innerText.includes("自由浏览")&&document.querySelector(".page-label")?.textContent?.startsWith(${JSON.stringify(`${freePageIndex + 1} /`)})`, 'free browse during shared strokes');
    const freeLabelDuringInk = await student2.eval<string>('document.querySelector(".page-label")?.textContent||""');
    stage('free browse remains active during shared ink');
    for (let i = 5; i < 12; i += 1) await draw(i);
    for (let attempt = 0; attempt < 80 && (await store.getSnapshot(teacherSession.classroom.classroom_id)).board_events.length < 12; attempt += 1) await sleep(100);
    assert(await student2.eval<string>('document.querySelector(".page-label")?.textContent||""') === freeLabelDuringInk, 'free-browse camera changed while shared strokes arrived');
    await student2.click('回到老师'); await student2.wait('document.body.innerText.includes("跟随老师")', 'return after shared strokes');
    const storedCount = (await store.getSnapshot(teacherSession.classroom.classroom_id)).board_events.length;
    const renderedCounts = await Promise.all([student1, student2, student3].map((student) => student.eval<number>('document.querySelectorAll(".classroom-board>g:first-child path").length')));
    stage(`late join strokes sent · stored=${storedCount} rendered=${renderedCounts.join(',')}`);
    for (const student of [student1, student2, student3]) await student.wait('document.querySelectorAll(".classroom-board>g:first-child path").length===12', 'all strokes');
    assert((await Promise.all([teacher, student1, student2, student3].map((browser) => browser.eval<number>('Number(document.querySelector(".classroom-board")?.dataset.visiblePaths||0)')))).every((count) => count <= 3_000), 'visible SVG path cap exceeded');
    const primaryPageIndex = zoomedSnapshot.teacher_view.page_index;
    const secondaryPageIndex = primaryPageIndex < initialMaterial.page_count - 1 ? primaryPageIndex + 1 : primaryPageIndex - 1;
    await teacher.click(secondaryPageIndex > primaryPageIndex ? '下一页' : '上一页');
    await teacher.wait(`document.querySelector(".page-label")?.textContent?.startsWith(${JSON.stringify(`${secondaryPageIndex + 1} /`)})`, 'teacher secondary page');
    await student1.wait(`document.querySelector(".page-label")?.textContent?.startsWith(${JSON.stringify(`${secondaryPageIndex + 1} /`)})`, 'student secondary page');
    await draw(12); await draw(13);
    for (const student of [student1, student2, student3]) await student.wait('document.querySelectorAll(".classroom-board>g:first-child path").length===2', 'secondary page strokes');
    const secondarySnapshot = await store.getSnapshot(teacherSession.classroom.classroom_id);
    const secondaryKey = `${initialMaterial.material_id}:${secondaryPageIndex}`; const primaryKey = `${initialMaterial.material_id}:${primaryPageIndex}`;
    assert(secondarySnapshot.teacher_view?.page_viewports?.[primaryKey] && secondarySnapshot.teacher_view.page_viewports[secondaryKey], 'per-page cameras were not durably retained');
    await teacher.click(primaryPageIndex < secondaryPageIndex ? '上一页' : '下一页');
    for (const browser of [teacher, student1, student2, student3]) await browser.wait(`document.querySelector(".page-label")?.textContent?.startsWith(${JSON.stringify(`${primaryPageIndex + 1} /`)})`, 'return primary page');
    for (const student of [student1, student2, student3]) await student.wait('document.querySelectorAll(".classroom-board>g:first-child path").length===12', 'primary page strokes restored');
    const allEvents = (await store.getSnapshot(teacherSession.classroom.classroom_id)).board_events;
    assert(allEvents.length === 14 && allEvents.filter((event) => event.surface?.kind === 'textbook_page' && event.surface.page_index === primaryPageIndex).length === 12 && allEvents.filter((event) => event.surface?.kind === 'textbook_page' && event.surface.page_index === secondaryPageIndex).length === 2, 'per-page ledger partition failed');
    const firstEvent = allEvents[0]; const primaryEvents = allEvents.filter((event) => event.surface?.kind === 'textbook_page' && event.surface.page_index === primaryPageIndex);
    const trustedBeforeActions: ClassroomRecognitionRevision = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: teacherSession.classroom.classroom_id, recognition_id: 'recognition_browser_stale', revision: 1,
      status: 'confirmed', kind: 'formula', text: 'x + 2 = +3', latex: 'x+2=+3', confidence: 1, provider: 'browser_fixture', processing_mode: 'local',
      event_ids: primaryEvents.map((item) => item.event.event_id), surface: firstEvent.surface ?? { kind: 'teacher_board' }, ...(firstEvent.geometry_version === 'classroom_page_world_v1' ? { spatial_region: { coordinate_space: firstEvent.geometry_version, surface: firstEvent.surface, bbox_world: firstEvent.event.bbox_world } } : { bbox_norm: firstEvent.event.bbox_norm }), created_at: new Date().toISOString(), reviewed_at: new Date().toISOString(),
    };
    await store.appendRecognitionRevision(teacherSession.classroom.classroom_id, trustedBeforeActions);
    for (const student of [student1, student2, student3]) await student.click('AI 助手');
    await student1.click('解释这一步'); await student1.wait('document.body.innerText.includes("我的讲解")', 'private current-step AI');
    await student1.wait('!!document.querySelector(".classroom-board .source-anchor")', 'world source anchor');
    await student2.click('补一下刚才的内容'); await student2.wait('document.body.innerText.includes("错过片段讲解")', 'private missed-segment AI');
    await student3.click('只解释我圈出的内容');
    await student3.eval('document.querySelector(".board-frame").scrollIntoView({block:"center"})');
    const selectionFrame = await student3.eval<{ left: number; top: number; width: number; height: number }>('(()=>{const r=document.querySelector(".textbook-page-layer").getBoundingClientRect();return{left:r.left,top:r.top,width:r.width,height:r.height}})()');
    await student3.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: selectionFrame.left + selectionFrame.width * 0.08, y: selectionFrame.top + selectionFrame.height * 0.15, button: 'left', clickCount: 1 });
    await student3.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: selectionFrame.left + selectionFrame.width * 0.75, y: selectionFrame.top + selectionFrame.height * 0.3, button: 'left', buttons: 1 });
    await student3.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: selectionFrame.left + selectionFrame.width * 0.75, y: selectionFrame.top + selectionFrame.height * 0.3, button: 'left', clickCount: 1 });
    await student3.click('解释这一步'); await student3.wait('document.body.innerText.includes("框选区域讲解")', 'private selected-region AI');
    stage('current/missed/selected actions complete');
    const capturedStrokeLatency = (await Promise.all([student1, student3].map((student) => student.eval<Array<{ event_id: string; teacher_sample_timestamp_ms: number; render_commit_timestamp_ms: number }>>('window.__latencies||[]')))).flat();
    const capturedViewLatency = await student1.eval<Array<{ kind: string; revision: number; teacher_sample_timestamp_ms: number; render_commit_timestamp_ms: number }>>('window.__viewLatencies||[]');
    const legacyTimestamp = Date.now();
    const legacyResponse = await apiJson(`/v1/classrooms/${teacherSession.classroom.classroom_id}/events`, 'POST', teacherSession.teacher_credential, {
      schema_version: CLASSROOM_SCHEMA_VERSION, client_event_id: 'legacy_browser_normalized', surface: { kind: 'textbook_page', material_id: initialMaterial.material_id, page_index: primaryPageIndex },
      event: { event_id: 'ink_legacy_browser_normalized', trace_id: 'trace_legacy_browser_normalized', surface_id: `page:${primaryPageIndex}`, pen_id: 'legacy_teacher', event_type: 'stroke', stroke_refs: ['stroke_legacy_browser_normalized'], bbox_norm: [0.68, 0.72, 0.14, 0.06], ts_start_ms: legacyTimestamp, ts_end_ms: legacyTimestamp + 20, source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 }, metadata: { mode: 'teach', tool: 'pen' } },
      stroke: { stroke_id: 'stroke_legacy_browser_normalized', surface_id: `page:${primaryPageIndex}`, pen_id: 'legacy_teacher', points: [{ x_norm: 0.68, y_norm: 0.72, t_ms: legacyTimestamp }, { x_norm: 0.82, y_norm: 0.78, t_ms: legacyTimestamp + 20 }], bbox_norm: [0.68, 0.72, 0.14, 0.06], ts_start_ms: legacyTimestamp, ts_end_ms: legacyTimestamp + 20 },
    });
    assert(legacyResponse.status === 200, `legacy normalized fixture was rejected: ${JSON.stringify(legacyResponse.body)}`);
    await store.appendRecognitionRevision(teacherSession.classroom.classroom_id, {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: teacherSession.classroom.classroom_id, recognition_id: 'recognition_legacy_browser', revision: 1,
      status: 'confirmed', kind: 'formula', text: '旧 normalized 来源', latex: 'legacy', confidence: 1, provider: 'browser_fixture', processing_mode: 'local', event_ids: ['ink_legacy_browser_normalized'],
      surface: { kind: 'textbook_page', material_id: initialMaterial.material_id, page_index: primaryPageIndex }, bbox_norm: [0.68, 0.72, 0.14, 0.06], created_at: new Date().toISOString(), reviewed_at: new Date().toISOString(),
    });
    for (const student of [student1, student2, student3]) {
      await student.eval('location.reload()');
      await student.wait('document.body.innerText.includes("继续上次课堂")', 'saved classroom prompt');
      await student.click('继续上次课堂');
      await student.wait('document.body.innerText.includes("AI 助手")', 'restored classroom');
      await student.click('AI 助手');
      await student.wait('document.body.innerText.includes("旧 normalized 来源")', 'legacy normalized recognition replay');
      const ledgerPaths = await student.eval<number>('Number(document.querySelector(".classroom-board")?.dataset.ledgerPaths||0)');
      assert(ledgerPaths === 15, `${student.name} restored ${ledgerPaths} ledger paths instead of 15`);
    }
    await student3.click('自由浏览');
    await student3.click(secondaryPageIndex > primaryPageIndex ? '下一页' : '上一页');
    await student3.wait(`document.querySelector(".page-label")?.textContent?.startsWith(${JSON.stringify(`${secondaryPageIndex + 1} /`)})`, 'legacy source pre-jump page');
    await student3.eval('[...document.querySelectorAll(".student-recognition-item")].find(x=>x.textContent.includes("旧 normalized 来源"))?.click()');
    await student3.wait(`document.querySelector(".page-label")?.textContent?.startsWith(${JSON.stringify(`${primaryPageIndex + 1} /`)})&&!!document.querySelector(".classroom-board path.source-focus")`, 'legacy source page jump and focus');
    await student3.click('回到老师');
    stage('world and legacy source navigation complete');
    const firstJobs = await apiJson(`/v1/classrooms/${teacherSession.classroom.classroom_id}/education-jobs`, 'GET', studentSessions[0].participant_credential);
    const firstJobId = String(((firstJobs.body.jobs as Array<{ job_id: string }>)[0]).job_id);
    assert((await apiJson(`/v1/classrooms/${teacherSession.classroom.classroom_id}/education-jobs/${firstJobId}`, 'GET', studentSessions[1].participant_credential)).status === 404, 'cross-participant job read was not hidden');
    const scopedSignal = await apiJson(`/v1/classrooms/${teacherSession.classroom.classroom_id}/audio/signals`, 'POST', studentSessions[1].participant_credential, { message_id: 'scope_attack', negotiation_generation: 1, participant_id: 'another_participant', type: 'answer', payload: {} });
    assert(scopedSignal.status === 400 && scopedSignal.body.error === 'audio_signal_scope_invalid', 'cross-participant signal was not rejected');
    assert((await teacher.eval<number>('globalThis.__studentMediaCaptureCalls||0')) === 0, 'teacher media instrumentation failed before capture');
    assert((await Promise.all([student1, student2, student3].map((student) => student.eval<number>('globalThis.__studentMediaCaptureCalls||0')))).every((count) => count === 0), 'student requested microphone/camera access');

    await store.appendRecognitionRevision(teacherSession.classroom.classroom_id, { ...trustedBeforeActions, revision: 2, status: 'corrected', text: 'x + 2 = ±3', latex: 'x+2=\\pm3', original_revision: 1, created_at: new Date(Date.now() + 1).toISOString() });
    const staleJobs = await apiJson(`/v1/classrooms/${teacherSession.classroom.classroom_id}/education-jobs`, 'GET', studentSessions[0].participant_credential);
    assert((staleJobs.body.jobs as Array<{ stale?: boolean }>).some((job) => job.stale === true), 'formula correction did not mark private result stale');

    api.closeIdleConnections(); api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    store = await JsonClassroomStore.open(storeRoot); handler = createClassroomHandler(classroomServices());
    api = createServer((req, res) => void handler(req, res).then((handled) => { if (!handled && !staticHandler(req, res)) { res.statusCode = 404; res.end(); } }));
    await new Promise<void>((resolve) => api.listen(previewPort, '127.0.0.1', resolve));
    for (const student of [student1, student2, student3]) await student.wait('document.body.innerText.includes("跟随老师")', 'service restart recovery');
    stage('service restart recovery and stale state complete');
    await teacher.eval('window.confirm=()=>true'); await teacher.click('结束课堂');
    for (const student of [student1, student2, student3]) await student.wait('document.querySelector(".context-status")?.textContent?.includes("已结束")', 'ended');
    await student1.click('生成完整课堂总结'); await student2.click('生成课后练习'); await student1.wait('document.body.innerText.includes("我的总结")', 'summary'); await student2.wait('document.body.innerText.includes("我的练习")', 'practice');
    stage('post-class private AI complete');
    assert(!(await student3.eval<string>('document.body.innerText')).includes('我的总结'), 'student3 leaked student1 summary');
    await teacher.wait('document.body.innerText.includes("生成课堂候选")', 'lesson UI'); await teacher.click('生成课堂候选'); await teacher.wait('document.body.innerText.includes("规范步骤 1")', 'lesson generated');
    for (let i = 0; i < 3; i += 1) { await teacher.click('接受'); await sleep(100); }
    await teacher.wait('document.body.innerText.includes("审核已完成")', 'lesson reviewed');
    await teacher.eval('location.reload()'); await teacher.wait('document.body.innerText.includes("审核已完成")', 'teacher review restored');
    stage('teacher review complete');
    const digests = await Promise.all([student1, student2, student3].map((student) => student.eval<string>('document.querySelector(".classroom-board")?.dataset.ledgerDigest||""')));
    assert(digests.every((digest) => digest === digests[0] && digest.split('|').length === 15), 'student board digests diverged');
    const strokeRows = capturedStrokeLatency.map((record, index) => ({ run_id: 'education_browser_smoke', scenario: 'browser_simulation', kind: 'world_stroke', device_id: `student_${index % 2 + 1}`, event_id: record.event_id, teacher_sample_timestamp_ms: record.teacher_sample_timestamp_ms, render_commit_timestamp_ms: record.render_commit_timestamp_ms, dropped: false }));
    const viewRows = capturedViewLatency.map((record) => ({ run_id: 'education_browser_smoke', scenario: 'browser_simulation', kind: record.kind, device_id: 'student_1', event_id: `view_r${record.revision}`, teacher_sample_timestamp_ms: record.teacher_sample_timestamp_ms, render_commit_timestamp_ms: record.render_commit_timestamp_ms, dropped: false }));
    const rows = [...strokeRows, ...viewRows];
    const audioStarted = await apiJson(`/v1/classrooms/${teacherSession.classroom.classroom_id}/audio/recording/start`, 'POST', teacherSession.teacher_credential);
    assert(audioStarted.status === 409, 'ended classroom unexpectedly allowed a new recording');
    const audioDeleted = await apiJson(`/v1/classrooms/${teacherSession.classroom.classroom_id}/audio/recording`, 'DELETE', teacherSession.teacher_credential);
    assert(audioDeleted.status === 200, 'teacher could not delete raw audio');
    assert((await store.getSnapshot(teacherSession.classroom.classroom_id)).board_events.length === 15, 'audio deletion removed classroom evidence');
    await teacher.eval('window.confirm=()=>true'); await teacher.click('删除课堂');
    for (const student of [student1, student2, student3]) await student.wait('document.body.innerText.includes("这堂课已被老师删除")', 'deleted stream');
    assert(await store.getClassroom(teacherSession.classroom.classroom_id) === null, 'classroom remained readable after deletion');
    assert(await teacher.eval('localStorage.getItem("inkloop.classroom.teacher.v1")') === null, 'teacher credential was not cleared');
    stage('classroom deletion propagated');
    await writeFile(latencyPath, `run_id,scenario,kind,device_id,event_id,teacher_sample_timestamp_ms,render_commit_timestamp_ms,dropped\n${rows.map((row) => Object.values(row).join(',')).join('\n')}\n`);
    const browserVersion = await teacher.send<{ product: string }>('Browser.getVersion');
    await writeFile(resultsPath, `${JSON.stringify({ ok: true, teacher: 1, students: 3, browser: browserVersion.product, final_sequence: 15, textbook_loaded: true, single_teaching_viewport: true, no_nested_textbook_scroll: true, world_geometry_only: true, legacy_normalized_projection: true, world_and_legacy_source_navigation: true, per_page_ledger_and_camera: true, transient_and_durable_view_rendered: true, focus_follow_free_browse_return: true, free_browse_receives_shared_ledger: true, visible_path_cap: true, digest_equal: true, late_join: true, restart_recovery: true, current_step: true, missed_segment: true, selected_region: true, whole_class_practice: true, staleness_after_correction: true, private_ai_isolated: true, cross_participant_signal_rejected: true, student_media_capture_calls: 0, teacher_review_complete: true, audio_deletion_preserved_derived_evidence: true, deletion_propagated: true, latency_records: rows.length }, null, 2)}\n`);
    console.log(`Education classroom browser smoke passed: ${resultsPath}`);
  } finally {
    await Promise.all(browsers.map((browser) => browser.stop())); await new Promise<void>((resolve) => api.close(() => resolve())); await removeWithRetry(root);
  }
}

await main();
