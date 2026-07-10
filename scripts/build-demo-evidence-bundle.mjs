import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'test-results/ai-pen-demo-evidence');
const manifestPath = path.join(outDir, 'manifest.json');
const readmePath = path.join(outDir, 'README.md');
const failures = [];

function relative(absolutePath) {
  return path.relative(root, absolutePath);
}

function absolute(relativePath) {
  return path.join(root, relativePath);
}

function fail(message) {
  failures.push(message);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(absolute(relativePath), 'utf8'));
}

function requireText(relativePath, needles) {
  const filePath = absolute(relativePath);
  if (!existsSync(filePath)) {
    fail(`missing text evidence file: ${relativePath}`);
    return;
  }
  const text = readFileSync(filePath, 'utf8');
  for (const needle of needles) {
    if (!text.includes(needle)) fail(`${relativePath} missing required text: ${needle}`);
  }
}

function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function artifact(relativePath, label, required = true) {
  const filePath = absolute(relativePath);
  if (!existsSync(filePath)) {
    if (required) fail(`missing ${label}: ${relativePath}`);
    return { label, path: relativePath, exists: false };
  }
  const stats = statSync(filePath);
  return {
    label,
    path: relativePath,
    exists: true,
    size_bytes: stats.size,
    sha256: stats.isFile() ? sha256(filePath) : null,
    updated_at: stats.mtime.toISOString(),
  };
}

function sourcePackageFiles() {
  const sourceDir = absolute('docs/project/inkloop-ai-pen-kickstarter/source');
  if (!existsSync(sourceDir)) {
    fail('missing source package directory');
    return [];
  }
  return readdirSync(sourceDir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => `docs/project/inkloop-ai-pen-kickstarter/source/${file}`);
}

const browserSmokePath = 'test-results/ai-pen-browser-smoke/result.json';
const aiGraphWorkerPath = 'test-results/ai-graph-worker-smoke/worker-report.json';
const obsidianDemoVaultManifestPath = 'test-results/obsidian-demo-vault/manifest.json';
const opsRefreshPath = 'test-results/ai-pen-kickstarter-ops-refresh/ops-refresh.json';
const prelaunchPagePath = 'test-results/ai-pen-kickstarter-prelaunch-page/prelaunch-page.json';
const operatorPackPath = 'test-results/ai-pen-launch-operator-pack/operator-pack.json';
const requiredBrowserChecks = [
  'RawPenFrame JSONL import -> InkEvents -> AI Graph Job -> LessonGraph',
  'InkLoopRawPen browser/native bridge -> InkEvents -> AI Graph Job -> LessonGraph',
  'AI Graph Job queue completes before KnowledgeObject review',
  'Education Run Demo -> Generate AI -> Accept/Edit -> Obsidian projection',
  'Meeting Run Demo -> Generate AI -> Accept/Edit/Dismiss -> Obsidian projection',
  'Meeting action keeps board/ink evidence as required proof while retaining audio context only as optional context',
  'SourceRefs validator visible in both scenarios',
  'V1 Launch Chain panel keeps product chain, source file unit, launch operations queue, pre-launch page, and launch-freeze Go/No-Go boundaries visible',
];
let browserSmoke = null;
if (existsSync(absolute(browserSmokePath))) {
  browserSmoke = readJson(browserSmokePath);
  if (browserSmoke.ok !== true) fail('browser smoke result is not ok');
  const browserChecks = new Set(browserSmoke.checked ?? []);
  for (const requiredCheck of requiredBrowserChecks) {
    if (!browserChecks.has(requiredCheck)) fail(`browser smoke missing required checked item: ${requiredCheck}`);
  }
  for (const [name, screenshotPath] of Object.entries(browserSmoke.screenshots ?? {})) {
    if (!existsSync(screenshotPath)) fail(`browser smoke screenshot missing for ${name}: ${screenshotPath}`);
  }
} else {
  fail(`missing browser smoke result: ${browserSmokePath}`);
}

let aiGraphWorker = null;
if (existsSync(absolute(aiGraphWorkerPath))) {
  aiGraphWorker = readJson(aiGraphWorkerPath);
  if (aiGraphWorker.ok !== true) fail('AI graph worker smoke result is not ok');
  if (aiGraphWorker.summary?.completed_jobs < 3) fail('AI graph worker smoke did not complete enough jobs');
  if (aiGraphWorker.summary?.retried_jobs < 1) fail('AI graph worker smoke did not exercise retry telemetry');
  if (aiGraphWorker.summary?.rejected_jobs < 1) fail('AI graph worker smoke did not reject invalid evidence-less jobs');
} else {
  fail(`missing AI graph worker smoke result: ${aiGraphWorkerPath}`);
}

let obsidianDemoVault = null;
const requiredProjectionKinds = ['reading_note', 'highlight', 'annotation', 'meeting_decision', 'meeting_risk'];
if (existsSync(absolute(obsidianDemoVaultManifestPath))) {
  obsidianDemoVault = readJson(obsidianDemoVaultManifestPath);
  if (obsidianDemoVault.status !== 'ready') fail('Obsidian demo vault is not ready');
  for (const kind of requiredProjectionKinds) {
    if (!obsidianDemoVault.required_projection_kinds?.includes(kind)) {
      fail(`Obsidian demo vault missing required projection kind: ${kind}`);
    }
  }
  if ((obsidianDemoVault.reading_projection_object_count ?? 0) < 3) {
    fail('Obsidian demo vault does not include reading note, highlight, and handwritten annotation projection objects');
  }
  if ((obsidianDemoVault.meeting_object_count ?? 0) < 4) {
    fail('Obsidian demo vault does not include Decision, Action, Risk, and Diagram meeting projection objects');
  }
} else {
  fail(`missing Obsidian demo vault manifest: ${obsidianDemoVaultManifestPath}`);
}

let opsRefresh = null;
if (existsSync(absolute(opsRefreshPath))) {
  opsRefresh = readJson(opsRefreshPath);
  if (!opsRefresh.status) fail('Kickstarter ops refresh is missing status');
  if (!Array.isArray(opsRefresh.sources_data?.launch_operations_queue)) fail('Kickstarter ops refresh is missing launch operations queue');
  if (!Array.isArray(opsRefresh.sources_data?.launch_operations_domain_summary)) fail('Kickstarter ops refresh is missing launch operations domain summary');
} else {
  fail(`missing Kickstarter ops refresh result: ${opsRefreshPath}`);
}

let prelaunchPage = null;
if (existsSync(absolute(prelaunchPagePath))) {
  prelaunchPage = readJson(prelaunchPagePath);
  if (!prelaunchPage.status) fail('Kickstarter pre-launch page pack is missing status');
} else {
  fail(`missing Kickstarter pre-launch page result: ${prelaunchPagePath}`);
}

let operatorPack = null;
if (existsSync(absolute(operatorPackPath))) {
  operatorPack = readJson(operatorPackPath);
  if (!operatorPack.status) fail('Launch operator pack is missing status');
  if (!operatorPack.prelaunch_work_order?.status) fail('Launch operator pack is missing Pre-Launch / Notify me work order status');
} else {
  fail(`missing Launch operator pack result: ${operatorPackPath}`);
}

const packageJson = readJson('package.json');
for (const [scriptName, expected] of Object.entries({
  'verify:local-demo-handoff':
    'npm run demo:smoke:runtime-sync && npm run demo:smoke:ai-pen && npm run demo:smoke:ai-graph-worker && npm run android:assemble:debug && npm run obsidian:demo-vault && npm run kickstarter:ops-refresh && npm run demo:evidence:bundle',
  verify: 'npm run check && npm run lint:ci',
  'demo:smoke:ai-pen': 'npm --workspace ./examples/ai-annotation-demo run smoke:ai-pen-browser',
  'demo:smoke:runtime-sync': 'npm --workspace ./examples/ai-annotation-demo run smoke:runtime-sync-flow',
  'android:assemble:debug': 'node scripts/assemble-android-paper-debug.mjs',
  'obsidian:smoke': 'npm run build && npm run verify:obsidian-v1-plugin',
  'obsidian:demo-vault': 'node scripts/create-obsidian-demo-vault.mjs',
})) {
  const script = packageJson.scripts?.[scriptName] ?? '';
  if (!script.includes(expected)) fail(`package.json script ${scriptName} does not include expected command: ${expected}`);
}

for (const file of [
  'plugins/obsidian/inkloop-sync/main.js',
  'dist/obsidian-plugin/inkloop-sync/main.js',
  'test-results/obsidian-demo-vault/.obsidian/plugins/inkloop-sync/main.js',
]) {
  requireText(file, [
    'Meeting Event Marks',
    'board/ink evidence required; audio/subtitles/timeline optional context',
    'Meeting actions, decisions, risks, and diagrams require board/ink evidence',
  ]);
}

const screenshotArtifacts = [];
for (const [name, screenshotPath] of Object.entries(browserSmoke?.screenshots ?? {})) {
  screenshotArtifacts.push(artifact(relative(screenshotPath), `${name} projection screenshot`));
}

const artifacts = [
  artifact(browserSmokePath, 'AI Pen browser smoke result'),
  artifact(aiGraphWorkerPath, 'AI Graph worker smoke report'),
  artifact('test-results/ai-graph-worker-smoke/jobs.completed.jsonl', 'AI Graph worker completed jobs'),
  artifact('test-results/ai-graph-worker-smoke/jobs.rejected.jsonl', 'AI Graph worker rejected jobs'),
  ...screenshotArtifacts,
  artifact('examples/ai-annotation-demo/src/capture/raw-pen-stream.ts', 'RawPenFrame hardware ingress bridge'),
  artifact('examples/ai-annotation-demo/src/capture/m103-raw-pen-adapter.ts', 'M103 socket RawPenFrame adapter'),
  artifact('examples/ai-annotation-demo/android/app/build/outputs/apk/debug/app-debug.apk', 'Android/Paper debug APK'),
  artifact('examples/ai-annotation-demo/android/app/src/main/java/com/example/hmpocrpoc/InkLoopLanImportBridge.kt', 'Android/Paper same-LAN document import bridge'),
  artifact('examples/ai-annotation-demo/android/app/src/main/java/com/example/hmpocrpoc/InkLoopRuntimeBridge.kt', 'Android/Paper InkLoopRuntime boundary bridge'),
  artifact('examples/ai-annotation-demo/mobile.html', 'Android/Paper mobile runtime boundary source'),
  artifact('examples/ai-annotation-demo/android/app/src/main/assets/mobile.html', 'Android/Paper packaged mobile runtime boundary asset'),
  artifact('dist/obsidian-plugin/inkloop-sync/manifest.json', 'Obsidian packaged manifest'),
  artifact('dist/obsidian-plugin/inkloop-sync/main.js', 'Obsidian packaged plugin'),
  artifact('dist/obsidian-plugin/inkloop-sync/main.js', 'Obsidian settings V1 boundary panel'),
  artifact('packages/adapter-obsidian/src/index.ts', 'Obsidian source file unit projection adapter'),
  artifact('test-results/obsidian-demo-vault/README.md', 'Obsidian demo vault README'),
  artifact('test-results/obsidian-demo-vault/manifest.json', 'Obsidian demo vault manifest'),
  artifact('test-results/obsidian-demo-vault/InkLoop/Reading/AI Pen Lesson Demo/AI Pen Lesson Demo.md', 'Obsidian lesson demo hub'),
  artifact('test-results/obsidian-demo-vault/InkLoop/Meetings/2026-07-03 AI Pen Meeting Demo/AI Pen Meeting Demo.md', 'Obsidian meeting demo hub'),
  artifact('test-results/ai-pen-kickstarter-ops-refresh/README.md', 'Kickstarter ops refresh README'),
  artifact(opsRefreshPath, 'Kickstarter ops refresh JSON'),
  artifact('test-results/ai-pen-kickstarter-prelaunch-page/README.md', 'Kickstarter pre-launch page README'),
  artifact(prelaunchPagePath, 'Kickstarter pre-launch page JSON'),
  artifact('test-results/ai-pen-launch-operator-pack/README.md', 'Launch operator pack README'),
  artifact(operatorPackPath, 'Launch operator pack JSON'),
  artifact('docs/project/inkloop-ai-pen-kickstarter/README.md', 'AI Pen Kickstarter project README'),
  artifact('docs/project/inkloop-ai-pen-kickstarter/v1-demo-handoff.md', 'V1 demo handoff'),
  artifact('docs/project/inkloop-ai-pen-kickstarter/demo-runbook.md', 'Demo runbook'),
  artifact('docs/project/inkloop-ai-pen-kickstarter/launch-readiness-tracker.md', 'Launch readiness tracker'),
  artifact('docs/project/inkloop-ai-pen-kickstarter/completion-audit.md', 'Completion audit'),
];

const presentationHandoff = [
  {
    step: 1,
    surface: 'Web/Desktop Capture Host',
    open: 'http://127.0.0.1:8765/ai-pen-demo.html after running npm run demo:ai-pen',
    pass_signal: 'Education and Meeting flows reach AI Graph Job completed, then accept/edit/dismiss updates the Obsidian projection preview.',
    boundary: 'Hardware-faithful simulated pen stream plus local RawPenFrame ingress bridge; real BLE/firmware ingestion still needs launch evidence.',
  },
  {
    step: 2,
    surface: 'RawPenFrame import',
    open: 'examples/ai-annotation-demo/fixtures/ai-pen-run-sample.jsonl through Import Raw Log or window.InkLoopRawPen.pushJsonl(...)',
    pass_signal: 'Imported or bridge-pushed RawPenFrame records become InkEvents and feed the same AI Graph Job -> LessonGraph or MeetingGraph path.',
    boundary: 'Fixture log and browser/native bridge prove the local ingress boundary only; attach real hardware logs to launch evidence records.',
  },
  {
    step: 3,
    surface: 'Obsidian projection',
    open: 'test-results/obsidian-demo-vault/ in Obsidian',
    pass_signal: 'Lesson and meeting hubs show source file/session unit frontmatter, accepted/edited KnowledgeObject notes, and inkloop://doc/... backlinks; dismissed meeting risk is absent.',
    boundary: 'Obsidian is projection and sidecar sync in V1, not the canonical capture truth source.',
  },
  {
    step: 4,
    surface: 'Android / InkLoop Paper',
    open: 'examples/ai-annotation-demo/android/app/build/outputs/apk/debug/app-debug.apk',
    pass_signal: 'APK loads mobile.html with InkLoopRuntime boundary text, synced Web assets, and the same-LAN InkLoopLanImport upload inbox for reader-side document import.',
    boundary: 'InkLoop Paper is runtime reuse / second product loop, not the October 2026 Kickstarter base hardware promise.',
  },
  {
    step: 5,
    surface: 'Launch boundary',
    open: 'docs/project/inkloop-ai-pen-kickstarter/launch-readiness-tracker.md',
    pass_signal: 'Pre-launch page and Launch Freeze Go/No-Go remain red until real preview/live URLs, hardware, Capture Surface, GTM, supplier, legal/privacy, proof-shot evidence, and signoff pass.',
    boundary: 'Local demo ready does not equal Kickstarter launch ready.',
  },
  {
    step: 6,
    surface: 'Launch operations queue',
    open: 'test-results/ai-pen-kickstarter-ops-refresh/README.md',
    pass_signal: 'Unified queue shows Supplier Quote, Page Review, Pre-Launch, and Launch Signoff next required inputs before the team can claim launch readiness.',
    boundary: 'The operations queue is an execution board; it does not replace real supplier, legal/privacy, GTM, or human signoff evidence.',
  },
  {
    step: 7,
    surface: 'Launch operator pack',
    open: 'test-results/ai-pen-launch-operator-pack/README.md',
    pass_signal: 'Field work orders and the Pre-Launch / Notify me work order show the exact missing inputs before real launch evidence or pre-launch traffic can move forward.',
    boundary: 'Operator pack is an execution handoff, not approval to launch or publish the pre-launch page.',
  },
];

const acceptanceSignals = [
  'Browser smoke ok=true with RawPenFrame import, InkLoopRawPen browser/native bridge, AI Graph Job, Education review, Meeting review, source_refs, source file unit boundary, launch operations queue, pre-launch page boundary, and launch-freeze boundary checks.',
  'AI Graph worker smoke ok=true with completed, retried, and rejected jobs so audio-only or evidence-less output cannot silently promote.',
  'Android/Paper debug APK and packaged mobile.html exist with the InkLoopRuntime runtime-reuse boundary, InkLoopLanImport same-LAN document inbox, and M103 hqunifiedsocket RawPenFrame adapter plus JSONL export path.',
  'Obsidian demo vault and packaged plugin exist with source file/session unit frontmatter; reading note, highlight, and handwritten annotation stay under Reading while meeting decisions and risks stay under Meetings; the V1 projection-only settings boundary; and the Meeting Event Marks board/ink evidence boundary.',
  'Kickstarter ops refresh exposes the unified launch operations queue so demo reviewers see supplier, page review, pre-launch, and signoff blockers separately from local product readiness.',
  'Launch operator pack is attached so reviewers can see field work orders, Pre-Launch / Notify me blockers, and the writeback guard for converting local demo readiness into real launch evidence.',
  'Non-claims explicitly block real-hardware, Capture Surface, supplier, GTM, and Kickstarter publish readiness claims.',
];

const manifest = {
  schema: 'inkloop.demo_evidence_bundle.v1',
  generated_at: new Date().toISOString(),
  status: failures.length === 0 ? 'local_demo_ready' : 'failed',
  scope: 'Local software demo evidence for InkLoop AI Pen Kickstarter V1, including projection, runtime, and boundary artifacts.',
  non_claims: [
    'This bundle does not prove real AI Pen BLE/firmware ingestion.',
    'This bundle proves the local RawPenFrame ingress bridge only; it does not prove a specific BLE, Serial, or firmware transport.',
    'This bundle does not prove physical Capture Surface calibration.',
    'This bundle does not prove the Kickstarter pre-launch page is published or that Notify me follower demand exists.',
    'This bundle does not prove supplier pricing, GTM demand, or Kickstarter publish readiness.',
    'Fixture-based smoke reports remain demo-only until raw real-session artifacts are attached.',
  ],
  source_package_files: sourcePackageFiles(),
  required_commands: [
    'npm run verify:local-demo-handoff',
    'npm run verify',
    'npm run demo:smoke:ai-pen',
    'npm run demo:smoke:ai-graph-worker',
    'npm run demo:smoke:runtime-sync',
    'npm run android:assemble:debug',
    'npm run obsidian:smoke',
    'npm run obsidian:demo-vault',
    'npm run kickstarter:ops-refresh',
    'npm run kickstarter:prelaunch-page-pack',
    'npm run launch:operator-pack',
  ],
  browser_smoke: {
    ok: browserSmoke?.ok === true,
    checked: browserSmoke?.checked ?? [],
    required_checks: requiredBrowserChecks,
    url: browserSmoke?.url ?? null,
  },
  ai_graph_worker_smoke: {
    ok: aiGraphWorker?.ok === true,
    summary: aiGraphWorker?.summary ?? null,
    completed_job_ids: aiGraphWorker?.completed_job_ids ?? [],
    rejected_job_ids: aiGraphWorker?.rejected_job_ids ?? [],
  },
  obsidian_demo_vault: {
    status: obsidianDemoVault?.status ?? 'missing',
    required_projection_kinds: obsidianDemoVault?.required_projection_kinds ?? [],
    reading_projection_object_count: obsidianDemoVault?.reading_projection_object_count ?? 0,
    meeting_object_count: obsidianDemoVault?.meeting_object_count ?? 0,
    excluded_outputs: obsidianDemoVault?.excluded_outputs ?? [],
  },
  launch_boundary: {
    ops_refresh_status: opsRefresh?.status ?? 'missing',
    launch_audit_status: opsRefresh?.snapshot?.launch_audit_status ?? 'missing',
    prelaunch_page_status: prelaunchPage?.status ?? opsRefresh?.snapshot?.prelaunch_page_status ?? 'missing',
    prelaunch_page_fields_ready: prelaunchPage?.summary
      ? `${prelaunchPage.summary.field_count - prelaunchPage.summary.missing_field_count}/${prelaunchPage.summary.field_count}`
      : 'missing',
    operator_pack_status: operatorPack?.status ?? opsRefresh?.snapshot?.operator_pack_status ?? 'missing',
    operator_field_work_orders: operatorPack?.field_work_orders?.length ?? opsRefresh?.snapshot?.operator_field_work_order_count ?? 'missing',
    operator_prelaunch_work_order_status: operatorPack?.prelaunch_work_order?.status ?? 'missing',
    operator_prelaunch_fields_ready: operatorPack?.snapshot?.prelaunch_page_fields_ready ?? 'missing',
    public_copy_lock_status: opsRefresh?.snapshot?.public_copy_lock_status ?? 'missing',
    launch_operations_next_required_inputs: opsRefresh?.snapshot?.launch_operations_next_required_input_count ?? 'missing',
    launch_freeze_status: opsRefresh?.snapshot?.launch_freeze_status ?? 'missing',
    launch_freeze_gates_ready: opsRefresh?.snapshot
      ? `${opsRefresh.snapshot.launch_freeze_ready_gate_count}/${opsRefresh.snapshot.launch_freeze_gate_count}`
      : 'missing',
    launch_day_command_center_status: opsRefresh?.snapshot?.launch_day_command_center_status ?? 'missing',
  },
  launch_operations_queue: {
    total_next_required_inputs: opsRefresh?.snapshot?.launch_operations_next_required_input_count ?? 0,
    domain_summary: opsRefresh?.sources_data?.launch_operations_domain_summary ?? [],
    top_queue: (opsRefresh?.sources_data?.launch_operations_queue ?? []).slice(0, 20),
  },
  presentation_handoff: presentationHandoff,
  acceptance_signals: acceptanceSignals,
  artifacts,
  failures,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const artifactRows = artifacts
  .map((item) => `| ${item.label} | \`${item.path}\` | ${item.exists ? `${item.size_bytes} bytes` : 'missing'} | ${item.sha256 ? `\`${item.sha256}\`` : ''} |`)
  .join('\n');

const checkedRows = (browserSmoke?.checked ?? [])
  .map((item) => `- ${item}`)
  .join('\n');

const handoffRows = presentationHandoff
  .map((item) => `| ${item.step} | ${item.surface} | ${item.open} | ${item.pass_signal} | ${item.boundary} |`)
  .join('\n');

const acceptanceRows = acceptanceSignals.map((item) => `- ${item}`).join('\n');
const launchBoundaryRows = Object.entries(manifest.launch_boundary)
  .map(([key, value]) => `| ${key} | ${value} |`)
  .join('\n');
const launchOperationsDomainRows = manifest.launch_operations_queue.domain_summary.length
  ? manifest.launch_operations_queue.domain_summary
      .map((item) => `| ${item.domain_label} | ${item.next_required_input_count} | ${item.p0_count} |`)
      .join('\n')
  : '| n/a | n/a | n/a |';
const launchOperationsQueueRows = manifest.launch_operations_queue.top_queue.length
  ? manifest.launch_operations_queue.top_queue
      .map((item) => `| ${item.domain_label} | ${item.id} | ${item.owner} | ${item.required_input} | ${item.next_command} |`)
      .join('\n')
  : '| n/a | n/a | n/a | n/a | n/a |';

writeFileSync(readmePath, `# InkLoop AI Pen V1 Demo Evidence Bundle

Generated at: ${manifest.generated_at}

Status: ${manifest.status}

This bundle is for local software demo handoff. It collects the current AI Pen browser smoke result, AI Graph worker smoke report, projection screenshots, Android/Paper debug APK, Android/Paper runtime boundary bridge/status assets, Obsidian packaged plugin with the V1 settings boundary panel, Kickstarter ops/pre-launch/operator boundary artifacts, and core V1 project documents.

## Launch Boundary Snapshot

| Item | Value |
| --- | --- |
${launchBoundaryRows}

## Launch Operations Queue

| Domain | Next Required Inputs | P0 Inputs |
| --- | --- | --- |
${launchOperationsDomainRows}

| Domain | ID | Owner | Required Input | Next Command |
| --- | --- | --- | --- | --- |
${launchOperationsQueueRows}

## Presentation Handoff

| Step | Surface | Open | Pass Signal | Boundary |
| ---: | --- | --- | --- | --- |
${handoffRows}

## Acceptance Signals

${acceptanceRows}

## Checked Browser Flow

${checkedRows || '- No browser smoke checks found'}

## Artifacts

| Artifact | Path | Size | SHA-256 |
| --- | --- | ---: | --- |
${artifactRows}

## Required Commands

\`\`\`bash
npm run verify:local-demo-handoff
npm run verify
npm run demo:smoke:ai-pen
npm run demo:smoke:ai-graph-worker
npm run demo:smoke:runtime-sync
npm run android:assemble:debug
npm run obsidian:smoke
npm run obsidian:demo-vault
npm run kickstarter:ops-refresh
npm run kickstarter:prelaunch-page-pack
npm run launch:operator-pack
\`\`\`

## Non-Claims

${manifest.non_claims.map((item) => `- ${item}`).join('\n')}

Detailed manifest: [manifest.json](./manifest.json)
`);

if (failures.length > 0) {
  console.error('Demo evidence bundle failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Demo evidence bundle ready: ${relative(readmePath)}`);
