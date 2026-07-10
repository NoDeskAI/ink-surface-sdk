import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const defaultRunId = new Date().toISOString().slice(0, 10);
const videoScriptPath = 'docs/project/inkloop-ai-pen-kickstarter/campaign/campaign-video-script.md';

function parseArgs(argv) {
  const options = {
    runId: defaultRunId,
    outDir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run-id') {
      options.runId = argv[index + 1];
      index += 1;
    } else if (arg === '--out') {
      options.outDir = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.runId) throw new Error('--run-id requires a value');
  options.outDir ??= `test-results/ai-pen-kickstarter-proof-shot-intake/${options.runId}`;
  return options;
}

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function write(relativePath, content) {
  const fullPath = absolute(relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${content.trimEnd()}\n`);
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function extractFinalCutChecks(text) {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+Final Cut Checklist\s*$/i.test(line.trim()));
  if (headingIndex === -1) return [];
  const tableLines = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    if (!line.trim().startsWith('|')) continue;
    tableLines.push(line.trim());
  }
  return tableLines
    .filter((line) => !/^\|\s*[-:]+\s*\|/.test(line))
    .map((line) => {
      const cells = line
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean);
      return cells[0];
    })
    .filter((check) => check && !/^check$/i.test(check));
}

const shotMeta = {
  'Shows Capture Surface requirement clearly': {
    gate: 'G-SURF-1',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/capture-surface-calibration-report.md',
    scenario: 'education + meeting',
    requiredArtifacts: ['wide shot of board with Capture Surface mounted', 'close shot showing writing on Capture Surface', 'calibration photo/video'],
    publicPassCriteria: 'Viewer can tell the Capture Surface is required and mounted before any accuracy claim is made.',
  },
  'Shows real pen writing, not only UI mock': {
    gate: 'G-HW-1',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/hardware-prototype-run-log.md',
    scenario: 'education + meeting',
    requiredArtifacts: ['raw pen writing clip', 'host receive/log clip or screen recording', 'raw AI Pen run JSONL path'],
    publicPassCriteria: 'Clip shows real dry-erase writing and a real AI Pen/prototype path, not only UI animation.',
  },
  'Shows Live Board timing without speed-up deception': {
    gate: 'G-LIVE-1',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/live-board-latency-report.md',
    scenario: 'education + meeting',
    requiredArtifacts: ['single-take pen plus Live Board video', 'timing CSV', 'latency analyzer JSON'],
    publicPassCriteria: 'Live Board timing is shown in real time or clearly labeled; no speed-up is used to imply lower latency.',
  },
  'Shows user review step for AI output': {
    gate: 'G-EDU-1 / G-MTG-1',
    record:
      'docs/project/inkloop-ai-pen-kickstarter/evidence/education-demo-review.md and docs/project/inkloop-ai-pen-kickstarter/evidence/business-meeting-demo-review.md',
    scenario: 'education + meeting',
    requiredArtifacts: ['accept/edit/dismiss screen recording', 'reviewer CSV', 'exported lesson note or meeting output'],
    publicPassCriteria: 'Viewer sees AI output is reviewed before export and not treated as final truth.',
  },
  'Mentions risks/limits in page or video': {
    gate: 'G-PAGE-1',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/kickstarter-page-risk-checklist.md',
    scenario: 'campaign',
    requiredArtifacts: ['page risk section screenshot', 'video/audio line mentioning limits', 'legal/privacy review note'],
    publicPassCriteria: 'Prototype status, Capture Surface requirement, AI limitations, and delivery risks are visible or spoken.',
  },
  'Avoids unsupported claims': {
    gate: 'G-PAGE-1',
    record: 'docs/project/inkloop-ai-pen-kickstarter/campaign/claim-evidence-matrix.md',
    scenario: 'campaign',
    requiredArtifacts: ['claim review CSV', 'script final transcript', 'verify:kickstarter-claims output'],
    publicPassCriteria: 'No unsupported claim remains in voiceover, captions, page copy, or FAQ.',
  },
};

function shotReadme(shot, outDir) {
  const artifacts = shot.requiredArtifacts.map((item) => `- ${item}`).join('\n');
  return `# ${shot.id} ${shot.check}

Gate: ${shot.gate}

Evidence record: \`${shot.record}\`

Scenario: ${shot.scenario}

## Required Artifacts

${artifacts}

## Public Pass Criteria

${shot.publicPassCriteria}

## Capture Rules

- Keep source video, audio, screenshots, or exports under \`${outDir}/${shot.folder}/artifacts/\`.
- Put raw logs, timing CSVs, reviewer CSVs, transcripts, or claim review CSVs under \`${outDir}/${shot.folder}/raw/\`.
- Put analyzer reports or review summaries under \`${outDir}/${shot.folder}/reports/\`.
- Fill \`raw/shot-log.csv\` for every take that may enter the campaign video.
- Do not use this shot publicly until the matching evidence record links the real artifact and the reviewer decision is pass or conditional-pass.
`;
}

function rootReadme({ outDir, generatedAt, shots }) {
  const rows = shots
    .map((shot) => `| ${shot.id} | ${shot.check} | ${shot.gate} | \`${shot.folder}/README.md\` | \`${shot.record}\` |`)
    .join('\n');
  return `# InkLoop AI Pen Kickstarter Proof-Shot Intake

Schema: \`inkloop.kickstarter_proof_shot_intake.v1\`

Generated at: ${generatedAt}

Kickstarter proof-shot intake is not publish approval. This package is the field checklist for filming or recording the proof shots required before the campaign video can move from draft to final cut.

## Shot Folders

| Shot | Final Cut Check | Gate | Intake Folder | Evidence Record |
| --- | --- | --- | --- | --- |
${rows}

## Capture Workflow

1. Run \`npm run verify:local-demo-handoff\` before filming to refresh local demo assets.
2. Run \`npm run kickstarter:rehearsal-pack\` and keep it open as the run-of-show.
3. Capture every proof shot as a real take, not a mock-only screen recording.
4. Put raw takes, source files, logs, exports, and review notes into the matching shot folder.
5. Update the linked evidence record with resolved paths and decisions.
6. Run \`npm run kickstarter:proof-shot-audit\` to check shot logs, public approvals, and claim-review decisions.
7. Run \`npm run launch:evidence:audit\`, \`npm run launch:review-pack\`, and \`npm run kickstarter:rehearsal-pack\`.
8. Keep \`npm run launch:evidence:audit:strict\` failing until all real launch gates have proof.

## Required Claim Guard

Run \`npm run verify:kickstarter-claims\` before copying any final-cut script, subtitle, page text, or FAQ into a public artifact.
`;
}

function manifest({ outDir, generatedAt, shots }) {
  return {
    schema: 'inkloop.kickstarter_proof_shot_intake.v1',
    generated_at: generatedAt,
    out_dir: outDir,
    source_video_script: videoScriptPath,
    non_claims: [
      'Kickstarter proof-shot intake is not publish approval.',
      'A shot folder is not launch evidence until it contains real artifacts and the matching evidence record links them.',
      'Final-cut video and page copy still require claim review and strict launch evidence audit.',
    ],
    required_commands: [
      'npm run verify:local-demo-handoff',
      'npm run kickstarter:rehearsal-pack',
      'npm run verify:kickstarter-claims',
      'npm run kickstarter:proof-shot-audit',
      'npm run launch:evidence:audit',
      'npm run launch:review-pack',
      'npm run launch:evidence:audit:strict',
    ],
    shots: shots.map((shot) => ({
      id: shot.id,
      check: shot.check,
      folder: `${outDir}/${shot.folder}`,
      gate: shot.gate,
      evidence_record: shot.record,
      required_artifacts: shot.requiredArtifacts,
      public_pass_criteria: shot.publicPassCriteria,
    })),
  };
}

function templateShotLog(shot) {
  return [
    'shot_id,take_id,date,location,operator,scenario,clip_path,start_timecode,end_timecode,source_audio_ok,ai_pen_visible,capture_surface_visible,live_board_visible,real_time_or_disclosed,review_ui_visible,risks_or_limits_visible,approved_for_public,reviewer,notes',
    `${shot.id},take_001,YYYY-MM-DD,TBD,TBD,${shot.scenario},artifacts/TBD.mov,00:00:00,00:00:00,TBD,TBD,TBD,TBD,TBD,TBD,TBD,TBD,TBD,TBD`,
  ].join('\n');
}

function templateClaimReview(shot) {
  return [
    'shot_id,claim_or_line,artifact_path,evidence_record,decision,downgraded_copy,reviewer,notes',
    `${shot.id},TBD,artifacts/TBD.mov,${shot.record},Not reviewed,TBD,TBD,TBD`,
  ].join('\n');
}

const { outDir } = parseArgs(process.argv.slice(2));
const generatedAt = new Date().toISOString();
const videoScript = readFileSync(absolute(videoScriptPath), 'utf8');
const checks = extractFinalCutChecks(videoScript);
if (checks.length === 0) throw new Error(`no final cut proof-shot checks found in ${videoScriptPath}`);

const shots = checks.map((check, index) => {
  const meta = shotMeta[check];
  if (!meta) throw new Error(`missing proof-shot metadata for final cut check: ${check}`);
  return {
    id: `S${String(index + 1).padStart(2, '0')}`,
    check,
    folder: `${String(index + 1).padStart(2, '0')}-${slug(check)}`,
    ...meta,
  };
});

for (const shot of shots) {
  for (const dir of ['raw', 'reports', 'artifacts']) {
    mkdirSync(absolute(`${outDir}/${shot.folder}/${dir}`), { recursive: true });
  }
  write(`${outDir}/${shot.folder}/README.md`, shotReadme(shot, outDir));
  write(`${outDir}/${shot.folder}/raw/shot-log.csv`, templateShotLog(shot));
  write(`${outDir}/${shot.folder}/raw/claim-review.csv`, templateClaimReview(shot));
}

write(`${outDir}/README.md`, rootReadme({ outDir, generatedAt, shots }));
write(`${outDir}/manifest.json`, JSON.stringify(manifest({ outDir, generatedAt, shots }), null, 2));

console.log(`Kickstarter proof-shot intake package created: ${outDir}`);
console.log(`Proof shots: ${shots.length}`);
console.log(`README: ${outDir}/README.md`);
