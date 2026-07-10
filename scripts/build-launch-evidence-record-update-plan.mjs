import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const intakeAuditPath = 'test-results/ai-pen-launch-evidence-intake-audit/report.json';
const outDir = 'test-results/ai-pen-launch-evidence-record-update-plan';
const outJsonPath = `${outDir}/record-update-plan.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(absolute(relativePath), 'utf8'));
}

function fileExists(relativePath) {
  return Boolean(relativePath) && existsSync(absolute(relativePath));
}

function firstMatchingPath(paths, patterns) {
  return paths.find((filePath) => patterns.some((pattern) => pattern.test(filePath))) ?? null;
}

function firstPath(paths) {
  return paths.find(Boolean) ?? null;
}

function artifactFolder(gate) {
  return gate.folder ? `${gate.folder}/artifacts` : null;
}

function valueOrTarget(gate, value, fallback) {
  if (gate.status === 'ready_for_evidence_record_update') return value ?? fallback ?? 'manual review required';
  return value ? `blocked until intake ready: ${value}` : `blocked until intake ready: ${fallback ?? 'missing target'}`;
}

function analyzerStatus(gate) {
  if (!gate.analyzer_report) return gate.status === 'ready_for_evidence_record_update' ? 'manual_review_ready' : 'manual_review_blocked';
  if (gate.analyzer_report.ok_flag && gate.analyzer_report.gate_checks_passed) return 'passed';
  if (gate.analyzer_report.present) return 'failing_or_unreadable';
  return 'missing';
}

function gateFields(gate) {
  const artifacts = gate.non_template_artifact_files ?? [];
  const rawFiles = gate.non_template_raw_files ?? [];
  const reportFiles = gate.report_files ?? [];
  const expectedInput = gate.expected_input ?? firstPath(rawFiles);
  const expectedReport = gate.expected_report ?? firstPath(reportFiles);
  const folder = artifactFolder(gate);
  const video = firstMatchingPath(artifacts, [/\.(mp4|mov|m4v|webm)$/i, /video/i]);
  const replay = firstMatchingPath([...artifacts, ...rawFiles], [/replay/i, /export/i, /\.(html|json|jsonl|zip)$/i]);
  const photoVideo = firstMatchingPath(artifacts, [/\.(mp4|mov|m4v|webm|png|jpg|jpeg)$/i, /(photo|video|shot|clip)/i]);
  const review = firstMatchingPath([...artifacts, ...rawFiles], [/(review|legal|privacy|preview|claim|approval)/i, /\.(pdf|md|csv|txt)$/i]);

  const commonDecision = {
    label: 'Decision',
    value: gate.status === 'ready_for_evidence_record_update' ? 'Human reviewer must mark Pass, Conditional pass, or Fail' : 'Do not change decision while intake is blocked',
    source: 'human decision required',
  };

  if (gate.id === 'G-HW-1') {
    return [
      { label: 'Raw log path', value: valueOrTarget(gate, expectedInput, `${gate.folder}/raw/raw-pen-run.jsonl`), source: 'intake expected input' },
      { label: 'Analyzer report path', value: valueOrTarget(gate, expectedReport, `${gate.folder}/reports/ai-pen-run-report.json`), source: 'intake analyzer report' },
      { label: 'Replay/export path', value: valueOrTarget(gate, replay, folder), source: 'supporting artifact' },
      { label: 'Video path', value: valueOrTarget(gate, video, folder), source: 'supporting artifact' },
      commonDecision,
    ];
  }

  if (gate.id === 'G-SURF-1') {
    return [
      { label: 'Raw trace path', value: valueOrTarget(gate, expectedInput, `${gate.folder}/raw/capture-surface-calibration.csv`), source: 'intake expected input' },
      { label: 'Measurement sheet path', value: valueOrTarget(gate, expectedInput, `${gate.folder}/raw/capture-surface-calibration.csv`), source: 'intake expected input' },
      { label: 'Analyzer report path', value: valueOrTarget(gate, expectedReport, `${gate.folder}/reports/capture-surface-report.json`), source: 'intake analyzer report' },
      { label: 'Photo/video path', value: valueOrTarget(gate, photoVideo, folder), source: 'supporting artifact' },
      commonDecision,
    ];
  }

  if (gate.id === 'G-LIVE-1') {
    return [
      { label: 'Raw event log path', value: valueOrTarget(gate, expectedInput, `${gate.folder}/raw/live-board-timing.csv`), source: 'intake expected input' },
      { label: 'Render timing log path', value: valueOrTarget(gate, expectedInput, `${gate.folder}/raw/live-board-timing.csv`), source: 'intake expected input' },
      { label: 'Analyzer report path', value: valueOrTarget(gate, expectedReport, `${gate.folder}/reports/live-board-latency-report.json`), source: 'intake analyzer report' },
      { label: 'Replay path', value: valueOrTarget(gate, replay, folder), source: 'supporting artifact' },
      commonDecision,
    ];
  }

  if (gate.id === 'G-EDU-1') {
    return [
      { label: 'Raw session path', value: valueOrTarget(gate, expectedInput, `${gate.folder}/raw/education-demo-review.csv`), source: 'intake expected input' },
      { label: 'Reviewer CSV path', value: valueOrTarget(gate, expectedInput, `${gate.folder}/raw/education-demo-review.csv`), source: 'intake expected input' },
      { label: 'Analyzer report path', value: valueOrTarget(gate, expectedReport, `${gate.folder}/reports/education-demo-review-report.json`), source: 'intake analyzer report' },
      { label: 'Video path', value: valueOrTarget(gate, video, folder), source: 'supporting artifact' },
      commonDecision,
    ];
  }

  if (gate.id === 'G-MTG-1') {
    return [
      { label: 'Raw session path', value: valueOrTarget(gate, expectedInput, `${gate.folder}/raw/business-meeting-demo-review.csv`), source: 'intake expected input' },
      { label: 'Reviewer CSV path', value: valueOrTarget(gate, expectedInput, `${gate.folder}/raw/business-meeting-demo-review.csv`), source: 'intake expected input' },
      { label: 'Analyzer report path', value: valueOrTarget(gate, expectedReport, `${gate.folder}/reports/business-meeting-demo-review-report.json`), source: 'intake analyzer report' },
      { label: 'Video path', value: valueOrTarget(gate, video, folder), source: 'supporting artifact' },
      commonDecision,
    ];
  }

  if (gate.id === 'G-SUPPLY-1') {
    return [
      { label: 'BOM CSV path', value: valueOrTarget(gate, expectedInput, `${gate.folder}/raw/bom.csv`), source: 'intake expected input' },
      { label: 'Analyzer report path', value: valueOrTarget(gate, expectedReport, `${gate.folder}/reports/reward-pricing-report.json`), source: 'intake analyzer report' },
      { label: 'Quote folder path', value: valueOrTarget(gate, folder, folder), source: 'supporting artifact folder' },
      commonDecision,
    ];
  }

  if (gate.id === 'G-GTM-1') {
    return [
      { label: 'Weekly snapshot CSV path', value: valueOrTarget(gate, expectedInput, `${gate.folder}/raw/gtm-snapshots.csv`), source: 'intake expected input' },
      { label: 'Analyzer report path', value: valueOrTarget(gate, expectedReport, `${gate.folder}/reports/gtm-report.json`), source: 'intake analyzer report' },
      { label: 'CRM/export source folder', value: valueOrTarget(gate, folder, folder), source: 'supporting artifact folder' },
      commonDecision,
    ];
  }

  if (gate.id === 'G-PAGE-1') {
    return [
      { label: 'Kickstarter preview link/path', value: valueOrTarget(gate, review, `${gate.folder}/raw`), source: 'manual review artifact' },
      { label: 'Legal/privacy review path', value: valueOrTarget(gate, review, folder), source: 'manual review artifact' },
      { label: 'Claim review path', value: valueOrTarget(gate, review, folder), source: 'manual review artifact' },
      commonDecision,
    ];
  }

  return [
    { label: 'Expected input', value: valueOrTarget(gate, expectedInput, gate.folder), source: 'intake' },
    { label: 'Expected report', value: valueOrTarget(gate, expectedReport, gate.folder), source: 'intake' },
    commonDecision,
  ];
}

function buildRecordUpdate(gate) {
  const fields = gateFields(gate);
  return {
    gate_id: gate.id,
    label: gate.label,
    status: gate.status === 'ready_for_evidence_record_update' ? 'ready_to_update_record' : 'blocked_do_not_update_record',
    update_allowed: gate.status === 'ready_for_evidence_record_update',
    evidence_record: gate.record,
    intake_folder: gate.folder,
    expected_input: gate.expected_input,
    expected_report: gate.expected_report,
    raw_files: gate.non_template_raw_files ?? [],
    report_files: gate.report_files ?? [],
    artifact_files: gate.non_template_artifact_files ?? [],
    analyzer_status: analyzerStatus(gate),
    blockers: gate.blockers ?? [],
    proposed_fields: fields,
    missing_local_targets:
      gate.status === 'ready_for_evidence_record_update'
        ? fields
          .map((field) => field.value)
          .filter((value) => typeof value === 'string' && !/^Human reviewer/.test(value))
          .filter((value) => !/^(https?:|feishu:|lark:|obsidian:|inkloop:)/i.test(value))
          .filter((value) => value !== 'manual review required' && !fileExists(value))
        : [],
  };
}

function statusFor(recordUpdates) {
  const readyCount = recordUpdates.filter((update) => update.update_allowed).length;
  if (readyCount === 0) return 'no_ready_evidence_records';
  if (readyCount === recordUpdates.length) return 'all_ready_for_record_update';
  return 'partial_ready_for_record_update';
}

function fieldRows(fields) {
  if (!fields.length) return '| n/a | n/a | n/a |';
  return fields.map((field) => `| ${field.label} | \`${field.value}\` | ${field.source} |`).join('\n');
}

function readySections(recordUpdates) {
  const ready = recordUpdates.filter((update) => update.update_allowed);
  if (!ready.length) return 'No gates are ready for evidence-record update. Keep the Markdown evidence records unchanged.';
  return ready
    .map(
      (update) => `### ${update.gate_id} ${update.label}

Evidence record: \`${update.evidence_record}\`

| Field | Proposed Value | Source |
| --- | --- | --- |
${fieldRows(update.proposed_fields)}
`,
    )
    .join('\n');
}

function blockedRows(recordUpdates) {
  const blocked = recordUpdates.filter((update) => !update.update_allowed);
  if (!blocked.length) return '| n/a | n/a | n/a | n/a |';
  return blocked
    .map((update) => `| ${update.gate_id} | ${update.label} | \`${update.evidence_record}\` | ${update.blockers.join('; ')} |`)
    .join('\n');
}

function readme(report) {
  return `# InkLoop AI Pen Evidence Record Update Plan

Schema: \`inkloop.launch_evidence_record_update_plan.v1\`

Generated at: ${report.generated_at}

Status: \`${report.status}\`

Source intake audit: \`${report.intake_audit_path}\`

This plan converts a clean intake audit into proposed Markdown evidence-record updates. It does not edit evidence records automatically and does not make any Kickstarter launch claim.

## Summary

| Item | Value |
| --- | --- |
| Intake audit status | ${report.intake_audit_status} |
| Ready record updates | ${report.summary.ready_record_count}/${report.summary.record_count} |
| Blocked record updates | ${report.summary.blocked_record_count}/${report.summary.record_count} |
| Source intake dir | \`${report.intake_dir ?? 'n/a'}\` |

## Ready Record Updates

${readySections(report.record_updates)}

## Blocked Record Updates

| Gate | Label | Evidence Record | Blockers |
| --- | --- | --- | --- |
${blockedRows(report.record_updates)}

## Operating Rules

1. Do not update an evidence record when its row says \`blocked_do_not_update_record\`.
2. Paste proposed values only after confirming the raw files, analyzer reports, artifacts, and human decision are real.
3. Refresh this plan with \`npm run launch:evidence:record-update-plan\` after every intake audit.
4. After updating records, run \`npm run launch:evidence:audit\`.
5. Keep \`npm run launch:evidence:audit:strict\` failing until all real launch gates pass.

## Non-Claims

${report.non_claims.map((item) => `- ${item}`).join('\n')}

Detailed JSON: [record-update-plan.json](./record-update-plan.json)
`;
}

if (!existsSync(absolute(intakeAuditPath))) {
  throw new Error(`missing intake audit report: ${intakeAuditPath}. Run npm run launch:evidence:intake-audit first.`);
}

const intakeAudit = readJson(intakeAuditPath);
const recordUpdates = (intakeAudit.gates ?? []).map(buildRecordUpdate);
const readyCount = recordUpdates.filter((update) => update.update_allowed).length;
const report = {
  schema: 'inkloop.launch_evidence_record_update_plan.v1',
  generated_at: new Date().toISOString(),
  strict,
  status: statusFor(recordUpdates),
  intake_audit_path: intakeAuditPath,
  intake_audit_status: intakeAudit.status ?? 'unknown',
  intake_dir: intakeAudit.intake_dir ?? null,
  summary: {
    record_count: recordUpdates.length,
    ready_record_count: readyCount,
    blocked_record_count: recordUpdates.length - readyCount,
  },
  record_updates: recordUpdates,
  non_claims: [
    'This plan is not launch approval.',
    'This plan does not turn template rows, fixture data, or local demo evidence into Kickstarter evidence.',
    'Evidence records still require human pass, conditional-pass, or fail decisions before public claims can change.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Launch evidence record update plan status: ${report.status}`);
console.log(`Record updates ready: ${report.summary.ready_record_count}/${report.summary.record_count}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status === 'no_ready_evidence_records') {
  console.error('Strict evidence record update plan failed: no staged gates are ready for record update.');
  process.exit(1);
}
