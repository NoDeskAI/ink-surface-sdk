import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const projectRoot = 'docs/project/inkloop-ai-pen-kickstarter';
const failures = [];
const checked = [];

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function note(message) {
  checked.push(message);
}

function fail(message) {
  failures.push(message);
}

function mustExist(relativePath, label = relativePath) {
  if (!existsSync(absolute(relativePath))) {
    fail(`missing ${label}: ${relativePath}`);
    return false;
  }
  return true;
}

function readText(relativePath) {
  return readFileSync(absolute(relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function requireIncludes(relativePath, needles) {
  if (!mustExist(relativePath)) return;
  const text = readText(relativePath);
  for (const needle of needles) {
    if (!text.includes(needle)) fail(`${relativePath} does not include required text: ${needle}`);
  }
  note(`${relativePath}: required text present`);
}

function requireNotIncludes(relativePath, needles) {
  if (!mustExist(relativePath)) return;
  const text = readText(relativePath);
  for (const needle of needles) {
    if (text.includes(needle)) fail(`${relativePath} still includes stale text: ${needle}`);
  }
  note(`${relativePath}: stale text absent`);
}

function requireNoNulBytes(relativePath) {
  if (!mustExist(relativePath)) return;
  const text = readText(relativePath);
  if (text.includes('\0')) fail(`${relativePath} contains a NUL byte and may be treated as binary by search/edit tools`);
  note(`${relativePath}: no NUL bytes`);
}

function walkMarkdownFiles(relativeDir) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(absolute(dir), { withFileTypes: true })) {
      const relativePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(relativePath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(relativePath);
      }
    }
  }
  walk(relativeDir);
  return files;
}

function verifyRelativeLinks(relativeDir) {
  const files = walkMarkdownFiles(relativeDir);
  const linkPattern = /\[[^\]]+\]\((?!https?:|mailto:|#)([^)]+)\)/g;
  for (const file of files) {
    const text = readText(file);
    let match;
    while ((match = linkPattern.exec(text))) {
      const rawTarget = match[1].split('#')[0].replace(/^<|>$/g, '');
      if (!rawTarget) continue;
      const target = path.resolve(path.dirname(absolute(file)), rawTarget);
      if (!existsSync(target)) fail(`${file} links to missing file: ${match[1]}`);
    }
  }
  note(`${files.length} project markdown files have resolvable relative links`);
}

function verifySourcePackage() {
  const sourceDir = path.join(projectRoot, 'source');
  if (!mustExist(sourceDir, 'source package directory')) return;
  const sourceFiles = readdirSync(absolute(sourceDir)).filter((file) => file.endsWith('.md'));
  for (const expected of ['00_README.md']) {
    if (!sourceFiles.includes(expected)) fail(`source package missing ${expected}`);
  }
  for (const prefix of ['01_', '02_', '03_', '04_', '05_', '06_', '07_', '08_']) {
    if (!sourceFiles.some((file) => file.startsWith(prefix))) fail(`source package missing file with prefix ${prefix}`);
  }
  if (!sourceFiles.some((file) => file.startsWith('InkLoop_AI_Pen_Kickstarter_'))) {
    fail('source package missing combined InkLoop AI Pen Kickstarter plan');
  }
  note('source strategy package files present');
}

function verifySourceMeetingBoundaries() {
  const sourceDir = path.join(projectRoot, 'source');
  requireIncludes(`${sourceDir}/01_产品战略与Kickstarter总方案.md`, [
    'InkLoop AI Pen',
    '教育',
    '商务',
    'AI Meeting Actions | 商务场景：会议纪要、决策、风险、行动项、图解 Beta',
    '商务 AI | 行动项、风险、决策、会议摘要候选',
    'Markdown 导出 | 课程讲义 / 会议纪要导出 Markdown',
  ]);
  requireIncludes(`${sourceDir}/03_各模块技术方案.md`, [
    'MeetingGraph Agent | Cloud | 会议纪要、决策、风险、行动项',
    'AI Results Queue | AI 讲义 / 纪要 / 行动项候选',
    '行动项提取 | 必须 | 必须',
    '决策 / 风险提取 | 必须 | 必须',
  ]);
  requireIncludes(`${sourceDir}/02_系统架构设计.md`, [
    '讲义 / 纪要 / 决策 / 行动项',
    '作为讲义、纪要、任务、图解知识的统一沉淀对象',
    '高质量讲义 / 纪要走云端',
  ]);
  requireIncludes(`${sourceDir}/04_AI与InkGraph数据契约.md`, [
    '讲义、纪要、行动项、图解都能反查到原始笔迹、区域、时间戳和 source_refs',
    '## 11. MeetingGraph',
    '行动项默认是 `candidate`',
  ]);
  requireIncludes(`${sourceDir}/06_Kickstarter_GTM与众筹页面方案.md`, [
    '会后自动生成讲义、会议纪要、图解和待办',
    '| 5 | Business Demo | 架构图 / 流程图 → 决策 + 行动项 |',
    '白板会议 → 行动项 / 图解',
  ]);
  requireIncludes(`${sourceDir}/07_风险_验收指标_降级方案.md`, [
    '图导出设为 Beta；先输出会议纪要 / 行动项',
    'source_refs 可追溯率',
  ]);
  requireIncludes(`${sourceDir}/08_依据与变更记录.md`, [
    '日期：2026-07-02',
    'AI 输出是讲义、纪要、决策、行动项、图解',
    'KnowledgeObject | 统一沉淀讲义、纪要、任务、图解',
    '### 决策 4：电子纸保留为第二闭环',
  ]);
  requireIncludes(`${sourceDir}/InkLoop_AI_Pen_Kickstarter_方案合集.md`, [
    'AI Meeting Actions | 商务场景：会议纪要、决策、风险、行动项、图解 Beta',
    '讲义、纪要、行动项、图解都能反查到原始笔迹、区域、时间戳和 source_refs',
    '图导出设为 Beta；先输出会议纪要 / 行动项',
    'AI 输出是讲义、纪要、决策、行动项、图解',
  ]);
}

function verifyRequiredProjectFiles() {
  for (const file of [
    `${projectRoot}/README.md`,
    `${projectRoot}/source-fact-alignment.md`,
    `${projectRoot}/implementation-alignment.md`,
    `${projectRoot}/v1-demo-handoff.md`,
    `${projectRoot}/demo-runbook.md`,
    `${projectRoot}/launch-readiness-tracker.md`,
    `${projectRoot}/readiness-audit.md`,
    `${projectRoot}/completion-audit.md`,
    `${projectRoot}/evidence/README.md`,
    `${projectRoot}/evidence/hardware-prototype-run-log.md`,
    `${projectRoot}/evidence/capture-surface-calibration-report.md`,
    `${projectRoot}/evidence/live-board-latency-report.md`,
    `${projectRoot}/evidence/education-demo-review.md`,
    `${projectRoot}/evidence/business-meeting-demo-review.md`,
    `${projectRoot}/evidence/bom-supplier-tracker.md`,
    `${projectRoot}/evidence/gtm-metrics-tracker.md`,
    `${projectRoot}/evidence/kickstarter-page-risk-checklist.md`,
    `${projectRoot}/evidence/launch-freeze-signoff.md`,
    `${projectRoot}/campaign/README.md`,
    `${projectRoot}/campaign/kickstarter-page-draft.md`,
    `${projectRoot}/campaign/campaign-video-script.md`,
    `${projectRoot}/campaign/rewards-faq-draft.md`,
    `${projectRoot}/campaign/claim-evidence-matrix.md`,
    `${projectRoot}/campaign/prelaunch-page-pack.md`,
    `${projectRoot}/campaign/launch-day-comms-pack.md`,
  ]) {
    mustExist(file);
  }
  note('project readiness, evidence, and campaign files present');
}

function verifyV1DemoHandoff() {
  requireIncludes(`${projectRoot}/README.md`, [
    'Use [v1-demo-handoff.md](./v1-demo-handoff.md) for the narrow V1 loop demo',
    'Web import -> InkLoop Paper reading/marking -> Obsidian knowledge projection',
    'without opening the full Kickstarter operations board',
  ]);
  requireIncludes(`${projectRoot}/v1-demo-handoff.md`, [
    'InkLoop V1 Demo Handoff',
    'Web import',
    '-> InkLoop Paper reading and marking',
    '-> Obsidian knowledge projection',
    'The V1 demo should prove these three user-visible jobs',
    'Web / desktop',
    'InkLoop Paper / Android',
    'Obsidian',
    'window.InkLoopFiles',
    'window.InkLoopLanImport',
    'window.InkLoopRuntime.getManifest()',
    'Web import -> Paper reading/marking -> Obsidian projection',
    'Reading notes, highlights, tasks, decisions, risks, and diagrams',
    'inkloop://doc/...',
    'release_path_used=false',
    'Use these for the V1 demo loop only',
    'npm run verify:local-demo-handoff',
    'The demo is a product-chain proof',
  ]);
  requireNotIncludes(`${projectRoot}/v1-demo-handoff.md`, [
    '86 P0 inputs',
    'ops_refresh_launch_not_ready',
    'launch_freeze_not_ready',
    '0/13 gates ready',
  ]);
  requireIncludes('scripts/build-demo-evidence-bundle.mjs', [
    "artifact('docs/project/inkloop-ai-pen-kickstarter/v1-demo-handoff.md', 'V1 demo handoff')",
  ]);
}

function verifyCampaignMeetingBoundaries() {
  requireIncludes('scripts/verify-kickstarter-campaign-claims.mjs', [
    'meeting summaries as public output wording',
    'automatic meeting minutes from audio or transcript',
    'Does it generate automatic meeting minutes from audio?',
    'For meetings, board/ink events are the required evidence path.',
    'V1 meeting outputs are board-event-first.',
    'Audio, subtitles, speaker, agenda, and timeline data may be optional context',
    'Audio/subtitles/timeline may be optional context only.',
    'Automatic meeting minutes from audio or subtitles.',
  ]);
  requireIncludes(`${projectRoot}/campaign/kickstarter-page-draft.md`, [
    'For meetings, board/ink events are the required evidence path.',
    'should not be presented as automatic meeting minutes.',
  ]);
  requireNotIncludes(`${projectRoot}/campaign/kickstarter-page-draft.md`, [
    'meeting summaries',
  ]);
  requireIncludes(`${projectRoot}/campaign/rewards-faq-draft.md`, [
    'Does it generate automatic meeting minutes from audio?',
    'V1 meeting outputs are board-event-first.',
    'Audio, subtitles, speaker, agenda, and timeline data may be optional context',
  ]);
  requireNotIncludes(`${projectRoot}/campaign/rewards-faq-draft.md`, [
    'meeting summaries',
  ]);
  requireIncludes(`${projectRoot}/campaign/claim-evidence-matrix.md`, [
    'Audio/subtitles/timeline may be optional context only.',
    'Automatic meeting minutes from audio or subtitles.',
  ]);
}

function verifyCodeMeetingBoundaries() {
  requireIncludes('examples/ai-annotation-demo/src/integration/inksurface/meeting-export.ts', [
    '会议 source-unit 投影 + 旁注手写',
    '这条导出不是音频自动整理主链路',
    'V1 提升为可信 KnowledgeObject 仍需要板书/墨迹事件证据',
    '会议输出候选（summary）',
  ]);
  requireNotIncludes('examples/ai-annotation-demo/src/integration/inksurface/meeting-export.ts', [
    '会议纪要文档',
    '会议总结',
  ]);
  requireIncludes('examples/ai-annotation-demo/src/integration/inksurface/meeting-export.test.ts', [
    '会议输出候选 -> 一条 summary KO',
  ]);
  requireNotIncludes('examples/ai-annotation-demo/src/integration/inksurface/meeting-export.test.ts', [
    '会议总结',
  ]);
  requireIncludes('examples/ai-annotation-demo/src/mobile/meeting.ts', [
    '场会议输出已同步',
  ]);
  requireIncludes('examples/ai-annotation-demo/src/mobile/meeting-recap.ts', [
    '飞书中枢还没有会议事件记录',
  ]);
  requireNotIncludes('examples/ai-annotation-demo/src/mobile/meeting.ts', [
    '会议总结',
  ]);
}

function verifyLaunchEvidenceMeetingBoundaries() {
  for (const file of [
    'scripts/build-launch-action-plan.mjs',
    'scripts/build-kickstarter-weekly-sprint.mjs',
    'scripts/create-launch-evidence-intake.mjs',
    'scripts/audit-launch-evidence.mjs',
    'scripts/create-kickstarter-proof-shot-intake.mjs',
    `${projectRoot}/evidence/business-meeting-demo-review.md`,
    `${projectRoot}/evidence/README.md`,
    'examples/ai-annotation-demo/fixtures/demo-review-sample.csv',
  ]) {
    requireNotIncludes(file, [
      'Exported meeting note',
      'exported meeting note',
      'meeting_note',
    ]);
  }
  requireIncludes('scripts/build-launch-action-plan.mjs', [
    'exported meeting output, reviewer CSV, analyzer report, and board-mark evidence',
  ]);
  requireIncludes('scripts/build-kickstarter-weekly-sprint.mjs', [
    'Exported meeting output',
  ]);
  requireIncludes('scripts/create-launch-evidence-intake.mjs', [
    'Exported meeting output path',
  ]);
  requireIncludes('scripts/audit-launch-evidence.mjs', [
    'exported meeting output',
    'Exported meeting output path',
  ]);
  requireIncludes('scripts/create-kickstarter-proof-shot-intake.mjs', [
    'exported lesson note or meeting output',
  ]);
  requireIncludes(`${projectRoot}/evidence/business-meeting-demo-review.md`, [
    'Exported meeting output path',
    '`meeting_output` or `none`',
  ]);
  requireIncludes(`${projectRoot}/evidence/README.md`, [
    '`lesson_note`, `meeting_output`, or `none`',
  ]);
  requireIncludes('examples/ai-annotation-demo/fixtures/demo-review-sample.csv', [
    'meeting_output',
  ]);
}

function verifyEntrypointBoundaries() {
  requireIncludes('AGENTS.md', [
    'InkLoop AI Pen Kickstarter V1 system workspace',
    'AI Pen + Capture Surface + Web/Desktop Host + Live Board + InkLoop Studio',
    'Keep Android/e-paper positioned as InkLoop Paper runtime reuse',
    'Treat `docs/project/inkloop-ai-pen-kickstarter/source/` as the unique current source package',
  ]);
  requireIncludes('README.md', [
    'InkLoop AI Pen Runtime',
    'InkLoop AI Pen Kickstarter V1',
    'The e-paper product line remains InkLoop Paper',
    'Obsidian receives accepted/edited knowledge projections',
    'grouped by source file/session units',
    'Current V1 Status',
    'local_demo_ready',
    'browser.ok=true',
    '86 P0 inputs',
    'ops_refresh_launch_not_ready',
    'prelaunch_page_not_ready',
    'launch_freeze_not_ready',
    'the October 2026 Kickstarter launch still requires real hardware logs',
  ]);
  requireIncludes('docs/architecture.md', [
    'AI Pen Kickstarter V1 Architecture',
    'Current Launch Boundary',
    'local_demo_ready',
    'browser.ok=true',
    '86 P0 inputs',
    'prelaunch_page_not_ready',
    'launch_freeze_not_ready',
    '0/13 gates ready',
    'not Kickstarter launch-ready',
    'RawPenFrame / fixture or hardware log',
    'Stroke -> InkEvent ledger',
    'BoardGraph / InkGraph',
    'AI Graph Job',
    'User accept / edit / dismiss',
    'PDF / Native Document reading input',
    'buildLessonGraphKnowledgeObjects',
    'buildMeetingGraphKnowledgeObjects',
    'not the Kickstarter V1 source-of-truth path',
    'Reading / PDF Validation Surface',
    'outside the October 2026 Kickstarter base hardware promise',
    'Knowledge Export Contracts',
    'Obsidian Projection Adapter',
    'visible Obsidian Markdown files are clean knowledge projections',
    'grouped by source file/session units',
    'inkloop_projection_role',
    'The Obsidian V1 plugin can host runtime sidecar state and push/pull explicit runtime events',
    'not reverse-parsed into InkLoop facts',
    'The October 2026 Kickstarter base tier does not promise a full e-paper tablet',
  ]);
  requireIncludes(`${projectRoot}/README.md`, [
    'AI Pen + Capture Surface + Host App + Live Board + InkLoop Studio',
    'education board teaching',
    'business whiteboard meetings',
    'The latest strategy package is preserved',
    'source-fact-alignment.md',
    'Current Operating Snapshot',
    'local_demo_ready',
    'browser.ok=true',
    '86 P0 inputs',
    'ops_refresh_launch_not_ready',
    'prelaunch_page_not_ready',
    'launch_freeze_not_ready',
    '0/13 gates ready',
    'Kickstarter launch freeze pack',
    'Kickstarter launch signoff audit',
    'Kickstarter launch-day command center',
    'Kickstarter pre-launch page pack',
    'launch-day comms pack',
  ]);
  requireIncludes(`${projectRoot}/source-fact-alignment.md`, [
    'InkLoop AI Pen Source Fact Alignment',
    'Treat [`source/`](./source/) as the unique current factual basis',
    '00_README.md',
    '01_产品战略与Kickstarter总方案.md',
    '02_系统架构设计.md',
    '03_各模块技术方案.md',
    '04_AI与InkGraph数据契约.md',
    '05_目标与里程碑_10月底Kickstarter倒排.md',
    '06_Kickstarter_GTM与众筹页面方案.md',
    '07_风险_验收指标_降级方案.md',
    '08_依据与变更记录.md',
    'InkLoop_AI_Pen_Kickstarter_方案合集.md',
    'RawPenFrame -> Stroke -> InkEvent -> HMP / Evidence Builder -> BoardObject -> BoardGraph / InkGraph -> LessonGraph or MeetingGraph -> KnowledgeObject',
    'Meeting audio, subtitles, agenda, speaker, and timeline data are optional context only',
    'Android / InkLoop Paper',
    'Launch Ops Queue: 86 P0 inputs',
    'Obsidian receives reviewed KnowledgeObject projections',
    'plugin settings boundary panel with `Launch Ops Queue: 86 P0 inputs`',
    'local_demo_ready',
    'browser.ok=true',
    'ops_refresh_launch_not_ready',
    'prelaunch_page_not_ready',
    'launch_freeze_not_ready',
    '0/13 gates ready',
    'not Kickstarter launch-ready until the evidence records contain real prototype logs',
    'launch-day command center',
    'launch-day comms pack',
    'supplier quote intake script',
    'supplier quote audit script',
    'npm run kickstarter:supplier-quote-audit',
    'page review intake script',
    'page review audit script',
    'npm run kickstarter:page-review-audit',
    'launch signoff audit script',
    'npm run kickstarter:launch-signoff-audit',
    'pre-launch page pack',
    'npm run kickstarter:launch-day-command-center',
    'npm run kickstarter:prelaunch-page-pack',
  ]);
  requireIncludes('examples/ai-annotation-demo/README.md', [
    'InkLoop AI Pen Kickstarter V1',
    'AI Pen + Capture Surface + Live Board + InkGraph + Education/Meeting outputs',
  ]);
  requireIncludes('packages/adapter-obsidian/README.md', [
    'Obsidian is intentionally a projection surface in V1',
    'source file unit',
    'inkloop_projection_role: "source_file_unit"',
    'are not reverse-parsed into canonical AI Pen `InkEvent`, `KnowledgeObject`, `LessonGraph`, or `MeetingGraph` records',
    'visible Markdown edits remain local projection edits',
  ]);
  requireIncludes('packages/knowledge-schema/README.md', [
    'InkLoop AI Pen V1 product chain',
    'LessonGraph / MeetingGraph',
    'KnowledgeObject',
  ]);
  requireIncludes('packages/export-core/README.md', [
    'InkLoop AI Pen V1 system',
    'separate from Runtime Sync',
  ]);
  requireIncludes('packages/runtime-schema/README.md', [
    'AI Pen V1 records',
    'RawPenFrame',
    'AiGraphJob',
    'LessonGraph',
    'MeetingGraph',
  ]);
  requireIncludes('native/android/README.md', [
    'Android/e-paper is not the base delivery promise',
    'AI Pen + Capture Surface + Web/Desktop Capture Host',
    'window.InkLoopRuntime.getManifest()',
    'Web import -> Paper reading/marking -> Obsidian projection',
    'local-first',
    'Android reader UI stays clean',
    'window.InkLoopM103RawPenCapture',
    'hqunifiedsocket',
  ]);
  requireNotIncludes('docs/architecture.md', [
    'examples/ai-annotation-demo/src/adapters/obsidian-fs/',
    'examples/ai-annotation-demo/src/adapters/core/',
    'examples/ai-annotation-demo/src/runtime/',
    'PDF["PDF / Native Document"] --> WEB["InkLoop Web App"]',
    'WEB --> KB["KnowledgeBuilder"]',
    'WEB --> DPB["DocumentProjectionBuilder"]',
    'examples/ai-annotation-demo/src/knowledge-builder/',
    '`KnowledgeBuilder` still lives in the demo app',
    '`DocumentProjectionBuilder` turns document text/reflow/OCR-like data into full document projections',
    '### Local Store and Original Web Demo',
    'Obsidian FS Adapter',
    'ExternalEdit',
    'Pull External Changes',
    'Pull external edits back',
    'Obsidian text edits | Obsidian/User | Pulled back',
    'bidirectional sync flow',
  ]);
  requireNotIncludes('packages/adapter-obsidian/README.md', [
    'bidirectional Obsidian convergence',
  ]);
  requireIncludes('examples/ai-annotation-demo/src/knowledge/builder.ts', [
    '旧阅读投影 builder',
    '不是 AI Pen Kickstarter V1 的 source-of-truth',
    'V1 LessonGraph / MeetingGraph 的知识沉淀走 packages/knowledge-schema',
  ]);
  requireNotIncludes('examples/ai-annotation-demo/src/knowledge/builder.ts', ['KnowledgeBuilder']);
  requireNoNulBytes('examples/ai-annotation-demo/src/knowledge/builder.ts');
  requireNotIncludes('examples/ai-annotation-demo/src/knowledge/knowledge-object.ts', ['KnowledgeBuilder']);
  requireNotIncludes('examples/ai-annotation-demo/src/local/store.ts', ['KnowledgeBuilder']);
  requireNotIncludes('examples/ai-annotation-demo/src/knowledge/builder.test.ts', ['KnowledgeBuilder']);
}

function verifyLegacyProjectBoundary() {
  requireIncludes('docs/project/inkloop-eink/README.md', [
    'Legacy boundary: use this directory only for InkLoop Paper or historical reference',
    'It is not the factual basis for October 2026 Kickstarter commitments',
  ]);
  requireIncludes('docs/documentation-structure-summary.md', [
    'current 2026-10 launch source of truth',
    'historical/local-first knowledge base for the e-paper effort and second product loop',
    'The AI Pen Kickstarter source package under `project/inkloop-ai-pen-kickstarter/source/` is the unique current factual basis for launch scope',
    'must not be used to expand, weaken, or contradict the October 2026 AI Pen Kickstarter commitments',
  ]);
  for (const file of walkMarkdownFiles(projectRoot).filter((file) => !file.startsWith(`${projectRoot}/source/`))) {
    const text = readText(file);
    for (const staleNeedle of ['低成本墨水屏', '市售低成本墨水屏', '第一版 MVP', '7 月中旬', '飞书会议时间轴 SDK']) {
      if (text.includes(staleNeedle)) fail(`${file} carries legacy e-paper launch wording outside source package: ${staleNeedle}`);
    }
  }
  note('legacy e-paper project boundary is explicit and absent from active AI Pen launch docs');
}

function verifyEvidenceAnalyzers() {
  for (const [script, fixture] of [
    ['analyze-ai-pen-run.ts', 'ai-pen-run-sample.jsonl'],
    ['analyze-capture-surface-calibration.ts', 'capture-surface-calibration-sample.csv'],
    ['analyze-live-board-latency.ts', 'live-board-latency-sample.csv'],
    ['analyze-reward-pricing.ts', 'reward-pricing-sample.csv'],
    ['analyze-gtm-metrics.ts', 'gtm-metrics-sample.csv'],
    ['analyze-demo-review.ts', 'demo-review-sample.csv'],
  ]) {
    mustExist(`examples/ai-annotation-demo/scripts/${script}`);
    mustExist(`examples/ai-annotation-demo/fixtures/${fixture}`);
  }
  mustExist('examples/ai-annotation-demo/scripts/verify-android-paper-assets.mjs');
  requireIncludes('examples/ai-annotation-demo/scripts/verify-android-paper-assets.mjs', [
    'InkLoopRuntimeBridge.kt',
    'InkLoopRuntimeBridge.attach(webView)',
    'InkLoopLanImportBridge.kt',
    'InkLoopLanImportBridge.attach(webView, this)',
    'InkLoopLanImport',
    'Wi-Fi 收件箱',
    'm103-raw-pen-adapter.ts',
    'publishM103RawPenStroke',
    'InkLoopM103RawPenCapture',
    'm103_hqunifiedsocket',
    'runtime-boundary',
    'inkloop.android_runtime_manifest.v1',
    'Web import -> Paper reading/marking -> Obsidian projection',
    'local-first',
    '#runtime-boundary[hidden]',
  ]);
  mustExist('scripts/verify-obsidian-v1-plugin.mjs');
  requireIncludes('scripts/verify-obsidian-v1-plugin.mjs', [
    'verifyInstallerSmoke',
    'inkloop-obsidian-vault-',
    'Obsidian installer smoke installed plugin, SDK bundle, enabled plugin, and V1 runtime settings into a temp vault',
    'did not clear a legacy syncEndpoint',
    'InkLoop AI Pen V1 boundary',
    'Obsidian receives accepted/edited KnowledgeObject projections only',
    'Meeting actions, decisions, risks, and diagrams require board/ink evidence',
    'audio, subtitles, agenda, speaker, and timeline data are optional context only',
    'Meeting Event Marks',
    'board/ink evidence required; audio/subtitles/timeline optional context',
    'Source unit',
    'Reading documents and meeting sessions stay grouped by inkloop://doc/...',
    'Pre-Launch / Notify me',
    'prelaunch_page_not_ready',
    'preview URL/live URL/owner review/GTM proof missing',
    'Launch Ops Queue',
    '86 P0 inputs',
    'Launch Freeze Go/No-Go',
    '0/13 gates ready',
    'preview/legal/BOM/GTM/proof shots/human signoff missing',
    '.inkloop-v1-boundary-card',
  ]);
  mustExist('scripts/verify-kickstarter-campaign-claims.mjs');
  mustExist('scripts/run-ai-pen-demo.mjs');
  mustExist('scripts/create-launch-evidence-intake.mjs');
  requireIncludes('scripts/create-launch-evidence-intake.mjs', [
    'inkloop.launch_evidence_intake.v1',
    'test-results/ai-pen-launch-evidence-intake',
    'This intake package is not launch evidence by itself.',
    '01-hardware-prototypes',
    '04-education-demo-review',
    '05-business-meeting-demo-review',
    '08-kickstarter-page-review',
    'evidence:ai-pen-run',
    'evidence:demo-review',
    'evidence:reward-pricing',
    'evidence:gtm-metrics',
    'npm run launch:evidence:audit',
  ]);
  mustExist('scripts/audit-launch-evidence-intake.mjs');
  requireIncludes('scripts/audit-launch-evidence-intake.mjs', [
    'inkloop.launch_evidence_intake_audit.v1',
    'test-results/ai-pen-launch-evidence-intake-audit',
    'ready_for_evidence_record_update',
    'intake_not_ready',
    'non_template_raw_files',
    'non_template_artifact_files',
    'Strict launch evidence intake audit failed',
    'Template files and fixture rows are intentionally ignored as launch proof',
  ]);
  mustExist('scripts/build-launch-evidence-record-update-plan.mjs');
  requireIncludes('scripts/build-launch-evidence-record-update-plan.mjs', [
    'inkloop.launch_evidence_record_update_plan.v1',
    'test-results/ai-pen-launch-evidence-record-update-plan',
    'no_ready_evidence_records',
    'ready_to_update_record',
    'blocked_do_not_update_record',
    'npm run launch:evidence:record-update-plan',
    'This plan is not launch approval',
  ]);
  mustExist('scripts/apply-launch-evidence-record-updates.mjs');
  requireIncludes('scripts/apply-launch-evidence-record-updates.mjs', [
    'inkloop.launch_evidence_record_apply.v1',
    'test-results/ai-pen-launch-evidence-record-apply',
    'no_ready_records_to_apply',
    'dry_run_ready_records',
    'record_updates_applied',
    'npm run launch:evidence:apply-record-updates',
    'npm run launch:evidence:apply-record-updates:write',
    'This apply report is not launch approval',
    'human decision must be written manually',
  ]);
  mustExist('scripts/build-launch-operator-pack.mjs');
  requireIncludes('scripts/build-launch-operator-pack.mjs', [
    'inkloop.launch_operator_pack.v1',
    'test-results/ai-pen-launch-operator-pack',
    'operator_pack_field_capture_ready_launch_not_ready',
    'operator_pack_prelaunch_not_ready',
    'operator_pack_launch_evidence_ready',
    'prelaunch_page_ready',
    'First 48 Hours Capture Queue',
    'field_work_orders',
    'Field Work Orders',
    'All Launch Gate Field Work Orders',
    'Gate field work orders',
    'action_item_count',
    'prelaunchPagePack',
    'Pre-Launch / Notify me Work Order',
    'prelaunch_work_order',
    'prelaunch_page_not_ready',
    'Pre-launch fields ready',
    'npm run kickstarter:prelaunch-page-pack',
    'Preflight',
    'After Capture',
    'Required Artifacts',
    'Decision row remains manual',
    'G-SUPPLY-1',
    'G-GTM-1',
    'G-PAGE-1',
    'source_milestone',
    'Evidence Record Writeback Guard',
    'Proof-Shot Capture Queue',
    'npm run launch:operator-pack',
    'launch evidence or Pre-Launch / Notify me work order is not ready',
    'This operator pack is not launch approval',
  ]);
  mustExist('scripts/build-launch-action-plan.mjs');
  requireIncludes('scripts/build-launch-action-plan.mjs', [
    'inkloop.launch_action_plan.v1',
    'test-results/ai-pen-launch-action-plan',
    'converts the latest launch evidence audit into an execution queue',
    'G-HW-1',
    'G-SURF-1',
    'G-EDU-1',
    'G-MTG-1',
    'G-SUPPLY-1',
    'G-GTM-1',
    'G-PAGE-1',
    '2026-10-20 page, price, risk freeze',
    'npm run launch:evidence:intake',
    'npm run launch:evidence:intake-audit',
    'npm run launch:evidence:audit',
  ]);
  mustExist('scripts/build-kickstarter-critical-path.mjs');
  requireIncludes('scripts/build-kickstarter-critical-path.mjs', [
    'inkloop.kickstarter_critical_path.v1',
    'test-results/ai-pen-kickstarter-critical-path',
    'critical_path_at_risk',
    '2026-10-27',
    '2026-10-30',
    'Strict Kickstarter critical path failed',
    'This report is a countdown and risk view only',
  ]);
  mustExist('scripts/build-kickstarter-weekly-sprint.mjs');
  requireIncludes('scripts/build-kickstarter-weekly-sprint.mjs', [
    'inkloop.kickstarter_weekly_sprint.v1',
    'test-results/ai-pen-kickstarter-weekly-sprint',
    'sprint_has_at_risk_work',
    'current_intake_dir',
    'expected_input',
    'runnable_analyzer_command',
    'First 48 Hours Capture Plan',
    'Current Intake Targets',
    'Evidence To Collect',
    'npm run launch:weekly-sprint',
    'Strict Kickstarter weekly sprint failed',
    'This sprint package is an execution queue, not launch approval',
  ]);
  mustExist('scripts/build-launch-kpi-dashboard.mjs');
  requireIncludes('scripts/build-launch-kpi-dashboard.mjs', [
    'inkloop.launch_kpi_dashboard.v1',
    'test-results/ai-pen-launch-kpi-dashboard',
    'launch_kpis_not_ready',
    'Weekly KPI Board',
    'npm run launch:kpi-dashboard',
    'Strict launch KPI dashboard failed',
    'This KPI dashboard is a weekly management view, not launch approval',
  ]);
  mustExist('scripts/build-kickstarter-claim-downgrade-pack.mjs');
  requireIncludes('scripts/build-kickstarter-claim-downgrade-pack.mjs', [
    'inkloop.kickstarter_claim_downgrade.v1',
    'test-results/ai-pen-kickstarter-claim-downgrade',
    'claims_require_downgrade',
    'Public Copy Decisions',
    'npm run kickstarter:claim-downgrade',
    'Strict Kickstarter claim downgrade failed',
    'This downgrade pack is not publish approval',
  ]);
  mustExist('scripts/build-kickstarter-public-copy-lock.mjs');
  requireIncludes('scripts/build-kickstarter-public-copy-lock.mjs', [
    'inkloop.kickstarter_public_copy_lock.v1',
    'test-results/ai-pen-kickstarter-public-copy-lock',
    'public_copy_lock_not_ready',
    'public_copy_lock_ready',
    'Copy Decisions',
    'Blocked Public Claims',
    'Proof-Shot Lock',
    'prelaunchPagePack',
    'Pre-launch page pack',
    'launchDayCommsPack',
    'Launch-day comms pack',
    'launch emails, social posts, and comment replies',
    'npm run kickstarter:public-copy-lock',
    'This public copy lock is not publish approval',
  ]);
  mustExist('scripts/create-kickstarter-supplier-quote-intake.mjs');
  requireIncludes('scripts/create-kickstarter-supplier-quote-intake.mjs', [
    'inkloop.kickstarter_supplier_quote_intake.v1',
    'test-results/ai-pen-kickstarter-supplier-quote-intake',
    'Supplier quote intake is not reward pricing approval',
    'raw/bom.csv',
    'raw/supplier-quotes.csv',
    'reviews/supply-review.md',
    'evidence:reward-pricing',
    'npm run kickstarter:supplier-quote-audit',
  ]);
  mustExist('scripts/audit-kickstarter-supplier-quotes.mjs');
  requireIncludes('scripts/audit-kickstarter-supplier-quotes.mjs', [
    'inkloop.kickstarter_supplier_quote_audit.v1',
    'test-results/ai-pen-kickstarter-supplier-quote-audit',
    'supplier_quotes_not_ready',
    'supplier_quotes_ready',
    'supplier_backed_for_public_page',
    'confirmed_quote_coverage_ge_80',
    'next_required_inputs',
    'Next Required Inputs',
    'bom_component',
    'supplier_quote',
    'human_supply_review',
    'Strict Kickstarter supplier quote audit failed',
  ]);
  mustExist('scripts/create-kickstarter-page-review-intake.mjs');
  requireIncludes('scripts/create-kickstarter-page-review-intake.mjs', [
    'inkloop.kickstarter_page_review_intake.v1',
    'test-results/ai-pen-kickstarter-page-review-intake',
    'raw/page-review-fields.csv',
    'raw/page-section-review.csv',
    'raw/legal-privacy-review.csv',
    'Kickstarter page review intake is not publish approval',
    'npm run kickstarter:page-review-audit',
  ]);
  mustExist('scripts/audit-kickstarter-page-review.mjs');
  requireIncludes('scripts/audit-kickstarter-page-review.mjs', [
    'inkloop.kickstarter_page_review_audit.v1',
    'test-results/ai-pen-kickstarter-page-review-audit',
    'page_review_not_ready',
    'page_review_ready',
    'Legal/privacy checks',
    'next_required_inputs',
    'Next Required Inputs',
    'review_field',
    'page_section',
    'legal_privacy_check',
    'Strict Kickstarter page review audit failed',
  ]);
  mustExist('scripts/audit-kickstarter-launch-signoff.mjs');
  requireIncludes('scripts/audit-kickstarter-launch-signoff.mjs', [
    'inkloop.kickstarter_launch_signoff_audit.v1',
    'test-results/ai-pen-kickstarter-launch-signoff-audit',
    'launch_signoff_not_ready',
    'launch_signoff_ready',
    'Manual launch operator',
    'Launch room coverage',
    'next_required_inputs',
    'Next Required Inputs',
    'launch_day_readiness',
    'gate_decisions_ready',
    'Strict Kickstarter launch signoff audit failed',
  ]);
  mustExist('scripts/build-kickstarter-prelaunch-page-pack.mjs');
  requireIncludes('scripts/build-kickstarter-prelaunch-page-pack.mjs', [
    'inkloop.kickstarter_prelaunch_page_pack.v1',
    'test-results/ai-pen-kickstarter-prelaunch-page',
    'prelaunch_page_not_ready',
    'prelaunch_page_ready',
    'prelaunchPageIntakeAudit',
    'prelaunch_intake_ready',
    'Pre-launch intake audit status',
    'next_required_inputs',
    'Next Required Inputs',
    'preview URL and capture the matching preview screenshot or preview-page artifact',
    'gtm_proof',
    'npm run kickstarter:prelaunch-page-intake',
    'npm run kickstarter:prelaunch-page-intake-audit',
    'Notify me followers must be backed by real Kickstarter dashboard exports',
    'npm run kickstarter:prelaunch-page-pack',
    'Strict Kickstarter pre-launch page pack failed',
  ]);
  mustExist('scripts/create-kickstarter-prelaunch-page-intake.mjs');
  requireIncludes('scripts/create-kickstarter-prelaunch-page-intake.mjs', [
    'inkloop.kickstarter_prelaunch_page_intake.v1',
    'test-results/ai-pen-kickstarter-prelaunch-page-intake',
    'Kickstarter pre-launch page intake is not publish approval',
    'raw/page-fields.csv',
    'raw/notify-me-tracking.csv',
    'raw/owner-review.csv',
    'reviews/founder-review.md',
    'npm run kickstarter:prelaunch-page-intake-audit',
    'Template rows with TBD are intentionally rejected',
  ]);
  mustExist('scripts/audit-kickstarter-prelaunch-page-intake.mjs');
  requireIncludes('scripts/audit-kickstarter-prelaunch-page-intake.mjs', [
    'inkloop.kickstarter_prelaunch_page_intake_audit.v1',
    'test-results/ai-pen-kickstarter-prelaunch-page-intake-audit',
    'prelaunch_intake_not_ready',
    'prelaunch_intake_ready',
    'Notify me tracking',
    'Strict Kickstarter pre-launch page intake audit failed',
    'Template rows with TBD are expected to fail',
  ]);
  mustExist('scripts/build-kickstarter-risk-register.mjs');
  requireIncludes('scripts/build-kickstarter-risk-register.mjs', [
    'inkloop.kickstarter_risk_register.v1',
    'test-results/ai-pen-kickstarter-risk-register',
    'test-results/ai-pen-kickstarter-public-copy-lock',
    'risk_register_has_open_p0',
    'public_copy_lock_not_ready',
    'public_copy_lock_status',
    'Public copy lock status',
    'Weekly Risk Board',
    'P0 Response',
    'npm run kickstarter:public-copy-lock',
    'npm run kickstarter:risk-register',
    'Strict Kickstarter risk register failed',
    'This risk register is not launch approval',
  ]);
  mustExist('scripts/run-kickstarter-ops-refresh.mjs');
  requireIncludes('scripts/run-kickstarter-ops-refresh.mjs', [
    'inkloop.kickstarter_ops_refresh.v1',
    'test-results/ai-pen-kickstarter-ops-refresh',
    'launch:evidence:record-update-plan',
    'launch:evidence:apply-record-updates',
    'launch:operator-pack',
    'kickstarter:public-copy-lock',
    'kickstarter:supplier-quote-audit',
    'kickstarter:page-review-audit',
    'kickstarter:launch-signoff-audit',
    'kickstarter:prelaunch-page-intake-audit',
    'kickstarter:prelaunch-page-pack',
    'record_update_plan_status',
    'record_apply_status',
    'public_copy_lock_status',
    'public_copy_lock_ready',
    'supplier_quote_status',
    'Supplier quote audit status',
    'supplier_quotes_ready',
    'supplier_next_required_input_count',
    'Supplier Quote Next Required Inputs',
    'page_review_status',
    'Page review audit status',
    'page_review_ready',
    'page_review_next_required_input_count',
    'Page Review Next Required Inputs',
    'launch_operations_next_required_input_count',
    'Launch Operations Queue Summary',
    'Top Launch Operations Queue',
    'launch_operations_queue',
    'launch_operations_domain_summary',
    'launch_signoff_status',
    'Launch signoff audit status',
    'launch_signoff_ready',
    'launch_signoff_next_required_input_count',
    'Launch Signoff Next Required Inputs',
    'prelaunch_intake_status',
    'Pre-launch intake audit status',
    'prelaunch_intake_ready',
    'prelaunch_page_status',
    'Pre-launch page status',
    'prelaunch_page_next_required_input_count',
    'Pre-Launch Next Required Inputs',
    'operator_pack_status',
    'operator_field_work_order_count',
    'Operator field work orders',
    'kickstarter:launch-freeze-pack',
    'kickstarter:launch-day-command-center',
    'launch_freeze_status',
    'launch_freeze_ready',
    'Kickstarter launch freeze pack',
    'launch_day_command_center_status',
    'Launch-day command center status',
    'Kickstarter launch is a manual action',
    'ops_refresh_launch_not_ready',
    'npm run kickstarter:ops-refresh',
    'npm run kickstarter:supplier-quote-intake',
    'npm run kickstarter:page-review-intake',
    'npm run kickstarter:launch-signoff-audit',
    'npm run kickstarter:prelaunch-page-intake',
    'npm run kickstarter:prelaunch-page-intake-audit',
    'npm run kickstarter:proof-shot-intake',
    'npm run verify:local-demo-handoff',
    'Strict Kickstarter ops refresh failed',
    'This ops refresh is not launch approval',
  ]);
  mustExist('scripts/build-launch-review-pack.mjs');
  requireIncludes('scripts/build-launch-review-pack.mjs', [
    'inkloop.launch_review_pack.v1',
    'test-results/ai-pen-launch-review-pack',
    'test-results/ai-pen-launch-evidence-intake-audit',
    'test-results/ai-pen-launch-evidence-record-update-plan',
    'test-results/ai-pen-kickstarter-critical-path',
    'test-results/ai-pen-kickstarter-weekly-sprint',
    'test-results/ai-pen-launch-kpi-dashboard',
    'test-results/ai-pen-kickstarter-claim-downgrade',
    'test-results/ai-pen-kickstarter-public-copy-lock',
    'test-results/ai-pen-kickstarter-supplier-quote-audit',
    'test-results/ai-pen-kickstarter-page-review-audit',
    'test-results/ai-pen-kickstarter-risk-register',
    'demo_ready_launch_not_ready',
    'local demo is ready but Kickstarter launch is not ready',
    'presentation_handoff',
    'acceptance_signals',
    'Demo Handoff',
    'Demo Acceptance Signals',
    'Local demo ready does not equal Kickstarter launch ready.',
    'npm run launch:evidence:intake',
    'npm run launch:evidence:intake-audit',
    'npm run launch:evidence:record-update-plan',
    'npm run launch:evidence:apply-record-updates',
    'npm run launch:evidence:audit',
    'npm run launch:action-plan',
    'npm run launch:critical-path',
    'npm run launch:weekly-sprint',
    'npm run launch:kpi-dashboard',
    'npm run kickstarter:claim-downgrade',
    'page review audit',
    'npm run kickstarter:page-review-audit',
    'npm run kickstarter:risk-register',
    'npm run launch:evidence:audit:strict',
  ]);
  mustExist('scripts/build-kickstarter-rehearsal-pack.mjs');
  requireIncludes('scripts/build-kickstarter-rehearsal-pack.mjs', [
    'inkloop.kickstarter_rehearsal_pack.v1',
    'test-results/ai-pen-kickstarter-rehearsal',
    'test-results/ai-pen-kickstarter-critical-path',
    'test-results/ai-pen-kickstarter-weekly-sprint',
    'test-results/ai-pen-launch-kpi-dashboard',
    'test-results/ai-pen-kickstarter-claim-downgrade',
    'test-results/ai-pen-kickstarter-public-copy-lock',
    'test-results/ai-pen-kickstarter-supplier-quote-audit',
    'test-results/ai-pen-kickstarter-page-review-audit',
    'test-results/ai-pen-kickstarter-risk-register',
    'rehearsal_ready_launch_not_ready',
    'rehearsal_ready_public_copy_not_ready',
    'Public copy lock status',
    'Kickstarter rehearsal pack is not publish approval',
    'presentation_handoff',
    'acceptance_signals',
    'Demo Handoff',
    'Demo Acceptance Signals',
    'Local demo ready does not equal Kickstarter launch ready.',
    'Proof-Shot Gaps',
    'npm run launch:critical-path',
    'npm run launch:weekly-sprint',
    'npm run launch:kpi-dashboard',
    'npm run kickstarter:claim-downgrade',
    'npm run kickstarter:public-copy-lock',
    'supplier quote audit',
    'page review audit',
    'npm run kickstarter:page-review-audit',
    'npm run kickstarter:risk-register',
    'npm run verify:local-demo-handoff',
    'npm run launch:review-pack',
    'npm run launch:evidence:audit:strict',
  ]);
  mustExist('scripts/create-kickstarter-proof-shot-intake.mjs');
  requireIncludes('scripts/create-kickstarter-proof-shot-intake.mjs', [
    'inkloop.kickstarter_proof_shot_intake.v1',
    'test-results/ai-pen-kickstarter-proof-shot-intake',
    'Kickstarter proof-shot intake is not publish approval',
    'Shows Capture Surface requirement clearly',
    'Shows Live Board timing without speed-up deception',
    'raw/shot-log.csv',
    'claim-review.csv',
    'npm run kickstarter:rehearsal-pack',
    'npm run launch:evidence:audit',
  ]);
  mustExist('scripts/audit-kickstarter-proof-shots.mjs');
  requireIncludes('scripts/audit-kickstarter-proof-shots.mjs', [
    'inkloop.kickstarter_proof_shot_audit.v1',
    'test-results/ai-pen-kickstarter-proof-shot-audit',
    'not_final_cut_ready',
    'final_cut_ready',
    'real_time_or_disclosed',
    'Strict Kickstarter proof-shot audit failed',
  ]);
  mustExist('scripts/build-kickstarter-launch-freeze-pack.mjs');
  requireIncludes('scripts/build-kickstarter-launch-freeze-pack.mjs', [
    'inkloop.kickstarter_launch_freeze.v1',
    'test-results/ai-pen-kickstarter-launch-freeze',
    'launch_freeze_not_ready',
    'launch_freeze_ready',
    'F-KICKSTARTER-PREVIEW',
    'F-LEGAL-PRIVACY',
    'F-REWARDS-PRICING',
    'F-GTM-DEMAND',
    'F-HUMAN-SIGNOFF',
    'launch-freeze-signoff.md',
    'supplierQuoteAudit',
    'pageReviewAudit',
    'launchSignoffAudit',
    'supplier_quotes_ready',
    'page_review_ready',
    'launch_signoff_ready',
    'Supplier quote audit status',
    'Page review audit status',
    'Launch signoff audit status',
    'npm run kickstarter:supplier-quote-audit:strict',
    'npm run kickstarter:page-review-audit:strict',
    'npm run kickstarter:launch-signoff-audit:strict',
    'Human signoff rows must be updated by the responsible owners',
    'npm run kickstarter:launch-freeze-pack',
    'Strict Kickstarter launch freeze failed',
    'This launch freeze pack is not launch approval',
  ]);
  mustExist('scripts/build-kickstarter-launch-day-command-center.mjs');
  requireIncludes('scripts/build-kickstarter-launch-day-command-center.mjs', [
    'inkloop.kickstarter_launch_day_command_center.v1',
    'test-results/ai-pen-kickstarter-launch-day-command-center',
    'launchSignoffAudit',
    'launch_day_blocked_by_signoff',
    'Launch signoff audit status',
    'launch_signoff_ready',
    'launchDayCommsPack',
    'Launch-day comms pack status',
    'launch_day_blocked_by_launch_freeze',
    'launch_day_ready',
    'Manual Kickstarter launch owner assigned',
    'Kickstarter launch is a manual action',
    'T+24h',
    'npm run kickstarter:launch-signoff-audit:strict',
    'npm run kickstarter:launch-day-command-center',
    'Strict Kickstarter launch-day command center failed',
  ]);
  note('launch evidence analyzer scripts and fixtures present');
}

function verifyPackageScripts() {
  const rootPackage = readJson('package.json');
  const demoPackage = readJson('examples/ai-annotation-demo/package.json');
  const rootVerify = rootPackage.scripts?.verify ?? '';
  const demoVerify = demoPackage.scripts?.verify ?? '';
  if (!rootPackage.scripts?.['verify:ai-pen-kickstarter']) {
    fail('root package.json is missing verify:ai-pen-kickstarter script');
  }
  if (!rootVerify.includes('verify:ai-pen-kickstarter')) {
    fail('root npm run verify does not include verify:ai-pen-kickstarter');
  }
  if (!rootPackage.scripts?.['verify:obsidian-v1-plugin']) {
    fail('root package.json is missing verify:obsidian-v1-plugin script');
  }
  if (!rootVerify.includes('npm run verify:obsidian-v1-plugin')) {
    fail('root npm run verify does not include verify:obsidian-v1-plugin');
  }
  if (!rootVerify.includes('node scripts/create-obsidian-demo-vault.mjs --skip-build')) {
    fail('root npm run verify does not generate the Obsidian demo vault');
  }
  if (!rootPackage.scripts?.['obsidian:smoke']) {
    fail('root package.json is missing obsidian:smoke script');
  }
  if (!rootPackage.scripts?.['obsidian:smoke']?.includes('npm run build') || !rootPackage.scripts?.['obsidian:smoke']?.includes('npm run verify:obsidian-v1-plugin')) {
    fail('root obsidian:smoke must build the plugin and run verify:obsidian-v1-plugin');
  }
  if (rootPackage.scripts?.['obsidian:smoke']?.includes('npm --workspace ./examples/ai-annotation-demo run obsidian:smoke')) {
    fail('root obsidian:smoke still delegates to the removed demo workspace obsidian:smoke script');
  }
  if (rootPackage.scripts?.['obsidian:demo-vault'] !== 'node scripts/create-obsidian-demo-vault.mjs') {
    fail('root package.json is missing obsidian:demo-vault script');
  }
  requireIncludes('scripts/create-obsidian-demo-vault.mjs', [
    'inkloop.obsidian_demo_vault.v1',
    'test-results/obsidian-demo-vault',
    'buildLessonGraphKnowledgeObjects',
    'buildMeetingGraphKnowledgeObjects',
    'renderVaultMarkdown',
    'reading_note',
    'highlight',
    'task',
    'meeting_decision',
    'meeting_risk',
    'required_projection_kinds',
    'Reading notes, highlights, handwritten thoughts, and AI brush responses are projected from the source file unit.',
    'Meeting decisions, actions, risks, and diagrams are projected from marked board events.',
    'source file unit',
    'source_file_unit_frontmatter',
    'risk_surface_glare',
    'inkloop-sync',
    '--skip-build',
  ]);
  if (!rootPackage.scripts?.['verify:kickstarter-claims']) {
    fail('root package.json is missing verify:kickstarter-claims script');
  }
  if (!rootVerify.includes('npm run verify:kickstarter-claims')) {
    fail('root npm run verify does not include verify:kickstarter-claims');
  }
  if (rootPackage.scripts?.['demo:ai-pen'] !== 'node scripts/run-ai-pen-demo.mjs') {
    fail('root package.json is missing local-first demo:ai-pen script');
  }
  if (rootPackage.scripts?.['demo:smoke:ai-pen'] !== 'npm --workspace ./examples/ai-annotation-demo run smoke:ai-pen-browser') {
    fail('root package.json is missing demo:smoke:ai-pen browser smoke alias');
  }
  if (rootPackage.scripts?.['demo:smoke:ai-graph-worker'] !== 'npm --workspace ./examples/ai-annotation-demo run smoke:ai-graph-worker') {
    fail('root package.json is missing demo:smoke:ai-graph-worker worker smoke alias');
  }
  if (rootPackage.scripts?.['demo:smoke:runtime-sync'] !== 'npm --workspace ./examples/ai-annotation-demo run smoke:runtime-sync-flow') {
    fail('root package.json is missing demo:smoke:runtime-sync runtime sync smoke alias');
  }
  if (rootPackage.scripts?.['demo:evidence:bundle'] !== 'node scripts/build-demo-evidence-bundle.mjs') {
    fail('root package.json is missing demo:evidence:bundle evidence package alias');
  }
  if (rootPackage.scripts?.['android:assemble:debug'] !== 'node scripts/assemble-android-paper-debug.mjs') {
    fail('root package.json is missing android:assemble:debug APK build alias');
  }
  if (rootPackage.scripts?.['verify:local-demo-handoff'] !== 'npm run demo:smoke:runtime-sync && npm run demo:smoke:ai-pen && npm run demo:smoke:ai-graph-worker && npm run android:assemble:debug && npm run obsidian:demo-vault && npm run kickstarter:ops-refresh && npm run demo:evidence:bundle') {
    fail('root package.json is missing verify:local-demo-handoff local demo handoff script');
  }
  if (rootPackage.scripts?.['launch:evidence:audit'] !== 'node scripts/audit-launch-evidence.mjs') {
    fail('root package.json is missing launch:evidence:audit script');
  }
  if (rootPackage.scripts?.['launch:evidence:audit:strict'] !== 'node scripts/audit-launch-evidence.mjs --strict') {
    fail('root package.json is missing launch:evidence:audit:strict script');
  }
  if (rootPackage.scripts?.['launch:evidence:intake'] !== 'node scripts/create-launch-evidence-intake.mjs') {
    fail('root package.json is missing launch:evidence:intake script');
  }
  if (rootPackage.scripts?.['launch:evidence:intake-audit'] !== 'node scripts/audit-launch-evidence-intake.mjs') {
    fail('root package.json is missing launch:evidence:intake-audit script');
  }
  if (rootPackage.scripts?.['launch:evidence:intake-audit:strict'] !== 'node scripts/audit-launch-evidence-intake.mjs --strict') {
    fail('root package.json is missing launch:evidence:intake-audit:strict script');
  }
  if (rootPackage.scripts?.['launch:evidence:record-update-plan'] !== 'node scripts/build-launch-evidence-record-update-plan.mjs') {
    fail('root package.json is missing launch:evidence:record-update-plan script');
  }
  if (rootPackage.scripts?.['launch:evidence:record-update-plan:strict'] !== 'node scripts/build-launch-evidence-record-update-plan.mjs --strict') {
    fail('root package.json is missing launch:evidence:record-update-plan:strict script');
  }
  if (rootPackage.scripts?.['launch:evidence:apply-record-updates'] !== 'node scripts/apply-launch-evidence-record-updates.mjs') {
    fail('root package.json is missing launch:evidence:apply-record-updates script');
  }
  if (rootPackage.scripts?.['launch:evidence:apply-record-updates:write'] !== 'node scripts/apply-launch-evidence-record-updates.mjs --apply') {
    fail('root package.json is missing launch:evidence:apply-record-updates:write script');
  }
  if (rootPackage.scripts?.['launch:evidence:apply-record-updates:strict'] !== 'node scripts/apply-launch-evidence-record-updates.mjs --strict') {
    fail('root package.json is missing launch:evidence:apply-record-updates:strict script');
  }
  if (rootPackage.scripts?.['launch:operator-pack'] !== 'node scripts/build-launch-operator-pack.mjs') {
    fail('root package.json is missing launch:operator-pack script');
  }
  if (rootPackage.scripts?.['launch:operator-pack:strict'] !== 'node scripts/build-launch-operator-pack.mjs --strict') {
    fail('root package.json is missing launch:operator-pack:strict script');
  }
  if (rootPackage.scripts?.['launch:action-plan'] !== 'node scripts/build-launch-action-plan.mjs') {
    fail('root package.json is missing launch:action-plan script');
  }
  if (rootPackage.scripts?.['launch:critical-path'] !== 'node scripts/build-kickstarter-critical-path.mjs') {
    fail('root package.json is missing launch:critical-path script');
  }
  if (rootPackage.scripts?.['launch:critical-path:strict'] !== 'node scripts/build-kickstarter-critical-path.mjs --strict') {
    fail('root package.json is missing launch:critical-path:strict script');
  }
  if (rootPackage.scripts?.['launch:weekly-sprint'] !== 'node scripts/build-kickstarter-weekly-sprint.mjs') {
    fail('root package.json is missing launch:weekly-sprint script');
  }
  if (rootPackage.scripts?.['launch:weekly-sprint:strict'] !== 'node scripts/build-kickstarter-weekly-sprint.mjs --strict') {
    fail('root package.json is missing launch:weekly-sprint:strict script');
  }
  if (rootPackage.scripts?.['launch:kpi-dashboard'] !== 'node scripts/build-launch-kpi-dashboard.mjs') {
    fail('root package.json is missing launch:kpi-dashboard script');
  }
  if (rootPackage.scripts?.['launch:kpi-dashboard:strict'] !== 'node scripts/build-launch-kpi-dashboard.mjs --strict') {
    fail('root package.json is missing launch:kpi-dashboard:strict script');
  }
  if (rootPackage.scripts?.['launch:review-pack'] !== 'node scripts/build-launch-review-pack.mjs') {
    fail('root package.json is missing launch:review-pack script');
  }
  if (rootPackage.scripts?.['kickstarter:rehearsal-pack'] !== 'node scripts/build-kickstarter-rehearsal-pack.mjs') {
    fail('root package.json is missing kickstarter:rehearsal-pack script');
  }
  if (rootPackage.scripts?.['kickstarter:claim-downgrade'] !== 'node scripts/build-kickstarter-claim-downgrade-pack.mjs') {
    fail('root package.json is missing kickstarter:claim-downgrade script');
  }
  if (rootPackage.scripts?.['kickstarter:claim-downgrade:strict'] !== 'node scripts/build-kickstarter-claim-downgrade-pack.mjs --strict') {
    fail('root package.json is missing kickstarter:claim-downgrade:strict script');
  }
  if (rootPackage.scripts?.['kickstarter:public-copy-lock'] !== 'node scripts/build-kickstarter-public-copy-lock.mjs') {
    fail('root package.json is missing kickstarter:public-copy-lock script');
  }
  if (rootPackage.scripts?.['kickstarter:public-copy-lock:strict'] !== 'node scripts/build-kickstarter-public-copy-lock.mjs --strict') {
    fail('root package.json is missing kickstarter:public-copy-lock:strict script');
  }
  if (rootPackage.scripts?.['kickstarter:supplier-quote-intake'] !== 'node scripts/create-kickstarter-supplier-quote-intake.mjs') {
    fail('root package.json is missing kickstarter:supplier-quote-intake script');
  }
  if (rootPackage.scripts?.['kickstarter:supplier-quote-audit'] !== 'node scripts/audit-kickstarter-supplier-quotes.mjs') {
    fail('root package.json is missing kickstarter:supplier-quote-audit script');
  }
  if (rootPackage.scripts?.['kickstarter:supplier-quote-audit:strict'] !== 'node scripts/audit-kickstarter-supplier-quotes.mjs --strict') {
    fail('root package.json is missing kickstarter:supplier-quote-audit:strict script');
  }
  if (rootPackage.scripts?.['kickstarter:page-review-intake'] !== 'node scripts/create-kickstarter-page-review-intake.mjs') {
    fail('root package.json is missing kickstarter:page-review-intake script');
  }
  if (rootPackage.scripts?.['kickstarter:page-review-audit'] !== 'node scripts/audit-kickstarter-page-review.mjs') {
    fail('root package.json is missing kickstarter:page-review-audit script');
  }
  if (rootPackage.scripts?.['kickstarter:page-review-audit:strict'] !== 'node scripts/audit-kickstarter-page-review.mjs --strict') {
    fail('root package.json is missing kickstarter:page-review-audit:strict script');
  }
  if (rootPackage.scripts?.['kickstarter:launch-signoff-audit'] !== 'node scripts/audit-kickstarter-launch-signoff.mjs') {
    fail('root package.json is missing kickstarter:launch-signoff-audit script');
  }
  if (rootPackage.scripts?.['kickstarter:launch-signoff-audit:strict'] !== 'node scripts/audit-kickstarter-launch-signoff.mjs --strict') {
    fail('root package.json is missing kickstarter:launch-signoff-audit:strict script');
  }
  if (rootPackage.scripts?.['kickstarter:prelaunch-page-intake'] !== 'node scripts/create-kickstarter-prelaunch-page-intake.mjs') {
    fail('root package.json is missing kickstarter:prelaunch-page-intake script');
  }
  if (rootPackage.scripts?.['kickstarter:prelaunch-page-intake-audit'] !== 'node scripts/audit-kickstarter-prelaunch-page-intake.mjs') {
    fail('root package.json is missing kickstarter:prelaunch-page-intake-audit script');
  }
  if (rootPackage.scripts?.['kickstarter:prelaunch-page-intake-audit:strict'] !== 'node scripts/audit-kickstarter-prelaunch-page-intake.mjs --strict') {
    fail('root package.json is missing kickstarter:prelaunch-page-intake-audit:strict script');
  }
  if (rootPackage.scripts?.['kickstarter:prelaunch-page-pack'] !== 'node scripts/build-kickstarter-prelaunch-page-pack.mjs') {
    fail('root package.json is missing kickstarter:prelaunch-page-pack script');
  }
  if (rootPackage.scripts?.['kickstarter:prelaunch-page-pack:strict'] !== 'node scripts/build-kickstarter-prelaunch-page-pack.mjs --strict') {
    fail('root package.json is missing kickstarter:prelaunch-page-pack:strict script');
  }
  if (rootPackage.scripts?.['kickstarter:risk-register'] !== 'node scripts/build-kickstarter-risk-register.mjs') {
    fail('root package.json is missing kickstarter:risk-register script');
  }
  if (rootPackage.scripts?.['kickstarter:risk-register:strict'] !== 'node scripts/build-kickstarter-risk-register.mjs --strict') {
    fail('root package.json is missing kickstarter:risk-register:strict script');
  }
  if (rootPackage.scripts?.['kickstarter:ops-refresh'] !== 'node scripts/run-kickstarter-ops-refresh.mjs') {
    fail('root package.json is missing kickstarter:ops-refresh script');
  }
  if (rootPackage.scripts?.['kickstarter:ops-refresh:strict'] !== 'node scripts/run-kickstarter-ops-refresh.mjs --strict') {
    fail('root package.json is missing kickstarter:ops-refresh:strict script');
  }
  if (rootPackage.scripts?.['kickstarter:launch-freeze-pack'] !== 'node scripts/build-kickstarter-launch-freeze-pack.mjs') {
    fail('root package.json is missing kickstarter:launch-freeze-pack script');
  }
  if (rootPackage.scripts?.['kickstarter:launch-freeze-pack:strict'] !== 'node scripts/build-kickstarter-launch-freeze-pack.mjs --strict') {
    fail('root package.json is missing kickstarter:launch-freeze-pack:strict script');
  }
  if (rootPackage.scripts?.['kickstarter:launch-day-command-center'] !== 'node scripts/build-kickstarter-launch-day-command-center.mjs') {
    fail('root package.json is missing kickstarter:launch-day-command-center script');
  }
  if (rootPackage.scripts?.['kickstarter:launch-day-command-center:strict'] !== 'node scripts/build-kickstarter-launch-day-command-center.mjs --strict') {
    fail('root package.json is missing kickstarter:launch-day-command-center:strict script');
  }
  if (rootPackage.scripts?.['kickstarter:proof-shot-intake'] !== 'node scripts/create-kickstarter-proof-shot-intake.mjs') {
    fail('root package.json is missing kickstarter:proof-shot-intake script');
  }
  if (rootPackage.scripts?.['kickstarter:proof-shot-audit'] !== 'node scripts/audit-kickstarter-proof-shots.mjs') {
    fail('root package.json is missing kickstarter:proof-shot-audit script');
  }
  if (rootPackage.scripts?.['kickstarter:proof-shot-audit:strict'] !== 'node scripts/audit-kickstarter-proof-shots.mjs --strict') {
    fail('root package.json is missing kickstarter:proof-shot-audit:strict script');
  }
  requireIncludes('scripts/audit-launch-evidence.mjs', [
    'inkloop.launch_evidence_audit.v1',
    'launch_ready_evidence_present',
    'not_launch_ready',
    'Strict launch evidence audit failed',
    'artifact_checks_passed',
    'analyzer_checks_passed',
    'required raw artifact link groups are absent or unresolved',
    'required analyzer reports are absent, unreadable, or failing gate checks',
    'gate_checks.schema_pass_rate',
    'gate_checks.education_campaign_demo_ready',
    'gate_checks.supplier_backed_for_public_page',
    'gate_checks.launch_demand_ready',
    'Kickstarter preview page',
    'legal/privacy review',
    'GTM analyzer report',
    '5 working AI Pen prototypes',
    'Capture Surface calibration',
    'Real education demo review',
    'Real business meeting demo review',
    'BOM and supplier readiness',
    'GTM demand readiness',
    'Kickstarter page publish readiness',
  ]);
  requireIncludes('scripts/build-demo-evidence-bundle.mjs', [
    'inkloop.demo_evidence_bundle.v1',
    'test-results/ai-pen-demo-evidence',
    'requiredBrowserChecks',
    'RawPenFrame JSONL import -> InkEvents -> AI Graph Job -> LessonGraph',
    'InkLoopRawPen browser/native bridge -> InkEvents -> AI Graph Job -> LessonGraph',
    'AI Graph Job queue completes before KnowledgeObject review',
    'Meeting action keeps board/ink evidence as required proof while retaining audio context only as optional context',
    'browser smoke missing required checked item',
    'requireText',
    'Meeting Event Marks',
    'board/ink evidence required; audio/subtitles/timeline optional context',
    'Meeting actions, decisions, risks, and diagrams require board/ink evidence',
    'AI graph worker smoke result is not ok',
    'requiredProjectionKinds',
    'reading_note',
    'highlight',
    'task',
    'meeting_decision',
    'meeting_risk',
    'Obsidian demo vault missing required projection kind',
    'Reading note, highlight, annotation, and AI brush projection objects',
    'Decision, Action, Risk, and Diagram meeting projection objects',
    'AI Graph worker smoke report',
    'jobs.completed.jsonl',
    'jobs.rejected.jsonl',
    'verify:local-demo-handoff',
    'kickstarter:ops-refresh',
    'kickstarter:prelaunch-page-pack',
    'launch:operator-pack',
    'test-results/ai-pen-kickstarter-ops-refresh/ops-refresh.json',
    'test-results/ai-pen-kickstarter-prelaunch-page/prelaunch-page.json',
    'test-results/ai-pen-launch-operator-pack/operator-pack.json',
    'Launch Boundary Snapshot',
    'prelaunch_page_status',
    'operator_pack_status',
    'operator_prelaunch_work_order_status',
    'launch_operations_queue',
    'launch_operations_next_required_inputs',
    'Launch Operations Queue',
    'presentation_handoff',
    'Presentation Handoff',
    'Acceptance Signals',
    'Web/Desktop Capture Host',
    'RawPenFrame import',
    'source file unit boundary',
    'RawPenFrame hardware ingress bridge',
    'M103 socket RawPenFrame adapter',
    'Obsidian source file unit projection adapter',
    'Android/Paper same-LAN document import bridge',
    'InkLoopLanImport same-LAN document inbox',
    'Obsidian projection',
    'Android / InkLoop Paper',
    'Launch boundary',
    'Launch operations queue',
    'Launch operator pack',
    'Local demo ready does not equal Kickstarter launch ready.',
    'Browser smoke ok=true with RawPenFrame import, InkLoopRawPen browser/native bridge',
    'launch operations queue',
    'pre-launch page boundary',
    'This bundle proves the local RawPenFrame ingress bridge only; it does not prove a specific BLE, Serial, or firmware transport.',
    'M103 hqunifiedsocket RawPenFrame adapter plus JSONL export path',
    'AI Graph worker smoke ok=true with completed, retried, and rejected jobs',
    'Obsidian demo vault and packaged plugin exist with source file/session unit frontmatter; reading note, highlight, and handwritten annotation stay under Reading while meeting decisions and risks stay under Meetings; the V1 projection-only settings boundary; and the Meeting Event Marks board/ink evidence boundary.',
    'Kickstarter ops refresh exposes the unified launch operations queue',
    'Launch operator pack is attached',
    'demo:smoke:ai-graph-worker',
    'demo:smoke:ai-pen',
    'android:assemble:debug',
    'obsidian:smoke',
    'Android/Paper InkLoopRuntime boundary bridge',
    'Android/Paper packaged mobile runtime boundary asset',
    'Obsidian settings V1 boundary panel',
    'Launch operator pack README',
    'Launch operator pack JSON',
    'runtime boundary bridge/status assets',
    'V1 settings boundary panel',
    'This bundle does not prove real AI Pen BLE/firmware ingestion.',
    'This bundle does not prove the Kickstarter pre-launch page is published',
  ]);
  requireIncludes('scripts/assemble-android-paper-debug.mjs', [
    'resolveJavaHome',
    '.cache/inkloop-tools/jdks/temurin17/Contents/Home',
    'verify:android-paper-assets',
    ':app:assembleDebug',
    'app-debug.apk',
  ]);
  requireIncludes('examples/ai-annotation-demo/scripts/smoke-ai-pen-browser.ts', [
    'test-results/ai-pen-browser-smoke',
    'education-projection.png',
    'meeting-projection.png',
    'result.json',
    'Accept/Edit/Dismiss review gates',
    'applyReviewEdit',
    'RawPenFrame JSONL import -> InkEvents -> AI Graph Job -> LessonGraph',
    'InkLoopRawPen browser/native bridge -> InkEvents -> AI Graph Job -> LessonGraph',
    'pushRawLogThroughBridge',
    'window.InkLoopRawPen',
    'AI Graph Job completed',
    'AI Graph Job queue completes before KnowledgeObject review',
    'importRawLog',
    'Source File Unit',
    'inkloop_document_id + inkloop://doc keep projections grouped',
    'inkloop_projection_role: "source_file_unit"',
    'inkloop_projection_role: "knowledge_projection"',
    'Meeting Event Marks',
    'board/ink evidence required',
    'audio/subtitles/timeline optional context',
    'audio:900-6200 Facilitator',
    'Meeting action keeps board/ink evidence as required proof while retaining audio context only as optional context',
    'Edited review body is rendered into Obsidian projection',
    'Dismissed meeting risk is not promoted into projection',
    'Pre-Launch / Notify me',
    'prelaunch_page_not_ready',
    'Launch Ops Queue',
    '86 P0 inputs',
    'V1 Launch Chain panel keeps product chain, source file unit, launch operations queue, pre-launch page, and launch-freeze Go/No-Go boundaries visible',
  ]);
  requireIncludes('examples/ai-annotation-demo/src/ai-pen-demo.ts', [
    'Import Raw Log',
    'RAW_PEN_FRAME_BRIDGE_NAME',
    'createRawPenFrameBridge',
    'Hardware Ingress',
    'installRawPenFrameBridge',
    'AI_GRAPH_JOB_SCHEMA_VERSION',
    'validateAiGraphJob',
    'AI Graph Job completed',
    'importRawFrameFile',
    'data-review-edit-key',
    'data-review-save-key',
    'Apply Edit',
    'bodyOverridesById: editedBodyById()',
    'V1 Launch Chain',
    'Meeting Event Marks',
    'board/ink evidence required · audio/subtitles/timeline optional context',
    'meetingAudioContextRef',
    'audio_segment_refs',
    'Source File Unit',
    'inkloop_document_id + inkloop://doc keep projections grouped',
    'Obsidian Projection Only',
    'Pre-Launch / Notify me',
    'prelaunch_page_not_ready',
    'Launch Ops Queue',
    '86 P0 inputs',
    'Launch Freeze Go/No-Go',
    '0/13 gates ready',
    'preview/legal/BOM/GTM/proof shots/human signoff missing',
  ]);
  requireIncludes('examples/ai-annotation-demo/src/capture/raw-pen-stream.ts', [
    'RAW_PEN_FRAME_BRIDGE_NAME',
    'InkLoopRawPen',
    'RawPenFrameBridge',
    'parseRawFrameRecords',
    'parseAndValidateRawFrameRecords',
    'validateRawFrameRecords',
    'groupRawFramesIntoStrokes',
    'pointFromRawFrame',
    'createRawPenFrameBridge',
    'android_native',
    'web_serial',
    'web_bluetooth',
    'validateRawPenFrame',
  ]);
  requireIncludes('examples/ai-annotation-demo/src/capture/raw-pen-stream.test.ts', [
    'parseRawFrameRecords',
    'groupRawFramesIntoStrokes',
    'createRawPenFrameBridge',
    'android_native',
    'web_bluetooth',
    'tip_state',
  ]);
  requireIncludes('examples/ai-annotation-demo/src/capture/m103-raw-pen-adapter.ts', [
    'M103_RAW_PEN_CAPTURE_BRIDGE_NAME',
    'InkLoopM103RawPenCapture',
    'm103SocketStrokeToRawPenFrames',
    'publishM103RawPenStroke',
    'framesToJsonl',
    'validateRawFrameRecords',
    'm103_hqunifiedsocket',
    'android_native',
    'RAW_PEN_FRAME_BRIDGE_NAME',
  ]);
  requireIncludes('examples/ai-annotation-demo/src/capture/m103-raw-pen-adapter.test.ts', [
    'm103SocketStrokeToRawPenFrames',
    'framesToJsonl',
    'validateRawPenFrame',
    'm103_hqunifiedsocket_7',
    'm103-hqhw-bridge',
  ]);
  requireIncludes('examples/ai-annotation-demo/src/capture/ink.ts', [
    'publishM103RawPenStroke',
    'm103_hqhw_stylus',
    'm103-hqhw-bridge',
    'surfaceRect: cv.getBoundingClientRect()',
  ]);
  requireIncludes('examples/ai-annotation-demo/android/app/src/main/java/com/example/hmpocrpoc/InkLoopLanImportBridge.kt', [
    'window.InkLoopLanImport',
    'ServerSocket',
    '0.0.0.0',
    'multipart/form-data',
    'lan-inbox',
    'readBase64',
    'same Wi-Fi',
  ]);
  requireIncludes('examples/ai-annotation-demo/src/mobile-main.ts', [
    'InkLoopLanImport',
    '局域网上传',
    'Wi-Fi 收件箱',
    'readLanImportState',
    'lan.start()',
  ]);
  requireIncludes('examples/ai-annotation-demo/scripts/smoke-ai-graph-worker.ts', [
    'inkloop.ai_graph_worker_smoke.v1',
    'validateAiGraphJob',
    'retry_scheduled',
    'job_worker_meeting_retry',
    'job_worker_audio_only_reject',
    'test-results/ai-graph-worker-smoke',
  ]);
  if (!demoPackage.scripts?.['verify:android-paper-assets']) {
    fail('demo package.json is missing verify:android-paper-assets');
  }
  if (!demoVerify.includes('npm run verify:android-paper-assets')) {
    fail('demo verify does not run verify:android-paper-assets');
  }
  for (const script of [
    'smoke:runtime-sync-flow',
    'smoke:ai-pen-v1',
    'smoke:ai-graph-worker',
    'smoke:ai-pen-evidence',
    'smoke:capture-surface-evidence',
    'smoke:live-board-latency-evidence',
    'smoke:reward-pricing-evidence',
    'smoke:gtm-metrics-evidence',
    'smoke:demo-review-evidence',
  ]) {
    if (!demoPackage.scripts?.[script]) fail(`demo package.json is missing ${script}`);
    if (!demoVerify.includes(`npm run ${script}`)) fail(`demo verify does not run ${script}`);
  }
  for (const script of [
    'evidence:ai-pen-run',
    'evidence:capture-surface',
    'evidence:live-board-latency',
    'evidence:reward-pricing',
    'evidence:gtm-metrics',
    'evidence:demo-review',
  ]) {
    if (!demoPackage.scripts?.[script]) fail(`demo package.json is missing ${script}`);
  }
  note('root and demo verification scripts include V1 evidence, campaign claims, Obsidian plugin, and Android/Paper asset checks');
}

function verifyDocumentedNpmScripts() {
  const rootScripts = readJson('package.json').scripts ?? {};
  const demoScripts = readJson('examples/ai-annotation-demo/package.json').scripts ?? {};
  const markdownFiles = [
    'README.md',
    'docs/architecture.md',
    'examples/ai-annotation-demo/README.md',
    'native/android/README.md',
    'packages/adapter-obsidian/README.md',
    ...walkMarkdownFiles(projectRoot),
  ];
  const commandPattern = /npm\s+(--workspace\s+\.\/examples\/ai-annotation-demo\s+)?run\s+`?([A-Za-z0-9:_-]+)`?/g;

  for (const file of markdownFiles) {
    if (!mustExist(file)) continue;
    const text = readText(file);
    let match;
    while ((match = commandPattern.exec(text))) {
      const workspaceDemo = Boolean(match[1]);
      let script = match[2];
      while (script.endsWith(':') && !rootScripts[script] && !demoScripts[script]) script = script.slice(0, -1);
      const scripts = workspaceDemo || file.startsWith('examples/ai-annotation-demo/') ? demoScripts : rootScripts;
      if (!scripts[script]) {
        fail(`${file} documents missing npm script: ${workspaceDemo ? 'npm --workspace ./examples/ai-annotation-demo run' : 'npm run'} ${script}`);
      }
    }
  }
  requireIncludes(`${projectRoot}/demo-runbook.md`, [
    'npm --workspace ./examples/ai-annotation-demo run verify:android-paper-assets',
  ]);
  note('documented npm scripts resolve to root or demo workspace package scripts');
}

function verifyRunbookAndAuditText() {
  requireIncludes(`${projectRoot}/demo-runbook.md`, [
    'npm run verify',
    'npm run demo:ai-pen',
    'npm run demo:smoke:ai-pen',
    'npm run demo:smoke:runtime-sync',
    'Import Raw Log',
    'RawPenFrame JSONL import -> InkEvents -> AI Graph Job -> LessonGraph',
    'window.InkLoopRawPen',
    'Hardware Ingress Bridge',
    'window.InkLoopM103RawPenCapture.exportJsonl()',
    'M103 `hqunifiedsocket`',
    'window.InkLoopLanImport',
    'Wi-Fi 收件箱',
    'local bridge does not prove a specific transport',
    'AI Graph Job completed',
    'Education Run Demo -> Generate AI -> Accept/Edit -> Obsidian projection',
    'Meeting Run Demo -> Generate AI -> Accept/Edit/Dismiss -> Obsidian projection',
    'Meeting action keeps board/ink evidence as required proof while retaining audio context only as optional context',
    'Meeting Event Marks',
    'board/ink evidence required',
    'audio/subtitles/timeline optional context',
    'audio:900-6200 Facilitator',
    'source file/session unit boundary',
    'inkloop_projection_role: "source_file_unit"',
    'V1 Launch Chain panel keeps AI Pen + Capture Surface, InkGraph output, user review gate, source file unit, Obsidian projection-only role, launch operations queue, pre-launch page boundary, and launch-freeze Go/No-Go boundary visible',
    'Launch Ops Queue: 86 P0 inputs',
    'Plugin settings evidence',
    'Meeting Event Marks require board/ink evidence while audio/subtitles/timeline stay optional context',
    'Launch Ops Queue` remains `86 P0 inputs',
    'Launch Ops Queue and Launch Freeze Go/No-Go are visible in settings but separate from Obsidian projection correctness',
    'clean reader/diary/books workspace',
    'hidden Android `InkLoopRuntime` manifest',
    'Confirm the `V1 Launch Chain` panel shows AI Pen + Capture Surface capture state, InkGraph output, user review gate, `Source File Unit`',
    'Confirm Obsidian Projection Preview renders clean Markdown with source file/session unit frontmatter',
    'Edited review body is rendered into Obsidian projection',
    'Apply Edit',
    'Dismissed meeting risk is not promoted into projection',
    'smoke:ai-pen-evidence',
    'smoke:capture-surface-evidence',
    'smoke:live-board-latency-evidence',
    'smoke:reward-pricing-evidence',
    'smoke:gtm-metrics-evidence',
    'smoke:demo-review-evidence',
    'release_path_used',
    'Runtime Sync smoke',
    'verify:local-demo-handoff',
    'launch:evidence:intake',
    'test-results/ai-pen-launch-evidence-intake',
    'launch:evidence:audit',
    'launch:evidence:intake-audit',
    'test-results/ai-pen-launch-evidence-intake-audit',
    'Launch evidence intake audit',
    'launch:evidence:apply-record-updates',
    'test-results/ai-pen-launch-evidence-record-apply',
    'launch:action-plan',
    'launch:critical-path',
    'test-results/ai-pen-kickstarter-critical-path',
    'Kickstarter critical path',
    'launch:weekly-sprint',
    'test-results/ai-pen-kickstarter-weekly-sprint',
    'Kickstarter weekly sprint',
    'launch:kpi-dashboard',
    'test-results/ai-pen-launch-kpi-dashboard',
    'Launch KPI dashboard',
    'kickstarter:claim-downgrade',
    'test-results/ai-pen-kickstarter-claim-downgrade',
    'Kickstarter claim downgrade pack',
    'kickstarter:public-copy-lock',
    'test-results/ai-pen-kickstarter-public-copy-lock',
    'Kickstarter public copy lock',
    'kickstarter:page-review-intake',
    'test-results/ai-pen-kickstarter-page-review-intake',
    'Kickstarter page review intake',
    'kickstarter:page-review-audit',
    'test-results/ai-pen-kickstarter-page-review-audit',
    'Kickstarter page review audit',
    'kickstarter:prelaunch-page-pack',
    'test-results/ai-pen-kickstarter-prelaunch-page',
    'Kickstarter pre-launch page pack',
    'kickstarter:risk-register',
    'test-results/ai-pen-kickstarter-risk-register',
    'Kickstarter risk register',
    'kickstarter:launch-signoff-audit',
    'test-results/ai-pen-kickstarter-launch-signoff-audit',
    'Kickstarter launch signoff audit',
    'kickstarter:ops-refresh',
    'test-results/ai-pen-kickstarter-ops-refresh',
    'Kickstarter ops refresh',
    'launch:review-pack',
    'test-results/ai-pen-launch-review-pack',
    'Weekly Launch Review Pack',
    'kickstarter:rehearsal-pack',
    'test-results/ai-pen-kickstarter-rehearsal',
    'Kickstarter rehearsal pack',
    'kickstarter:proof-shot-intake',
    'test-results/ai-pen-kickstarter-proof-shot-intake',
    'Kickstarter proof-shot intake',
    'kickstarter:proof-shot-audit',
    'test-results/ai-pen-kickstarter-proof-shot-audit',
    'Kickstarter proof-shot audit',
    'launch:operator-pack',
    'test-results/ai-pen-launch-operator-pack',
    'Launch operator pack',
    'kickstarter:launch-freeze-pack',
    'test-results/ai-pen-kickstarter-launch-freeze',
    'Kickstarter launch freeze pack',
    'kickstarter:launch-day-command-center',
    'test-results/ai-pen-kickstarter-launch-day-command-center',
    'Kickstarter launch-day command center',
    'test-results/ai-pen-launch-action-plan',
    'launch:evidence:audit:strict',
    'demo:evidence:bundle',
    'Demo evidence bundle',
    'runtime boundary bridge/status assets',
    'V1 settings boundary panel',
    'verify:kickstarter-claims',
    'Kickstarter campaign claim verifier',
    'verify:obsidian-v1-plugin',
    'Obsidian V1 plugin verifier',
    'obsidian:smoke',
    'obsidian:demo-vault',
    'source file/session unit frontmatter',
    'source-unit boundary',
    'temp vault',
    'legacy syncEndpoint',
    'verify:android-paper-assets',
    'npm --workspace ./examples/ai-annotation-demo run verify:android-paper-assets',
    'Android/Paper asset verifier',
    'InkLoopRuntime',
    'android:assemble:debug',
    'app-debug.apk',
    'These smokes prove analyzer readiness only',
    'local analyzer reports that do not pass required `gate_checks`',
  ]);
  requireIncludes(`${projectRoot}/launch-readiness-tracker.md`, [
    'Reward pricing analyzer smoke',
    'GTM metrics analyzer smoke',
    'Demo review analyzer smoke',
    'demo:smoke:ai-pen',
    'demo:smoke:runtime-sync',
    'demo:evidence:bundle',
    'verify:local-demo-handoff',
    'launch:evidence:intake',
    'Launch evidence intake',
    'launch:evidence:intake-audit',
    'Launch evidence intake audit',
    'launch:evidence:apply-record-updates',
    'Evidence record apply dry run',
    'launch:evidence:audit',
    'launch:action-plan',
    'launch:critical-path',
    'Kickstarter critical path',
    'launch:weekly-sprint',
    'Kickstarter weekly sprint',
    'launch:kpi-dashboard',
    'Launch KPI dashboard',
    'kickstarter:claim-downgrade',
    'Kickstarter claim downgrade pack',
    'settings-page V1 boundary panel with `Launch Ops Queue: 86 P0 inputs`',
    'kickstarter:public-copy-lock',
    'Kickstarter public copy lock',
    'kickstarter:supplier-quote-intake',
    'Kickstarter supplier quote intake',
    'kickstarter:supplier-quote-audit',
    'Supplier quote audit',
    'kickstarter:page-review-intake',
    'Kickstarter page review intake',
    'kickstarter:page-review-audit',
    'Page review audit',
    'kickstarter:prelaunch-page-pack',
    'Kickstarter pre-launch page pack',
    'kickstarter:risk-register',
    'Kickstarter risk register',
    'kickstarter:launch-signoff-audit',
    'Kickstarter launch signoff audit',
    'kickstarter:ops-refresh',
    'Kickstarter ops refresh',
    'kickstarter:launch-signoff-audit',
    'Kickstarter launch signoff audit',
    'kickstarter:launch-freeze-pack',
    'Kickstarter launch freeze pack',
    'kickstarter:launch-day-command-center',
    'Kickstarter launch-day command center',
    'launch:review-pack',
    'Launch review pack',
    'kickstarter:rehearsal-pack',
    'Kickstarter rehearsal pack',
    'kickstarter:proof-shot-intake',
    'Kickstarter proof-shot intake',
    'kickstarter:proof-shot-audit',
    'Kickstarter proof-shot audit',
    'launch:operator-pack',
    'Launch operator pack',
    'Launch action plan',
    'launch:evidence:audit:strict',
    'local analyzer reports passing required `gate_checks`',
    'Accept/Edit/Dismiss',
    'window.InkLoopRawPen',
    'Hardware Ingress',
    'real BLE/firmware transport',
    'AI graph job',
    'AI Graph Job completed',
    'V1 Launch Chain',
    'edited review body is rendered into projection',
    'dismissed risk is absent from projection',
    'Kickstarter campaign claim verifier',
    'Android/Paper asset verifier',
    'android:assemble:debug',
    'InkLoopRuntime',
    'InkLoopLanImport',
    'InkLoopM103RawPenCapture',
    'M103',
    'Obsidian V1 plugin verifier',
    'obsidian:smoke',
    'obsidian:demo-vault',
    'source file/session unit frontmatter',
    'temp vault',
    'legacy syncEndpoint',
    'e-paper moved to roadmap',
  ]);
  requireIncludes(`${projectRoot}/readiness-audit.md`, [
    'RawPenFrame import and hardware ingress boundary exist',
    'InkLoopRawPen browser/native bridge -> InkEvents -> AI Graph Job -> LessonGraph',
    'real BLE/firmware transport and real hardware log not done',
    'Demo review evidence analyzer exists',
    'Root AI Pen demo scripts exist',
    'AI graph job queue exists',
    'AI Graph Job completed',
    'Runtime Sync smoke',
    'Demo evidence bundle',
    'verify:local-demo-handoff',
    'launch:evidence:intake',
    'Launch evidence intake exists',
    'settings-page V1 boundary panel with `Launch Ops Queue: 86 P0 inputs`',
    'launch:evidence:intake-audit',
    'Launch evidence intake audit exists',
    'launch:evidence:apply-record-updates',
    'Evidence record apply dry run exists',
    'launch:evidence:audit',
    'launch:action-plan',
    'launch:critical-path',
    'Kickstarter critical path exists',
    'launch:weekly-sprint',
    'Kickstarter weekly sprint exists',
    'launch:kpi-dashboard',
    'Launch KPI dashboard exists',
    'kickstarter:claim-downgrade',
    'Kickstarter claim downgrade pack exists',
    'kickstarter:public-copy-lock',
    'Kickstarter public copy lock exists',
    'kickstarter:supplier-quote-intake',
    'Kickstarter supplier quote intake exists',
    'kickstarter:supplier-quote-audit',
    'supplier_quotes_not_ready',
    'kickstarter:page-review-intake',
    'Kickstarter page review intake exists',
    'kickstarter:page-review-audit',
    'page_review_not_ready',
    'kickstarter:prelaunch-page-pack',
    'Kickstarter pre-launch page pack exists',
    'kickstarter:risk-register',
    'Kickstarter risk register exists',
    'kickstarter:launch-signoff-audit',
    'Kickstarter launch signoff audit exists',
    'kickstarter:ops-refresh',
    'Kickstarter ops refresh exists',
    'kickstarter:launch-freeze-pack',
    'Kickstarter launch freeze pack exists',
    'kickstarter:launch-day-command-center',
    'Kickstarter launch-day command center exists',
    'launch:review-pack',
    'Launch review pack exists',
    'kickstarter:rehearsal-pack',
    'Kickstarter rehearsal pack exists',
    'kickstarter:proof-shot-intake',
    'Kickstarter proof-shot intake exists',
    'kickstarter:proof-shot-audit',
    'Kickstarter proof-shot audit exists',
    'launch:operator-pack',
    'Launch operator pack exists',
    'Launch action plan exists',
    'launch:evidence:audit:strict',
    'local analyzer reports passing required `gate_checks`',
    'boundary artifacts',
    'structured `presentation_handoff`',
    'acceptance_signals',
    'structured demo handoff',
    'browser smoke verifies Accept/Edit/Dismiss',
    'verifies the `V1 Launch Chain` status panel',
    'edited review body is rendered into projection',
    'Kickstarter campaign claim verifier exists',
    'Android/Paper asset verifier exists',
    'InkLoopLanImport` exposes same-LAN document upload into the mobile reader inbox',
    'M103 `hqunifiedsocket` strokes can be adapted into RawPenFrame batches',
    'window.InkLoopM103RawPenCapture` export path',
    'Android APK build script exists',
    'Obsidian V1 plugin verifier exists',
    'Obsidian demo vault exists',
    'source file/session unit frontmatter',
    'temp vault',
    'legacy syncEndpoint',
    'npm run verify: check, lint, V1 consistency verifier, Kickstarter campaign claim verifier, tests, build, Obsidian V1 plugin verifier, pack check, consumer verification, demo verification, Android/Paper asset verifier, AI Pen V1 smoke, and evidence analyzer smokes passed',
  ]);
  requireIncludes(`${projectRoot}/completion-audit.md`, [
    'RawPenFrame ingress bridge',
    'window.InkLoopRawPen',
    'M103 socket RawPenFrame adapter',
    'InkLoopLanImport',
    'window.InkLoopM103RawPenCapture',
    'local RawPenFrame bridge alone is not enough',
    'Demo review evidence smoke',
    'Root AI Pen demo smoke',
    'AI graph job boundary',
    'AI Graph Job completed',
    'Runtime Sync smoke',
    'Demo evidence bundle',
    'structured `presentation_handoff`',
    'acceptance_signals',
    'structured demo handoff',
    'verify:local-demo-handoff',
    'launch:evidence:intake',
    'Launch evidence intake',
    'settings-page V1 boundary panel with `Launch Ops Queue: 86 P0 inputs`',
    'launch:evidence:intake-audit',
    'Launch evidence intake audit',
    'launch:evidence:apply-record-updates',
    'Evidence record apply dry run',
    'launch:evidence:audit',
    'launch:action-plan',
    'launch:critical-path',
    'Kickstarter critical path',
    'launch:weekly-sprint',
    'Kickstarter weekly sprint',
    'launch:kpi-dashboard',
    'Launch KPI dashboard',
    'kickstarter:claim-downgrade',
    'Kickstarter claim downgrade pack',
    'kickstarter:public-copy-lock',
    'Kickstarter public copy lock',
    'kickstarter:supplier-quote-intake',
    'Kickstarter supplier quote intake',
    'kickstarter:supplier-quote-audit',
    'Kickstarter supplier quote audit',
    'kickstarter:page-review-intake',
    'Kickstarter page review intake',
    'kickstarter:page-review-audit',
    'Kickstarter page review audit',
    'kickstarter:prelaunch-page-pack',
    'Kickstarter pre-launch page pack',
    'kickstarter:risk-register',
    'Kickstarter risk register',
    'kickstarter:launch-signoff-audit',
    'Kickstarter launch signoff audit',
    'kickstarter:ops-refresh',
    'Kickstarter ops refresh',
    'kickstarter:launch-freeze-pack',
    'Kickstarter launch freeze pack',
    'kickstarter:launch-day-command-center',
    'Kickstarter launch-day command center',
    'launch:review-pack',
    'Launch review pack',
    'kickstarter:rehearsal-pack',
    'Kickstarter rehearsal pack',
    'kickstarter:proof-shot-intake',
    'Kickstarter proof-shot intake',
    'kickstarter:proof-shot-audit',
    'Kickstarter proof-shot audit',
    'launch:operator-pack',
    'Launch operator pack',
    'Launch action plan',
    'launch:evidence:audit:strict',
    'local analyzer reports passing required `gate_checks`',
    'boundary artifacts',
    'checked the `V1 Launch Chain` panel',
    'edited review body is rendered into projection',
    'dismissed meeting risk is excluded',
    'Kickstarter campaign claim verification',
    'Android/Paper asset verification',
    'Android APK build',
    'InkLoopRuntime',
    'Obsidian V1 plugin verification',
    'Obsidian demo vault',
    'temp vault',
    'legacy syncEndpoint',
    'demo-runbook.md: required local state uses `npm run verify`',
  ]);
  requireIncludes(`${projectRoot}/campaign/README.md`, [
    'kickstarter:rehearsal-pack',
    'Kickstarter rehearsal pack',
    'kickstarter:claim-downgrade',
    'Kickstarter claim downgrade pack',
    'kickstarter:public-copy-lock',
    'Kickstarter public copy lock',
    'kickstarter:supplier-quote-audit',
    'Kickstarter supplier quote audit',
    'kickstarter:page-review-audit',
    'Kickstarter page review audit',
    'kickstarter:prelaunch-page-pack',
    'Kickstarter pre-launch page pack',
    'kickstarter:risk-register',
    'Kickstarter risk register',
    'kickstarter:ops-refresh',
    'Kickstarter ops refresh',
    'kickstarter:launch-freeze-pack',
    'Kickstarter launch freeze pack',
    'kickstarter:launch-day-command-center',
    'Kickstarter launch-day command center',
    'launch-day comms pack',
    'kickstarter:proof-shot-intake',
    'Kickstarter proof-shot intake',
    'kickstarter:proof-shot-audit',
    'Kickstarter proof-shot audit',
    'not publish approval',
  ]);
  requireIncludes(`${projectRoot}/evidence/README.md`, [
    'RawPenFrame ingress bridge source',
    'M103 socket RawPenFrame adapter source',
    'Android/Paper same-LAN import bridge source',
    'window.InkLoopM103RawPenCapture.exportJsonl()',
    'Evidence Record Writeback Safety',
    'controlled writeback path, not an approval shortcut',
    'ready_to_update_record',
    'blocked_do_not_update_record',
    'dry-run only',
    'launch:evidence:apply-record-updates:write',
    'but it never writes `Decision`',
    'A human reviewer must manually set `Decision` to Pass, Conditional pass, or Fail',
    'keep strict gates red until all launch evidence is real and approved',
    'kickstarter:rehearsal-pack',
    'test-results/ai-pen-kickstarter-rehearsal',
    'kickstarter:proof-shot-intake',
    'test-results/ai-pen-kickstarter-proof-shot-intake',
    'kickstarter:proof-shot-audit',
    'test-results/ai-pen-kickstarter-proof-shot-audit',
    'not publish approval',
    'launch:evidence:intake-audit',
    'test-results/ai-pen-launch-evidence-intake-audit',
    'launch:evidence:apply-record-updates',
    'test-results/ai-pen-launch-evidence-record-apply',
    'launch:critical-path',
    'test-results/ai-pen-kickstarter-critical-path',
    'launch:weekly-sprint',
    'test-results/ai-pen-kickstarter-weekly-sprint',
    'launch:kpi-dashboard',
    'test-results/ai-pen-launch-kpi-dashboard',
    'kickstarter:claim-downgrade',
    'test-results/ai-pen-kickstarter-claim-downgrade',
    'kickstarter:public-copy-lock',
    'test-results/ai-pen-kickstarter-public-copy-lock',
    'kickstarter:supplier-quote-intake',
    'test-results/ai-pen-kickstarter-supplier-quote-intake',
    'kickstarter:supplier-quote-audit',
    'test-results/ai-pen-kickstarter-supplier-quote-audit',
    'kickstarter:page-review-intake',
    'test-results/ai-pen-kickstarter-page-review-intake',
    'kickstarter:page-review-audit',
    'test-results/ai-pen-kickstarter-page-review-audit',
    'kickstarter:prelaunch-page-pack',
    'test-results/ai-pen-kickstarter-prelaunch-page',
    'kickstarter:risk-register',
    'test-results/ai-pen-kickstarter-risk-register',
    'kickstarter:launch-signoff-audit',
    'test-results/ai-pen-kickstarter-launch-signoff-audit',
    'kickstarter:ops-refresh',
    'test-results/ai-pen-kickstarter-ops-refresh',
    'kickstarter:launch-freeze-pack',
    'test-results/ai-pen-kickstarter-launch-freeze',
    'kickstarter:launch-day-command-center',
    'test-results/ai-pen-kickstarter-launch-day-command-center',
    'launch-day comms pack',
    'launch:operator-pack',
    'test-results/ai-pen-launch-operator-pack',
  ]);
  requireIncludes(`${projectRoot}/implementation-alignment.md`, [
    'AiGraphJob',
    'validateAiGraphJob',
    'AI graph job contract',
    'explicit sidecar runtime sync while excluding arbitrary Markdown/PDF reverse parsing',
    'settings-page V1 boundary panel with `Launch Ops Queue: 86 P0 inputs`',
    'InkLoop Paper local-first runtime reuse',
    'temp vault installer smoke verifies V1 settings and legacy syncEndpoint migration',
    'in-APK `InkLoopRuntime` demo-loop manifest',
    'launch-freeze Go/No-Go boundary',
  ]);
}

function verifyActiveReviewDocs() {
  const reviewFile = 'docs/reviews/2026-07-02-updated-ai-annotation-demo-architecture-gap-review.md';
  requireIncludes(reviewFile, [
    'updated for InkLoop AI Pen Kickstarter V1',
    'The repo is no longer positioned as only an SDK workspace example',
    'Runtime Sync is canonical',
    'Android/Paper asset verifier',
    '238 tests',
  ]);
  requireNotIncludes(reviewFile, [
    'The updated demo is now the SDK workspace example',
    'The verified test surface includes 220 demo tests',
    'The demo does not yet use that as the canonical transport',
    'Android build, OCR/HWR bridge behavior, e-paper refresh constraints, and latency/performance budgets are not part of the current automated verification',
    'Gap: map panel vault release to the sync-client model',
    'Gap: file-sidecar and IndexedDB offline stores need to become the default runtime state backing',
  ]);
}

function verifyProjectMarkdownStaleness() {
  for (const file of walkMarkdownFiles(projectRoot)) {
    const text = readText(file);
    if (text.includes('63 tests')) fail(`${file} still references stale 63-test count`);
    if (text.includes('AI Pen V1 smoke passed') && !text.includes('evidence analyzer smokes')) {
      fail(`${file} references AI Pen V1 smoke without analyzer smokes`);
    }
  }
  note('project markdown has no known stale verification text');
}

verifySourcePackage();
verifySourceMeetingBoundaries();
verifyRequiredProjectFiles();
verifyV1DemoHandoff();
verifyCampaignMeetingBoundaries();
verifyCodeMeetingBoundaries();
verifyLaunchEvidenceMeetingBoundaries();
verifyEntrypointBoundaries();
verifyLegacyProjectBoundary();
verifyEvidenceAnalyzers();
verifyPackageScripts();
verifyDocumentedNpmScripts();
verifyRunbookAndAuditText();
verifyActiveReviewDocs();
verifyProjectMarkdownStaleness();
verifyRelativeLinks(projectRoot);

if (failures.length > 0) {
  console.error('AI Pen Kickstarter V1 verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('AI Pen Kickstarter V1 verification passed:');
for (const message of checked) console.log(`- ${message}`);
