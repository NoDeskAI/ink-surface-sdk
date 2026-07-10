import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const defaultBaseDir = 'test-results/ai-pen-kickstarter-proof-shot-intake';
const outDir = 'test-results/ai-pen-kickstarter-proof-shot-audit';
const outJsonPath = `${outDir}/report.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

function parseArgs(argv) {
  const options = { intake: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--strict') continue;
    if (arg === '--intake') {
      options.intake = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function latestIntakeDir() {
  const basePath = absolute(defaultBaseDir);
  if (!existsSync(basePath)) return null;
  const dirs = readdirSync(basePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = `${defaultBaseDir}/${entry.name}`;
      const manifestPath = `${dir}/manifest.json`;
      if (!existsSync(absolute(manifestPath))) return null;
      const manifest = readJson(manifestPath);
      const generatedAt = Date.parse(manifest.generated_at ?? '');
      return {
        dir,
        generatedAt: Number.isNaN(generatedAt) ? 0 : generatedAt,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.generatedAt - b.generatedAt || a.dir.localeCompare(b.dir));
  return dirs.at(-1)?.dir ?? null;
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(absolute(relativePath), 'utf8'));
}

function normalizeRef(value) {
  return String(value ?? '')
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/^`|`$/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function isPlaceholder(value) {
  const normalized = normalizeRef(value);
  return (
    !normalized ||
    /^TBD$/i.test(normalized) ||
    /^0$/i.test(normalized) ||
    /^none$/i.test(normalized) ||
    /^n\/a$/i.test(normalized) ||
    /^not\s+(run|ready|reviewed|available)$/i.test(normalized) ||
    /\bTBD\b/i.test(normalized)
  );
}

function isYes(value) {
  return /^(yes|true|pass|approved)$/i.test(normalizeRef(value));
}

function isApproved(value) {
  return /^(yes|true|pass|approved|conditional pass|conditional-pass|downgraded)$/i.test(normalizeRef(value));
}

function isUsableArtifact(value, baseDir) {
  const normalized = normalizeRef(value);
  if (isPlaceholder(normalized)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return true;
  if (/^(feishu|lark|obsidian|inkloop):/i.test(normalized)) return true;
  if (path.isAbsolute(normalized)) return existsSync(normalized);
  return existsSync(absolute(path.join(baseDir, normalized))) || existsSync(absolute(normalized));
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function readCsv(relativePath) {
  const fullPath = absolute(relativePath);
  if (!existsSync(fullPath)) return { rows: [], error: `missing CSV: ${relativePath}` };
  const lines = readFileSync(fullPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length === 0) return { rows: [], error: `empty CSV: ${relativePath}` };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
  return { rows, error: null };
}

function requiredShotFields(check) {
  const common = ['clip_path', 'approved_for_public', 'reviewer'];
  if (check === 'Shows Capture Surface requirement clearly') return [...common, 'capture_surface_visible'];
  if (check === 'Shows real pen writing, not only UI mock') return [...common, 'ai_pen_visible'];
  if (check === 'Shows Live Board timing without speed-up deception') return [...common, 'live_board_visible', 'real_time_or_disclosed'];
  if (check === 'Shows user review step for AI output') return [...common, 'review_ui_visible'];
  if (check === 'Mentions risks/limits in page or video') return [...common, 'risks_or_limits_visible'];
  if (check === 'Avoids unsupported claims') return ['claim_review_decision', 'reviewer'];
  return common;
}

function evaluateShot(shot, intakeDir) {
  const relativeShotDir = shot.folder.startsWith(intakeDir) ? shot.folder : path.join(intakeDir, path.basename(shot.folder));
  const shotLogPath = `${relativeShotDir}/raw/shot-log.csv`;
  const claimReviewPath = `${relativeShotDir}/raw/claim-review.csv`;
  const shotLog = readCsv(shotLogPath);
  const claimReview = readCsv(claimReviewPath);
  const blockers = [];
  const checks = [];

  if (shotLog.error) blockers.push(shotLog.error);
  if (claimReview.error) blockers.push(claimReview.error);

  const shotRows = shotLog.rows;
  const claimRows = claimReview.rows;
  const usableShotRows = shotRows.filter((row) => isUsableArtifact(row.clip_path, relativeShotDir));
  const publicApprovedRows = usableShotRows.filter((row) => isApproved(row.approved_for_public));
  const claimApprovedRows = claimRows.filter((row) => isApproved(row.decision) && isUsableArtifact(row.artifact_path, relativeShotDir));
  const requiredFields = requiredShotFields(shot.check);

  checks.push({
    label: 'has usable clip path',
    passed: usableShotRows.length > 0,
    detail: `${usableShotRows.length}/${shotRows.length} usable shot-log rows`,
  });
  checks.push({
    label: 'public approval is recorded',
    passed: publicApprovedRows.length > 0,
    detail: `${publicApprovedRows.length}/${usableShotRows.length} usable rows approved`,
  });
  checks.push({
    label: 'claim review is approved or downgraded',
    passed: claimApprovedRows.length > 0,
    detail: `${claimApprovedRows.length}/${claimRows.length} claim-review rows approved or downgraded`,
  });

  for (const field of requiredFields) {
    const rows = field === 'claim_review_decision' ? claimRows : usableShotRows;
    const passed =
      field === 'claim_review_decision'
        ? rows.some((row) => isApproved(row.decision))
        : field === 'clip_path'
          ? usableShotRows.length > 0
          : field === 'approved_for_public'
            ? rows.some((row) => isApproved(row.approved_for_public))
            : rows.some((row) => isYes(row[field]));
    checks.push({
      label: `required field ${field}`,
      passed,
      detail: passed ? 'present and passing' : 'missing, TBD, or not approved',
    });
  }

  for (const check of checks) {
    if (!check.passed) blockers.push(check.label);
  }

  return {
    id: shot.id,
    check: shot.check,
    gate: shot.gate,
    evidence_record: shot.evidence_record,
    folder: relativeShotDir,
    status: blockers.length === 0 ? 'final_cut_ready' : 'not_final_cut_ready',
    shot_log_path: shotLogPath,
    claim_review_path: claimReviewPath,
    shot_rows: shotRows.length,
    claim_review_rows: claimRows.length,
    usable_clip_rows: usableShotRows.length,
    public_approved_rows: publicApprovedRows.length,
    claim_approved_rows: claimApprovedRows.length,
    checks,
    blockers,
  };
}

function readme(report) {
  const rows = report.shots
    .map(
      (shot) =>
        `| ${shot.id} | ${shot.check} | ${shot.status} | ${shot.usable_clip_rows}/${shot.shot_rows} | ${shot.public_approved_rows} | ${shot.claim_approved_rows}/${shot.claim_review_rows} | \`${shot.folder}\` |`,
    )
    .join('\n');
  const blockers = report.shots
    .filter((shot) => shot.blockers.length)
    .map((shot) => `## ${shot.id} ${shot.check}\n\n${shot.blockers.map((blocker) => `- ${blocker}`).join('\n')}`)
    .join('\n\n');
  return `# InkLoop AI Pen Kickstarter Proof-Shot Audit

Schema: \`inkloop.kickstarter_proof_shot_audit.v1\`

Generated at: ${report.generated_at}

Status: ${report.status}

Intake: \`${report.intake_dir}\`

This audit checks whether the Kickstarter video proof-shot intake contains usable clips, public approval decisions, and claim-review decisions. It does not replace the launch evidence audit, legal review, privacy review, or Kickstarter preview review.

## Shot Summary

| Shot | Final Cut Check | Status | Usable Clips | Public Approvals | Claim Reviews | Folder |
| --- | --- | --- | ---: | ---: | ---: | --- |
${rows}

## Blockers

${blockers || '- None'}

Detailed JSON: [report.json](./report.json)
`;
}

const options = parseArgs(process.argv.slice(2));
const intakeDir = options.intake ?? latestIntakeDir();
if (!intakeDir) throw new Error(`no proof-shot intake directory found under ${defaultBaseDir}`);
const manifestPath = `${intakeDir}/manifest.json`;
if (!existsSync(absolute(manifestPath))) throw new Error(`missing proof-shot intake manifest: ${manifestPath}`);

const manifest = readJson(manifestPath);
const shots = (manifest.shots ?? []).map((shot) => evaluateShot(shot, intakeDir));
const notReady = shots.filter((shot) => shot.status !== 'final_cut_ready');
const report = {
  schema: 'inkloop.kickstarter_proof_shot_audit.v1',
  generated_at: new Date().toISOString(),
  strict,
  intake_dir: intakeDir,
  status: notReady.length === 0 ? 'final_cut_ready' : 'not_final_cut_ready',
  summary: {
    shot_count: shots.length,
    ready_shot_count: shots.length - notReady.length,
    not_ready_shot_count: notReady.length,
    blocker_count: shots.reduce((sum, shot) => sum + shot.blockers.length, 0),
  },
  non_claims: [
    'Passing this audit only means proof-shot intake rows look ready for review.',
    'It does not replace launch evidence audit strict mode, legal/privacy review, or Kickstarter preview review.',
    'Template rows with TBD are expected to fail until real filming artifacts are added.',
  ],
  shots,
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Kickstarter proof-shot audit status: ${report.status}`);
console.log(`Shots: ${report.summary.ready_shot_count}/${report.summary.shot_count} final-cut ready`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status !== 'final_cut_ready') {
  console.error('Strict Kickstarter proof-shot audit failed: final-cut proof-shot evidence is incomplete.');
  process.exit(1);
}
