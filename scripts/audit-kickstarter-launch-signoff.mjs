import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const signoffPath = 'docs/project/inkloop-ai-pen-kickstarter/evidence/launch-freeze-signoff.md';
const outDir = 'test-results/ai-pen-kickstarter-launch-signoff-audit';
const outJsonPath = `${outDir}/report.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

const requiredSummaryFields = [
  'Last updated',
  'Signoff status',
  'Campaign owner signoff',
  'Hardware owner signoff',
  'GTM owner signoff',
  'Legal/privacy owner signoff',
  'Operations owner signoff',
  'Founder manual launch signoff',
  'Manual launch operator',
  'Launch room coverage',
  'Downgrade decision',
  'Final launch decision',
];

const requiredOwnerAreas = ['Campaign', 'Hardware', 'GTM', 'Legal/privacy', 'Operations', 'Founder'];

const requiredLaunchDayItems = [
  'Seed user launch email prepared',
  'Trial user reminder prepared',
  'Comment FAQ template prepared',
  'Page rewards shipping risk and video final check complete',
  'Founder and team online shift confirmed',
  'Launch soon email prepared',
  'Manual Kickstarter launch owner assigned',
  'Email blast prepared',
  'Social posts prepared',
  'Seed supporter outreach prepared',
  'Comment FAQ response rotation prepared',
  'Short demo clip prepared',
  'First progress update and FAQ supplement prepared',
  'Conversion review and top FAQ adjustment prepared',
  'First-day thank-you update prepared',
  'Support escalation path prepared',
];

const requiredGateQuestions = [
  'Are all launch freeze checklist items frozen?',
  'Are all final launch judgment conditions satisfied or publicly downgraded?',
  'Is the Kickstarter manual launch owner assigned and available?',
  'Is launch-day communication coverage confirmed?',
  'Is the final launch decision ready?',
];

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function normalize(value) {
  return String(value ?? '')
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/^`|`$/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function isPlaceholder(value) {
  const normalized = normalize(value);
  return (
    !normalized ||
    /^TBD$/i.test(normalized) ||
    /^0$/i.test(normalized) ||
    /^none$/i.test(normalized) ||
    /^n\/a$/i.test(normalized) ||
    /^missing$/i.test(normalized) ||
    /^unknown$/i.test(normalized) ||
    /^not\s+(ready|reviewed|available|assigned|run)$/i.test(normalized) ||
    /\bTBD\b|\[.+?\]|missing|unknown/i.test(normalized)
  );
}

function isApproved(value) {
  const normalized = normalize(value);
  return /^(yes|true|pass|approved|ready|conditional pass|conditional-pass)$/i.test(normalized) || /^ready\b/i.test(normalized);
}

function isReadyText(value) {
  const normalized = normalize(value);
  return !isPlaceholder(normalized) && !/not ready|draft|blocked|rejected/i.test(normalized);
}

function isEvidenceReady(value) {
  const normalized = normalize(value);
  if (!isReadyText(normalized)) return false;
  if (/^https?:\/\//i.test(normalized)) return true;
  if (/^(feishu|lark|inkloop):/i.test(normalized)) return true;
  if (path.isAbsolute(normalized)) return existsSync(normalized);
  if (/^[./\w-].*\.(md|json|csv|pdf|png|jpg|jpeg|webp|mp4|mov|txt)$/i.test(normalized)) {
    return existsSync(absolute(normalized));
  }
  return true;
}

function parseTableAfterHeading(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return [];
  const tableLines = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (tableLines.length === 0 && !trimmed.startsWith('|')) continue;
    if (!trimmed.startsWith('|')) break;
    tableLines.push(trimmed);
  }
  if (tableLines.length < 3) return [];
  const headers = tableLines[0]
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
  return tableLines.slice(2).map((line) => {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
}

function parseFieldTable(markdown) {
  const rows = parseTableAfterHeading(markdown, '## Summary');
  return Object.fromEntries(rows.map((row) => [row.Field, row.Value]));
}

function evaluateSummary(fields) {
  return requiredSummaryFields.map((field) => {
    const value = fields[field] ?? 'missing';
    const blockers = [];
    if (field === 'Last updated' && isPlaceholder(value)) blockers.push('last updated date is missing');
    if (field === 'Signoff status' && !isApproved(value)) blockers.push('signoff status is not approved or ready');
    if (field.endsWith('signoff') && !isApproved(value)) blockers.push('owner signoff is not approved or ready');
    if (field === 'Manual launch operator' && !isReadyText(value)) blockers.push('manual launch operator is missing');
    if (field === 'Launch room coverage' && !isReadyText(value)) blockers.push('launch-room coverage is missing');
    if (field === 'Downgrade decision' && !isReadyText(value)) blockers.push('downgrade decision is missing');
    if (field === 'Final launch decision' && !isApproved(value)) blockers.push('final launch decision is not approved or ready');
    return {
      field,
      value,
      status: blockers.length === 0 ? 'ready' : 'not_ready',
      blockers,
    };
  });
}

function evaluateOwnerSignoffs(rows) {
  return requiredOwnerAreas.map((area) => {
    const row = rows.find((candidate) => candidate['Owner Area'] === area);
    const blockers = [];
    if (!row) {
      blockers.push('missing owner signoff row');
    } else {
      if (!isReadyText(row['Required Evidence'])) blockers.push('required evidence description is missing');
      if (!isApproved(row['Signoff Value'])) blockers.push('signoff value is not approved or ready');
      if (!isReadyText(row.Reviewer)) blockers.push('reviewer is missing');
    }
    return {
      owner_area: area,
      required_evidence: row?.['Required Evidence'] ?? 'missing',
      signoff_value: row?.['Signoff Value'] ?? 'missing',
      reviewer: row?.Reviewer ?? 'missing',
      status: blockers.length === 0 ? 'ready' : 'not_ready',
      blockers,
    };
  });
}

function evaluateLaunchDayRows(rows) {
  return requiredLaunchDayItems.map((item) => {
    const row = rows.find((candidate) => candidate['Checklist Item'] === item);
    const blockers = [];
    if (!row) {
      blockers.push('missing launch-day readiness row');
    } else {
      if (!isReadyText(row.Owner)) blockers.push('owner is missing');
      if (!isApproved(row.Status)) blockers.push('status is not approved or ready');
      if (!isEvidenceReady(row['Evidence Link'])) blockers.push('evidence link is missing or unresolved');
    }
    return {
      checklist_item: item,
      owner: row?.Owner ?? 'missing',
      signoff_status: row?.Status ?? 'missing',
      evidence_link: row?.['Evidence Link'] ?? 'missing',
      status: blockers.length === 0 ? 'ready' : 'not_ready',
      blockers,
    };
  });
}

function evaluateGateQuestions(rows) {
  return requiredGateQuestions.map((question) => {
    const row = rows.find((candidate) => candidate.Question === question);
    const answer = row?.Answer ?? 'missing';
    const blockers = [];
    if (!row) blockers.push('missing gate decision row');
    if (!isApproved(answer)) blockers.push('answer is not yes, approved, pass, or ready');
    return {
      question,
      answer,
      status: blockers.length === 0 ? 'ready' : 'not_ready',
      blockers,
    };
  });
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function ownerForSummaryField(field) {
  if (/hardware/i.test(field)) return 'Hardware';
  if (/gtm/i.test(field)) return 'GTM';
  if (/legal|privacy/i.test(field)) return 'Legal/privacy';
  if (/operations/i.test(field)) return 'Operations';
  if (/campaign/i.test(field)) return 'Campaign';
  if (/founder|final launch|manual launch operator|downgrade decision/i.test(field)) return 'Founder / Campaign';
  if (/launch room/i.test(field)) return 'Operations / Founder';
  return 'Founder / Ops';
}

function requiredInputRows(inputs) {
  if (!inputs.length) return '| n/a | n/a | n/a | n/a | n/a | n/a |';
  return inputs
    .map(
      (item) =>
        `| ${item.id} | ${item.owner} | ${item.required_input} | ${item.evidence_target} | ${item.blockers.join('; ') || 'none'} | \`${item.next_command}\` |`,
    )
    .join('\n');
}

function buildNextRequiredInputs({ summaryFields, ownerSignoffs, launchDayReadiness, gateDecisions }) {
  const summaryInputs = summaryFields
    .filter((row) => row.status !== 'ready')
    .map((row) => ({
      id: `summary_${slug(row.field)}`,
      type: 'summary_field',
      owner: ownerForSummaryField(row.field),
      required_input: `Update the Summary row "${row.field}" with a reviewed, non-placeholder value.`,
      evidence_target: `${signoffPath}#summary`,
      source_label: row.field,
      current_value: row.value,
      blockers: row.blockers,
      unlocks: ['launch_signoff_ready', 'launch_freeze_ready'],
      next_command: 'npm run kickstarter:launch-signoff-audit',
      priority: 'P0',
    }));

  const ownerInputs = ownerSignoffs
    .filter((row) => row.status !== 'ready')
    .map((row) => ({
      id: `owner_signoff_${slug(row.owner_area)}`,
      type: 'owner_signoff',
      owner: row.owner_area,
      required_input: `Record the ${row.owner_area} reviewer and approve or explicitly reject/hold the required evidence after review.`,
      evidence_target: `${signoffPath}#required-owner-signoffs`,
      source_label: row.owner_area,
      current_value: row.signoff_value,
      blockers: row.blockers,
      unlocks: ['owner_signoffs_ready', 'launch_signoff_ready'],
      next_command: 'npm run kickstarter:launch-signoff-audit',
      priority: 'P0',
    }));

  const launchDayInputs = launchDayReadiness
    .filter((row) => row.status !== 'ready')
    .map((row) => ({
      id: `launch_day_${slug(row.checklist_item)}`,
      type: 'launch_day_readiness',
      owner: row.owner,
      required_input: `Mark "${row.checklist_item}" ready only after the linked launch-day artifact exists and has been reviewed.`,
      evidence_target: `${signoffPath}#launch-day-readiness`,
      source_label: row.checklist_item,
      current_value: row.signoff_status,
      blockers: row.blockers,
      unlocks: ['launch_day_tasks_ready', 'launch_day_command_center_ready'],
      next_command: 'npm run kickstarter:launch-signoff-audit',
      priority: 'P0',
    }));

  const gateInputs = gateDecisions
    .filter((row) => row.status !== 'ready')
    .map((row) => ({
      id: `gate_decision_${slug(row.question)}`,
      type: 'gate_decision',
      owner: 'Founder / Launch Room',
      required_input: `Answer "${row.question}" with an explicit ready/pass/approved decision after the supporting gates are reviewed.`,
      evidence_target: `${signoffPath}#gate-decision`,
      source_label: row.question,
      current_value: row.answer,
      blockers: row.blockers,
      unlocks: ['gate_decisions_ready', 'final_launch_decision_ready'],
      next_command: 'npm run kickstarter:launch-signoff-audit',
      priority: 'P0',
    }));

  return [...summaryInputs, ...ownerInputs, ...launchDayInputs, ...gateInputs];
}

function emptyReport(reason) {
  return {
    schema: 'inkloop.kickstarter_launch_signoff_audit.v1',
    generated_at: new Date().toISOString(),
    strict,
    source: signoffPath,
    status: 'launch_signoff_not_ready',
    summary: {
      summary_field_count: 0,
      ready_summary_field_count: 0,
      owner_signoff_count: 0,
      ready_owner_signoff_count: 0,
      launch_day_task_count: 0,
      ready_launch_day_task_count: 0,
      gate_decision_count: 0,
      ready_gate_decision_count: 0,
      next_required_input_count: 1,
      blocker_count: 1,
    },
    summary_fields: [],
    owner_signoffs: [],
    launch_day_readiness: [],
    gate_decisions: [],
    next_required_inputs: [
      {
        id: 'missing_launch_freeze_signoff_record',
        type: 'missing_source',
        owner: 'Operations',
        required_input: `Restore or create ${signoffPath}.`,
        evidence_target: signoffPath,
        source_label: signoffPath,
        current_value: 'missing',
        blockers: [reason],
        unlocks: ['launch_signoff_ready'],
        next_command: 'npm run kickstarter:launch-signoff-audit',
        priority: 'P0',
      },
    ],
    blockers: [reason],
    non_claims: [
      'Kickstarter launch signoff audit is not launch approval.',
      'Responsible owners must update signoff rows manually after reviewing real evidence.',
      'A ready signoff audit still requires launch freeze pack readiness before manual launch.',
    ],
  };
}

function readme(report) {
  const summaryRows = report.summary_fields.length
    ? report.summary_fields.map((row) => `| ${row.field} | ${row.status} | ${row.value} | ${row.blockers.join('; ') || 'none'} |`).join('\n')
    : '| n/a | n/a | n/a | n/a |';
  const ownerRows = report.owner_signoffs.length
    ? report.owner_signoffs.map((row) => `| ${row.owner_area} | ${row.status} | ${row.signoff_value} | ${row.reviewer} | ${row.blockers.join('; ') || 'none'} |`).join('\n')
    : '| n/a | n/a | n/a | n/a | n/a |';
  const launchRows = report.launch_day_readiness.length
    ? report.launch_day_readiness.map((row) => `| ${row.checklist_item} | ${row.status} | ${row.owner} | ${row.signoff_status} | ${row.evidence_link} | ${row.blockers.join('; ') || 'none'} |`).join('\n')
    : '| n/a | n/a | n/a | n/a | n/a | n/a |';
  const gateRows = report.gate_decisions.length
    ? report.gate_decisions.map((row) => `| ${row.question} | ${row.status} | ${row.answer} | ${row.blockers.join('; ') || 'none'} |`).join('\n')
    : '| n/a | n/a | n/a | n/a |';
  const nextRequiredRows = requiredInputRows(report.next_required_inputs ?? []);
  const blockers = report.blockers.length ? report.blockers.map((blocker) => `- ${blocker}`).join('\n') : '- None';
  const nonClaims = report.non_claims.map((claim) => `- ${claim}`).join('\n');

  return `# InkLoop AI Pen Kickstarter Launch Signoff Audit

Schema: \`inkloop.kickstarter_launch_signoff_audit.v1\`

Generated at: ${report.generated_at}

Status: ${report.status}

Source: \`${report.source}\`

This audit checks final human Go/No-Go signoff, manual launch ownership, launch-room coverage, and T-24h to T+24h launch-day readiness. It does not approve launch.

## Summary

| Item | Value |
| --- | --- |
| Summary fields ready | ${report.summary.ready_summary_field_count}/${report.summary.summary_field_count} |
| Owner signoffs ready | ${report.summary.ready_owner_signoff_count}/${report.summary.owner_signoff_count} |
| Launch-day tasks ready | ${report.summary.ready_launch_day_task_count}/${report.summary.launch_day_task_count} |
| Gate decisions ready | ${report.summary.ready_gate_decision_count}/${report.summary.gate_decision_count} |
| Next required inputs | ${report.summary.next_required_input_count} |
| Blockers | ${report.summary.blocker_count} |

## Summary Fields

| Field | Status | Value | Blockers |
| --- | --- | --- | --- |
${summaryRows}

## Owner Signoffs

| Owner Area | Status | Signoff Value | Reviewer | Blockers |
| --- | --- | --- | --- | --- |
${ownerRows}

## Launch-Day Readiness

| Checklist Item | Status | Owner | Signoff Status | Evidence Link | Blockers |
| --- | --- | --- | --- | --- | --- |
${launchRows}

## Gate Decisions

| Question | Status | Answer | Blockers |
| --- | --- | --- | --- |
${gateRows}

## Next Required Inputs

| ID | Owner | Required Input | Evidence Target | Blockers | Next Command |
| --- | --- | --- | --- | --- | --- |
${nextRequiredRows}

## Blockers

${blockers}

## Non-Claims

${nonClaims}

Detailed JSON: [report.json](./report.json)
`;
}

let report;
if (!existsSync(absolute(signoffPath))) {
  report = emptyReport(`missing launch freeze signoff record: ${signoffPath}`);
} else {
  const markdown = readFileSync(absolute(signoffPath), 'utf8');
  const fields = parseFieldTable(markdown);
  const summaryFields = evaluateSummary(fields);
  const ownerSignoffs = evaluateOwnerSignoffs(parseTableAfterHeading(markdown, '## Required Owner Signoffs'));
  const launchDayReadiness = evaluateLaunchDayRows(parseTableAfterHeading(markdown, '## Launch-Day Readiness'));
  const gateDecisions = evaluateGateQuestions(parseTableAfterHeading(markdown, '## Gate Decision'));
  const nextRequiredInputs = buildNextRequiredInputs({ summaryFields, ownerSignoffs, launchDayReadiness, gateDecisions });
  const blockers = [
    ...summaryFields.flatMap((row) => row.blockers.map((blocker) => `${row.field}: ${blocker}`)),
    ...ownerSignoffs.flatMap((row) => row.blockers.map((blocker) => `${row.owner_area}: ${blocker}`)),
    ...launchDayReadiness.flatMap((row) => row.blockers.map((blocker) => `${row.checklist_item}: ${blocker}`)),
    ...gateDecisions.flatMap((row) => row.blockers.map((blocker) => `${row.question}: ${blocker}`)),
  ];
  report = {
    schema: 'inkloop.kickstarter_launch_signoff_audit.v1',
    generated_at: new Date().toISOString(),
    strict,
    source: signoffPath,
    status: blockers.length === 0 ? 'launch_signoff_ready' : 'launch_signoff_not_ready',
    summary: {
      summary_field_count: summaryFields.length,
      ready_summary_field_count: summaryFields.filter((row) => row.status === 'ready').length,
      owner_signoff_count: ownerSignoffs.length,
      ready_owner_signoff_count: ownerSignoffs.filter((row) => row.status === 'ready').length,
      launch_day_task_count: launchDayReadiness.length,
      ready_launch_day_task_count: launchDayReadiness.filter((row) => row.status === 'ready').length,
      gate_decision_count: gateDecisions.length,
      ready_gate_decision_count: gateDecisions.filter((row) => row.status === 'ready').length,
      next_required_input_count: nextRequiredInputs.length,
      blocker_count: blockers.length,
    },
    summary_fields: summaryFields,
    owner_signoffs: ownerSignoffs,
    launch_day_readiness: launchDayReadiness,
    gate_decisions: gateDecisions,
    next_required_inputs: nextRequiredInputs,
    blockers,
    non_claims: [
      'Kickstarter launch signoff audit is not launch approval.',
      'Responsible owners must update signoff rows manually after reviewing real evidence.',
      'A ready signoff audit still requires launch freeze pack readiness before manual launch.',
    ],
  };
}

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Kickstarter launch signoff audit status: ${report.status}`);
console.log(`Owner signoffs: ${report.summary.ready_owner_signoff_count}/${report.summary.owner_signoff_count} ready`);
console.log(`Launch-day tasks: ${report.summary.ready_launch_day_task_count}/${report.summary.launch_day_task_count} ready`);
console.log(`Gate decisions: ${report.summary.ready_gate_decision_count}/${report.summary.gate_decision_count} ready`);
console.log(`Next required inputs: ${report.summary.next_required_input_count}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status !== 'launch_signoff_ready') {
  console.error('Strict Kickstarter launch signoff audit failed: owner signoffs, manual launch ownership, launch-room coverage, or launch-day readiness are incomplete.');
  process.exit(1);
}
