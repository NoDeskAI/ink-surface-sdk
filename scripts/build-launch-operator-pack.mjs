import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = 'test-results/ai-pen-launch-operator-pack';
const outJsonPath = `${outDir}/operator-pack.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

const sourcePaths = {
  intakeAudit: 'test-results/ai-pen-launch-evidence-intake-audit/report.json',
  recordUpdatePlan: 'test-results/ai-pen-launch-evidence-record-update-plan/record-update-plan.json',
  launchAudit: 'test-results/ai-pen-launch-evidence-audit/report.json',
  actionPlan: 'test-results/ai-pen-launch-action-plan/action-plan.json',
  weeklySprint: 'test-results/ai-pen-kickstarter-weekly-sprint/weekly-sprint.json',
  proofShotAudit: 'test-results/ai-pen-kickstarter-proof-shot-audit/report.json',
  prelaunchPagePack: 'test-results/ai-pen-kickstarter-prelaunch-page/prelaunch-page.json',
};

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function readJsonSource(relativePath) {
  if (!existsSync(absolute(relativePath))) {
    return { path: relativePath, available: false, error: `missing source file: ${relativePath}`, data: null };
  }
  try {
    return {
      path: relativePath,
      available: true,
      error: null,
      data: JSON.parse(readFileSync(absolute(relativePath), 'utf8')),
    };
  } catch (error) {
    return {
      path: relativePath,
      available: false,
      error: `unreadable source file: ${relativePath}: ${error.message}`,
      data: null,
    };
  }
}

function sourceMap(sources) {
  return Object.fromEntries(
    Object.entries(sources).map(([key, source]) => [
      key,
      {
        path: source.path,
        available: source.available,
        error: source.error,
      },
    ]),
  );
}

function sourceIssues(sources) {
  return Object.values(sources)
    .filter((source) => !source.available)
    .map((source) => source.error);
}

function mdLink(targetPath, label = targetPath) {
  if (!targetPath) return 'n/a';
  return `[${label}](${path.relative(outDir, targetPath)})`;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildCaptureSessions(weeklySprint) {
  const plan = Array.isArray(weeklySprint?.first_48h_capture_plan) ? weeklySprint.first_48h_capture_plan : [];
  return uniqueBy(plan, (item) => item.gate_id).map((item) => ({
    day: item.day,
    gate_id: item.gate_id,
    owner: item.owner,
    action: item.action,
    raw_target: item.raw_target,
    report_target: item.report_target,
    artifact_target: item.artifact_target,
    analyzer_command: item.run_command,
    evidence_record: item.evidence_record,
    intake_blockers: item.intake_blockers ?? [],
  }));
}

function buildRecordRows(recordUpdatePlan) {
  return (recordUpdatePlan?.record_updates ?? []).map((record) => ({
    gate_id: record.gate_id,
    label: record.label,
    status: record.status,
    update_allowed: record.update_allowed === true,
    evidence_record: record.evidence_record,
    analyzer_status: record.analyzer_status,
    expected_input: record.expected_input,
    expected_report: record.expected_report,
    blockers: record.blockers ?? [],
  }));
}

function buildProofShots(proofShotAudit) {
  return (proofShotAudit?.shots ?? []).map((shot) => ({
    id: shot.id,
    gate: shot.gate,
    check: shot.check,
    status: shot.status,
    folder: shot.folder,
    shot_log_path: shot.shot_log_path,
    claim_review_path: shot.claim_review_path,
    blockers: shot.blockers ?? [],
  }));
}

function buildPrelaunchWorkOrder(prelaunchPagePack) {
  const fields = prelaunchPagePack?.prelaunch_fields ?? {};
  const missingFields = Object.entries(fields)
    .filter(([, field]) => /missing|tbd/i.test(`${field?.approval_state ?? ''} ${field?.value ?? ''}`))
    .map(([field, details]) => ({
      field,
      value: details?.value ?? 'n/a',
      approval_state: details?.approval_state ?? 'n/a',
    }));
  const requiredCommands = Array.isArray(prelaunchPagePack?.required_commands) ? prelaunchPagePack.required_commands : [];
  const fieldCount = prelaunchPagePack?.summary?.field_count ?? Object.keys(fields).length;
  const missingFieldCount = prelaunchPagePack?.summary?.missing_field_count ?? missingFields.length;

  return {
    status: prelaunchPagePack?.status ?? 'prelaunch_page_not_ready',
    target_publish_window: prelaunchPagePack?.snapshot?.target_publish_window ?? '2026-10-01 to 2026-10-07',
    kickstarter_preview_link: prelaunchPagePack?.snapshot?.kickstarter_preview_link ?? 'TBD',
    prelaunch_url: prelaunchPagePack?.snapshot?.prelaunch_url ?? '[PRELAUNCH_URL]',
    fields_ready: `${Math.max(0, fieldCount - missingFieldCount)}/${fieldCount}`,
    missing_fields: missingFields,
    owner: fields.Owner?.value ?? 'TBD',
    final_reviewer: fields['Final reviewer']?.value ?? 'TBD',
    preflight_checklist: [
      'Open the Kickstarter project preview and confirm the project title, subtitle, category, hero asset, short description, and Notify me CTA match the approved public copy lock.',
      'Confirm public copy lock, claim downgrade, launch evidence audit, and GTM tracker have been refreshed before traffic is sent.',
      'Assign a campaign owner and final reviewer before the pre-launch URL is shared.',
    ],
    publish_checklist: [
      'Capture the Kickstarter preview link and live pre-launch URL.',
      'Confirm UTM convention, CRM source field, and weekly dashboard owner are ready.',
      'Do not drive traffic until the owner review, final reviewer, public copy lock, claim downgrade, and GTM tracking are ready.',
    ],
    after_publish_checklist: [
      'Run `npm run kickstarter:prelaunch-page-pack` and confirm status moves toward ready.',
      'Run `npm run kickstarter:ops-refresh` so the ops snapshot, launch freeze pack, and launch-day command center see the updated pre-launch status.',
      'Record Kickstarter followers from real Kickstarter dashboard exports; do not infer demand from page draft status.',
    ],
    required_commands: uniqueBy(
      [
        ...requiredCommands,
        'npm run kickstarter:prelaunch-page-pack',
        'npm run kickstarter:prelaunch-page-pack:strict',
        'npm run kickstarter:ops-refresh',
      ],
      (command) => command,
    ),
    done_condition:
      'Kickstarter preview link, live pre-launch URL, owner, final reviewer, public copy lock, claim downgrade, launch evidence audit, GTM tracking, and real follower export path are all present and reviewed.',
  };
}

function requiredArtifactsForGate(gateId) {
  if (gateId === 'G-HW-1') {
    return [
      'raw RawPenFrame JSONL from the prototype run',
      'prototype unit id, firmware version, pen id, surface id, and session id',
      '30-minute run video or screen recording',
      'replay or export artifact showing the captured strokes',
      'failure notes for battery, cache recovery, reconnect, or dropped frames',
    ];
  }
  if (gateId === 'G-SURF-1') {
    return [
      'A2/A3 calibration CSV with center, edge, and corner points',
      'surface id, material batch, lighting, glare, wipe, and ink condition notes',
      'photo or video proving the measured surface and point layout',
      'measurement sheet or exported calibration worksheet',
    ];
  }
  if (gateId === 'G-LIVE-1') {
    return [
      'Live Board timing CSV with raw frame, host receive, InkEvent append, and render commit timestamps',
      'screen recording or replay that matches the timing export',
      'transport notes for BLE or wired path, pen id, session id, and drop count',
    ];
  }
  if (gateId === 'G-EDU-1') {
    return [
      '5-8 minute real teacher or tutor session recording',
      'reviewer CSV with accepted, edited, dismissed, and follow-up candidates',
      'exported lesson notes and formula steps with source_refs',
      'review notes from the teacher or product reviewer',
    ];
  }
  if (gateId === 'G-MTG-1') {
    return [
      'real business whiteboard meeting recording or replay',
      'reviewer CSV for decisions, actions, risks, and diagrams',
      'optional meeting context file if audio, subtitles, agenda, speaker, or timeline data were used',
      'exported meeting outputs with source_refs back to ink_event or board_object evidence',
    ];
  }
  if (gateId === 'G-SUPPLY-1') {
    return [
      'BOM CSV with cost, MOQ, lead time, supplier, backup supplier, and quote status',
      'quote PDFs, screenshots, or supplier emails in the artifact folder',
      'reward pricing analyzer output',
      'risk notes for certification, assembly, packaging, shipping, and AI credits',
    ];
  }
  if (gateId === 'G-GTM-1') {
    return [
      'weekly GTM snapshot CSV',
      'CRM, email list, Kickstarter follower, testimonial, and first-day likely backer exports',
      'GTM analyzer output',
      'segment notes for education and business demand',
    ];
  }
  if (gateId === 'G-PAGE-1') {
    return [
      'Kickstarter preview link or exported page draft',
      'legal/privacy review notes',
      'claim review notes tied to the claim evidence matrix',
      'risk disclosure and reward copy approval notes',
    ];
  }
  return ['real raw files, analyzer report, supporting artifacts, and reviewer notes'];
}

function buildFieldWorkOrders(sessions) {
  return sessions.map((session) => ({
    gate_id: session.gate_id,
    owner: session.owner,
    evidence_record: session.evidence_record,
    raw_target: session.raw_target,
    report_target: session.report_target,
    artifact_target: session.artifact_target,
    analyzer_command: session.analyzer_command,
    preflight_checklist: [
      `Open or create the intake raw target: ${session.raw_target ?? 'n/a'}.`,
      `Prepare the artifact folder: ${session.artifact_target ?? 'n/a'}.`,
      'Confirm the run uses real hardware, real Capture Surface, real user/session, real supplier/GTM export, or real page review material.',
      'Assign one operator to capture raw files and one reviewer to check artifacts before analyzer execution.',
    ],
    capture_checklist: [
      session.action,
      'Keep source ids stable across raw files, analyzer input, supporting artifacts, and reviewer notes.',
      'Record environmental or context variables that explain the result instead of summarizing them away.',
      'Do not overwrite template rows with demo fixture values.',
    ],
    after_capture_checklist: [
      `Run analyzer command: ${session.analyzer_command ?? 'n/a'}.`,
      'Run `npm run launch:evidence:intake-audit` before editing Markdown evidence records.',
      'Run `npm run launch:evidence:record-update-plan` and review only rows marked `ready_to_update_record`.',
      'Run `npm run launch:evidence:apply-record-updates` as dry-run before any write.',
      'Decision row remains manual: a human reviewer must mark Pass, Conditional pass, or Fail.',
    ],
    required_artifacts: requiredArtifactsForGate(session.gate_id),
    done_condition:
      'raw target exists, analyzer report exists and passes gate_checks, artifact folder contains real supporting files, intake audit marks the gate ready, record-update plan marks ready_to_update_record, and the human Decision row is still reviewed manually.',
  }));
}

function replaceIntakePlaceholder(command, intakeDir) {
  if (!command) return null;
  if (!intakeDir) return command;
  return command.replaceAll('<intake>', intakeDir);
}

function buildGateFieldWorkOrders({ actionPlan, recordUpdatePlan, captureSessions }) {
  const actionItems = Array.isArray(actionPlan?.action_items) ? actionPlan.action_items : [];
  const recordUpdates = Array.isArray(recordUpdatePlan?.record_updates) ? recordUpdatePlan.record_updates : [];
  const recordsByGate = new Map(recordUpdates.map((record) => [record.gate_id, record]));
  const sessionsByGate = new Map(captureSessions.map((session) => [session.gate_id, session]));
  const intakeDir = recordUpdatePlan?.intake_dir;

  if (!actionItems.length) return buildFieldWorkOrders(captureSessions);

  return actionItems.map((item) => {
    const record = recordsByGate.get(item.id);
    const session = sessionsByGate.get(item.id);
    const intakeFolder = record?.intake_folder ?? (intakeDir && item.intake_folder ? `${intakeDir}/${item.intake_folder}` : null);
    const rawTarget = record?.expected_input ?? (intakeFolder ? `${intakeFolder}/raw` : session?.raw_target ?? null);
    const reportTarget = record?.expected_report ?? session?.report_target ?? null;
    const artifactTarget = intakeFolder ? `${intakeFolder}/artifacts` : session?.artifact_target ?? null;
    const analyzerCommand = replaceIntakePlaceholder(item.command, intakeDir) ?? session?.analyzer_command ?? null;

    return {
      gate_id: item.id,
      label: item.label,
      priority: item.priority,
      status: item.status,
      owner: item.owner,
      due: item.due,
      source_milestone: item.source_milestone,
      evidence_record: item.evidence_record,
      intake_folder: intakeFolder,
      raw_target: rawTarget,
      report_target: reportTarget,
      artifact_target: artifactTarget,
      analyzer_command: analyzerCommand,
      audit_blockers: item.audit?.blockers ?? record?.blockers ?? [],
      preflight_checklist: [
        `Open or create the gate intake folder: ${intakeFolder ?? 'n/a'}.`,
        `Prepare raw target: ${rawTarget ?? 'manual review artifact in raw folder'}.`,
        `Prepare artifact folder: ${artifactTarget ?? 'n/a'}.`,
        `Confirm owner ${item.owner ?? 'n/a'} can provide evidence before ${item.due ?? 'n/a'}.`,
        `Check source milestone: ${item.source_milestone ?? 'n/a'}.`,
      ],
      capture_checklist: [
        item.action,
        'Keep source ids stable across raw files, analyzer input, supporting artifacts, reviewer notes, and evidence-record fields.',
        'Record context variables that explain the result instead of summarizing them away.',
        'Do not overwrite template rows with demo fixture values.',
      ],
      after_capture_checklist: [
        `Run analyzer or review command: ${analyzerCommand ?? 'manual review; no local analyzer command'}.`,
        'Run `npm run launch:evidence:intake-audit` before editing Markdown evidence records.',
        'Run `npm run launch:evidence:record-update-plan` and review only rows marked `ready_to_update_record`.',
        'Run `npm run launch:evidence:apply-record-updates` as dry-run before any write.',
        'Decision row remains manual: a human reviewer must mark Pass, Conditional pass, or Fail.',
      ],
      required_artifacts: requiredArtifactsForGate(item.id),
      done_condition: item.done_when,
    };
  });
}

function statusFor({ sources, launchAudit, fieldWorkOrders, prelaunchWorkOrder }) {
  if (sourceIssues(sources).length > 0) return 'operator_pack_missing_sources';
  if (launchAudit?.status === 'launch_ready_evidence_present' && prelaunchWorkOrder?.status === 'prelaunch_page_ready') return 'operator_pack_launch_evidence_ready';
  if (launchAudit?.status === 'launch_ready_evidence_present') return 'operator_pack_prelaunch_not_ready';
  if (fieldWorkOrders.length > 0) return 'operator_pack_field_capture_ready_launch_not_ready';
  return 'operator_pack_no_capture_tasks';
}

function captureRows(sessions) {
  if (!sessions.length) return '| n/a | n/a | n/a | n/a | n/a | n/a |';
  return sessions
    .map(
      (session) =>
        `| ${session.day} | ${session.gate_id} | ${session.owner} | ${session.action} | \`${session.raw_target ?? 'n/a'}\` | \`${session.analyzer_command ?? 'n/a'}\` |`,
    )
    .join('\n');
}

function targetRows(sessions) {
  if (!sessions.length) return '| n/a | n/a | n/a | n/a |';
  return sessions
    .map(
      (session) => `| ${session.gate_id} | \`${session.raw_target ?? 'n/a'}\` | \`${session.report_target ?? 'n/a'}\` | \`${session.artifact_target ?? 'n/a'}\` |`,
    )
    .join('\n');
}

function recordRows(records) {
  if (!records.length) return '| n/a | n/a | n/a | n/a | n/a |';
  return records
    .map(
      (record) =>
        `| ${record.gate_id} | ${record.status} | ${record.analyzer_status} | \`${record.evidence_record}\` | ${record.blockers.join('; ') || 'none'} |`,
    )
    .join('\n');
}

function proofRows(shots) {
  if (!shots.length) return '| n/a | n/a | n/a | n/a | n/a |';
  return shots
    .map(
      (shot) =>
        `| ${shot.id} | ${shot.gate} | ${shot.status} | \`${shot.shot_log_path}\` | ${shot.blockers.join('; ') || 'none'} |`,
    )
    .join('\n');
}

function prelaunchMissingRows(workOrder) {
  if (!workOrder?.missing_fields?.length) return '| none | n/a | n/a |';
  return workOrder.missing_fields
    .map((item) => `| ${item.field} | ${item.value} | ${item.approval_state} |`)
    .join('\n');
}

function prelaunchCommandRows(workOrder) {
  if (!workOrder?.required_commands?.length) return '- n/a';
  return workOrder.required_commands.map((command) => `- \`${command}\``).join('\n');
}

function cellList(items) {
  if (!items?.length) return 'n/a';
  return items.join('<br>');
}

function workOrderRows(workOrders) {
  if (!workOrders.length) return '| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |';
  return workOrders
    .map(
      (order) =>
        `| ${order.gate_id} | ${order.priority ?? 'n/a'} | ${order.status ?? 'n/a'} | ${order.owner} | ${order.due ?? 'n/a'} | ${cellList(order.preflight_checklist)} | ${cellList(order.capture_checklist)} | ${cellList(order.after_capture_checklist)} | ${cellList(order.required_artifacts)} |`,
    )
    .join('\n');
}

function readme(pack) {
  const accessIssues = pack.access_issues.length ? pack.access_issues.map((issue) => `- ${issue}`).join('\n') : '- None';
  const commands = pack.required_commands.map((command) => `- \`${command}\``).join('\n');
  const nonClaims = pack.non_claims.map((claim) => `- ${claim}`).join('\n');

  return `# InkLoop AI Pen Launch Operator Pack

Schema: \`inkloop.launch_operator_pack.v1\`

Status: \`${pack.status}\`

This is the field-operator handoff for collecting real Kickstarter launch evidence. It is not launch approval and it does not edit official evidence records.

## Snapshot

| Item | Value |
| --- | --- |
| Launch audit status | ${pack.snapshot.launch_audit_status} |
| Intake audit status | ${pack.snapshot.intake_audit_status} |
| Record update plan status | ${pack.snapshot.record_update_plan_status} |
| Evidence records ready to update | ${pack.snapshot.ready_record_count}/${pack.snapshot.record_count} |
| Weekly sprint status | ${pack.snapshot.weekly_sprint_status} |
| Capture sessions in this pack | ${pack.capture_sessions.length} |
| Gate field work orders | ${pack.field_work_orders.length}/${pack.snapshot.action_item_count} |
| Proof-shot audit status | ${pack.snapshot.proof_shot_audit_status} |
| Final-cut proof shots | ${pack.snapshot.ready_shot_count}/${pack.snapshot.shot_count} |
| Pre-launch page status | ${pack.snapshot.prelaunch_page_status} |
| Pre-launch fields ready | ${pack.snapshot.prelaunch_page_fields_ready} |

## Pre-Launch / Notify me Work Order

| Item | Value |
| --- | --- |
| Status | ${pack.prelaunch_work_order.status} |
| Target publish window | ${pack.prelaunch_work_order.target_publish_window} |
| Kickstarter preview link | ${pack.prelaunch_work_order.kickstarter_preview_link} |
| Pre-launch URL | ${pack.prelaunch_work_order.prelaunch_url} |
| Owner | ${pack.prelaunch_work_order.owner} |
| Final reviewer | ${pack.prelaunch_work_order.final_reviewer} |
| Done condition | ${pack.prelaunch_work_order.done_condition} |

### Missing Pre-Launch Fields

| Field | Value | Approval State |
| --- | --- | --- |
${prelaunchMissingRows(pack.prelaunch_work_order)}

### Pre-Launch Commands

${prelaunchCommandRows(pack.prelaunch_work_order)}

## First 48 Hours Capture Queue

| Day | Gate | Owner | Action | Raw Target | Analyzer Command |
| --- | --- | --- | --- | --- | --- |
${captureRows(pack.capture_sessions)}

## Gate File Targets

| Gate | Raw Target | Report Target | Artifact Folder |
| --- | --- | --- | --- |
${targetRows(pack.field_work_orders)}

## All Launch Gate Field Work Orders

| Gate | Priority | Status | Owner | Due | Preflight | Capture | After Capture | Required Artifacts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${workOrderRows(pack.field_work_orders)}

## After Capture Command Loop

${commands}

## Evidence Record Writeback Guard

Only copy values from records marked \`ready_to_update_record\`. Leave \`blocked_do_not_update_record\` records unchanged.

| Gate | Status | Analyzer | Evidence Record | Blockers |
| --- | --- | --- | --- | --- |
${recordRows(pack.record_updates)}

## Proof-Shot Capture Queue

| Shot | Gate | Status | Shot Log | Blockers |
| --- | --- | --- | --- | --- |
${proofRows(pack.proof_shots)}

## Non-Claims

${nonClaims}

## Access Issues

${accessIssues}

Source action plan: ${mdLink(sourcePaths.actionPlan)}

Source weekly sprint: ${mdLink(sourcePaths.weeklySprint)}

Detailed JSON: [operator-pack.json](./operator-pack.json)
`;
}

const sources = Object.fromEntries(Object.entries(sourcePaths).map(([key, relativePath]) => [key, readJsonSource(relativePath)]));
const captureSessions = buildCaptureSessions(sources.weeklySprint.data);
const recordUpdates = buildRecordRows(sources.recordUpdatePlan.data);
const fieldWorkOrders = buildGateFieldWorkOrders({
  actionPlan: sources.actionPlan.data,
  recordUpdatePlan: sources.recordUpdatePlan.data,
  captureSessions,
});
const proofShots = buildProofShots(sources.proofShotAudit.data);
const prelaunchWorkOrder = buildPrelaunchWorkOrder(sources.prelaunchPagePack.data);
const readyRecordCount = recordUpdates.filter((record) => record.update_allowed).length;
const readyShotCount = proofShots.filter((shot) => shot.status === 'final_cut_ready').length;
const actionItemCount = sources.actionPlan.data?.action_count ?? sources.actionPlan.data?.action_items?.length ?? fieldWorkOrders.length;
const report = {
  schema: 'inkloop.launch_operator_pack.v1',
  generated_at: new Date().toISOString(),
  strict,
  status: statusFor({
    sources,
    launchAudit: sources.launchAudit.data,
    fieldWorkOrders,
    prelaunchWorkOrder,
  }),
  sources: sourceMap(sources),
  access_issues: sourceIssues(sources),
  snapshot: {
    launch_audit_status: sources.launchAudit.data?.status ?? 'unknown',
    intake_audit_status: sources.intakeAudit.data?.status ?? 'unknown',
    record_update_plan_status: sources.recordUpdatePlan.data?.status ?? 'unknown',
    record_count: sources.recordUpdatePlan.data?.summary?.record_count ?? recordUpdates.length,
    ready_record_count: sources.recordUpdatePlan.data?.summary?.ready_record_count ?? readyRecordCount,
    action_plan_status: sources.actionPlan.data?.audit_status ?? 'unknown',
    action_item_count: actionItemCount,
    weekly_sprint_status: sources.weeklySprint.data?.status ?? 'unknown',
    proof_shot_audit_status: sources.proofShotAudit.data?.status ?? 'unknown',
    shot_count: sources.proofShotAudit.data?.summary?.shot_count ?? proofShots.length,
    ready_shot_count: sources.proofShotAudit.data?.summary?.ready_shot_count ?? readyShotCount,
    prelaunch_page_status: sources.prelaunchPagePack.data?.status ?? 'unknown',
    prelaunch_page_fields_ready: prelaunchWorkOrder.fields_ready,
  },
  capture_sessions: captureSessions,
  field_work_orders: fieldWorkOrders,
  prelaunch_work_order: prelaunchWorkOrder,
  record_updates: recordUpdates,
  proof_shots: proofShots,
  required_commands: [
    'npm run kickstarter:prelaunch-page-pack',
    'npm run launch:evidence:intake-audit',
    'npm run launch:evidence:record-update-plan',
    'npm run launch:evidence:apply-record-updates',
    'npm run launch:evidence:audit',
    'npm run kickstarter:proof-shot-audit',
    'npm run launch:operator-pack',
    'npm run kickstarter:ops-refresh',
  ],
  non_claims: [
    'This operator pack is not launch approval.',
    'This operator pack does not turn local demo data, fixtures, template files, or screenshots into Kickstarter evidence.',
    'Official evidence records must only be edited from ready_to_update_record rows after real raw files, analyzer reports, artifacts, and human decisions exist.',
    'The pre-launch page and Notify me funnel are not demand proof until real Kickstarter dashboard exports and GTM tracker updates exist.',
    'Public page, video, ad, and reward claims must still pass claim downgrade and strict launch evidence audit.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Launch operator pack status: ${report.status}`);
console.log(`Capture sessions: ${report.capture_sessions.length}`);
console.log(`Evidence records ready: ${report.snapshot.ready_record_count}/${report.snapshot.record_count}`);
console.log(`Proof shots ready: ${report.snapshot.ready_shot_count}/${report.snapshot.shot_count}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status !== 'operator_pack_launch_evidence_ready') {
  console.error('Strict launch operator pack failed: launch evidence or Pre-Launch / Notify me work order is not ready.');
  process.exit(1);
}
