import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const planPath = 'test-results/ai-pen-launch-evidence-record-update-plan/record-update-plan.json';
const outDir = 'test-results/ai-pen-launch-evidence-record-apply';
const outJsonPath = `${outDir}/apply-report.json`;
const outReadmePath = `${outDir}/README.md`;
const apply = process.argv.includes('--apply');
const strict = process.argv.includes('--strict');

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(absolute(relativePath), 'utf8'));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, '\\|');
}

function shouldSkipField(field) {
  if (field.label === 'Decision') {
    return 'human decision must be written manually';
  }
  if (String(field.value).startsWith('blocked until intake ready:')) {
    return 'blocked placeholder values must never be applied';
  }
  if (field.value === 'manual review required') {
    return 'manual review value must be written manually';
  }
  return null;
}

function replaceFieldLine(markdown, field) {
  const lines = markdown.split('\n');
  const pattern = new RegExp(`^\\|\\s*${escapeRegExp(field.label)}\\s*\\|`);
  const index = lines.findIndex((line) => pattern.test(line));
  if (index === -1) {
    return { markdown, changed: false, reason: 'field label not found in evidence record' };
  }
  lines[index] = `| ${field.label} | ${escapeMarkdownCell(field.value)} |`;
  return { markdown: lines.join('\n'), changed: true, reason: null };
}

function planFieldApplications(update) {
  return update.proposed_fields.map((field) => {
    const skipReason = shouldSkipField(field);
    return {
      gate_id: update.gate_id,
      evidence_record: update.evidence_record,
      label: field.label,
      value: field.value,
      source: field.source,
      eligible: !skipReason,
      skip_reason: skipReason,
    };
  });
}

function applyRecordUpdate(update) {
  const recordPath = update.evidence_record;
  const plannedFields = planFieldApplications(update);
  if (!existsSync(absolute(recordPath))) {
    return {
      gate_id: update.gate_id,
      evidence_record: recordPath,
      status: 'record_missing',
      applied: false,
      field_results: plannedFields.map((field) => ({ ...field, applied: false, skip_reason: field.skip_reason ?? 'evidence record file missing' })),
    };
  }

  let markdown = readFileSync(absolute(recordPath), 'utf8');
  const fieldResults = [];
  for (const field of plannedFields) {
    if (!field.eligible) {
      fieldResults.push({ ...field, applied: false });
      continue;
    }
    const result = replaceFieldLine(markdown, field);
    if (result.changed) markdown = result.markdown;
    fieldResults.push({
      ...field,
      applied: apply && result.changed,
      skip_reason: result.reason,
    });
  }

  if (apply) writeFileSync(absolute(recordPath), markdown);
  const changedCount = fieldResults.filter((field) => field.applied).length;
  const eligibleCount = fieldResults.filter((field) => field.eligible).length;
  const missingFieldCount = fieldResults.filter((field) => field.eligible && field.skip_reason).length;
  return {
    gate_id: update.gate_id,
    evidence_record: recordPath,
    status: missingFieldCount > 0 ? 'ready_record_has_missing_fields' : apply ? 'record_updated' : 'dry_run_ready',
    applied: apply && changedCount > 0,
    eligible_field_count: eligibleCount,
    applied_field_count: changedCount,
    skipped_field_count: fieldResults.length - changedCount,
    field_results: fieldResults,
  };
}

function statusFor({ readyUpdates, recordResults }) {
  if (readyUpdates.length === 0) return 'no_ready_records_to_apply';
  if (!apply) return 'dry_run_ready_records';
  if (recordResults.some((record) => record.status === 'record_missing' || record.status === 'ready_record_has_missing_fields')) {
    return 'record_apply_incomplete';
  }
  return 'record_updates_applied';
}

function fieldRows(recordResults) {
  const rows = recordResults.flatMap((record) =>
    record.field_results.map((field) => ({
      ...field,
      status: field.applied ? 'applied' : field.skip_reason ? 'skipped' : apply ? 'not_applied' : 'dry_run',
    })),
  );
  if (!rows.length) return '| n/a | n/a | n/a | n/a | n/a |';
  return rows
    .map((field) => `| ${field.gate_id} | ${field.label} | ${field.status} | \`${field.evidence_record}\` | ${field.skip_reason ?? field.source} |`)
    .join('\n');
}

function readme(report) {
  return `# InkLoop AI Pen Evidence Record Apply Report

Schema: \`inkloop.launch_evidence_record_apply.v1\`

Status: \`${report.status}\`

Mode: \`${report.apply ? 'apply' : 'dry-run'}\`

This report previews or applies only safe field updates from records marked \`ready_to_update_record\`. It never applies blocked placeholder values and it never writes the human gate decision.

## Summary

| Item | Value |
| --- | --- |
| Source plan | \`${report.source_plan_path}\` |
| Source plan status | ${report.source_plan_status} |
| Ready records | ${report.summary.ready_record_count}/${report.summary.record_count} |
| Applied records | ${report.summary.applied_record_count} |
| Eligible fields | ${report.summary.eligible_field_count} |
| Applied fields | ${report.summary.applied_field_count} |
| Skipped fields | ${report.summary.skipped_field_count} |

## Field Results

| Gate | Field | Status | Evidence Record | Source / Skip Reason |
| --- | --- | --- | --- | --- |
${fieldRows(report.record_results)}

## Operating Rules

1. Run \`npm run launch:evidence:apply-record-updates\` first; it is dry-run only.
2. Review this report and the source artifacts before running \`npm run launch:evidence:apply-record-updates:write\`.
3. Write the \`Decision\` row manually after a human reviewer marks Pass, Conditional pass, or Fail.
4. After writing records, run \`npm run launch:evidence:audit\` and \`npm run kickstarter:ops-refresh\`.
5. This apply report is not launch approval.

Detailed JSON: [apply-report.json](./apply-report.json)
`;
}

if (!existsSync(absolute(planPath))) {
  throw new Error(`missing record update plan: ${planPath}. Run npm run launch:evidence:record-update-plan first.`);
}

const plan = readJson(planPath);
const readyUpdates = (plan.record_updates ?? []).filter((update) => update.update_allowed === true);
const recordResults = readyUpdates.map(applyRecordUpdate);
const summary = {
  record_count: plan.summary?.record_count ?? plan.record_updates?.length ?? 0,
  ready_record_count: readyUpdates.length,
  applied_record_count: recordResults.filter((record) => record.applied).length,
  eligible_field_count: recordResults.reduce((sum, record) => sum + (record.eligible_field_count ?? 0), 0),
  applied_field_count: recordResults.reduce((sum, record) => sum + (record.applied_field_count ?? 0), 0),
  skipped_field_count: recordResults.reduce((sum, record) => sum + (record.skipped_field_count ?? 0), 0),
};

const report = {
  schema: 'inkloop.launch_evidence_record_apply.v1',
  generated_at: new Date().toISOString(),
  apply,
  strict,
  status: statusFor({ readyUpdates, recordResults }),
  source_plan_path: planPath,
  source_plan_status: plan.status ?? 'unknown',
  summary,
  record_results: recordResults,
  non_claims: [
    'This apply report is not launch approval.',
    'This apply report does not turn local demo, fixture, template, or blocked intake values into Kickstarter evidence.',
    'Human reviewers must still set Pass, Conditional pass, or Fail decisions in the Markdown evidence records.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Launch evidence record apply status: ${report.status}`);
console.log(`Mode: ${apply ? 'apply' : 'dry-run'}`);
console.log(`Ready records: ${summary.ready_record_count}/${summary.record_count}`);
console.log(`Applied fields: ${summary.applied_field_count}/${summary.eligible_field_count}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status !== 'record_updates_applied') {
  console.error('Strict evidence record apply failed: no complete record updates were applied.');
  process.exit(1);
}
