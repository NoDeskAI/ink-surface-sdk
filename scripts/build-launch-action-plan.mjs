import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const auditPath = 'test-results/ai-pen-launch-evidence-audit/report.json';
const outDir = 'test-results/ai-pen-launch-action-plan';
const outJsonPath = `${outDir}/action-plan.json`;
const outReadmePath = `${outDir}/README.md`;

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(absolute(relativePath), 'utf8'));
}

const gateActions = {
  'G-HW-1': {
    priority: 'P0',
    owner: 'Hardware / Runtime',
    due: '2026-07-21 first real pen log; 2026-08-31 five demo units',
    sourceMilestone: 'G1 7/08-7/21 P0 AI Pen can capture points; G3 8/11-8/31 business demo + 5 prototypes',
    action: 'Run a real AI Pen or closest engineering prototype for pen down/up, coordinates, firmware, battery, cache recovery, replay, and video.',
    command:
      'npm --workspace ./examples/ai-annotation-demo run evidence:ai-pen-run -- <intake>/01-hardware-prototypes/raw/raw-pen-run.jsonl --out <intake>/01-hardware-prototypes/reports/ai-pen-run-report.json',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/hardware-prototype-run-log.md',
    intakeFolder: '01-hardware-prototypes',
    doneWhen: '5 units have 30-minute raw logs, replay/export, video, analyzer report, and pass or conditional-pass decision.',
  },
  'G-SURF-1': {
    priority: 'P0',
    owner: 'Hardware',
    due: '2026-07-18 material test 1; 2026-09-30 launch readiness review',
    sourceMilestone: '7/18 Capture Surface material test 1; 9/30 launch readiness review',
    action: 'Measure real A2/A3 Capture Surface points across center, edge, corner, lighting, glare, wipe, and ink conditions.',
    command:
      'npm --workspace ./examples/ai-annotation-demo run evidence:capture-surface -- <intake>/02-capture-surface-calibration/raw/capture-surface-calibration.csv --out <intake>/02-capture-surface-calibration/reports/capture-surface-report.json',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/capture-surface-calibration-report.md',
    intakeFolder: '02-capture-surface-calibration',
    doneWhen: 'P95 error <= 5mm, stability >= 95%, edge/corner coverage, A2/A3 coverage, raw trace, measurement sheet, and photo/video are linked.',
  },
  'G-LIVE-1': {
    priority: 'P0',
    owner: 'Runtime',
    due: '2026-07-21 Live Board demo; 2026-08-31 dual-scenario end-to-end demo',
    sourceMilestone: '7/21 Live Board Demo; 8/31 5 demo units and dual-scenario end-to-end',
    action: 'Capture real BLE or wired transport timing from raw pen frame through host receive, InkEvent append, and Live Board render commit.',
    command:
      'npm --workspace ./examples/ai-annotation-demo run evidence:live-board-latency -- <intake>/03-live-board-latency/raw/live-board-timing.csv --out <intake>/03-live-board-latency/reports/live-board-latency-report.json',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/live-board-latency-report.md',
    intakeFolder: '03-live-board-latency',
    doneWhen: 'Real transport shows P50 <= 150ms, P95 <= 300ms, drop rate <= 1%, education and meeting coverage, and replay link.',
  },
  'G-EDU-1': {
    priority: 'P0',
    owner: 'Product / AI',
    due: '2026-07-31 P0 education demo; 2026-09-20 first testimonial batch',
    sourceMilestone: '7/31 P0 education demo; 9/20 first trial testimonials',
    action: 'Record a real 5-8 minute teacher board session and review every generated lesson candidate with accept/edit/dismiss decisions.',
    command:
      'npm --workspace ./examples/ai-annotation-demo run evidence:demo-review -- <intake>/04-education-demo-review/raw/education-demo-review.csv --out <intake>/04-education-demo-review/reports/education-demo-review-report.json',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/education-demo-review.md',
    intakeFolder: '04-education-demo-review',
    doneWhen: 'Raw session, replay, video, exported lesson note, reviewer CSV, analyzer report, and campaign-demo-ready decision are linked.',
  },
  'G-MTG-1': {
    priority: 'P0',
    owner: 'Product / AI',
    due: '2026-08-20 Meeting App Alpha; 2026-08-31 dual-scenario demo',
    sourceMilestone: '8/20 Meeting App Alpha; 8/25 MeetingGraph Agent Alpha; 8/31 dual-scenario end-to-end',
    action: 'Record a real business whiteboard session and review decisions, actions, risks, and diagrams produced from marked board events.',
    command:
      'npm --workspace ./examples/ai-annotation-demo run evidence:demo-review -- <intake>/05-business-meeting-demo-review/raw/business-meeting-demo-review.csv --out <intake>/05-business-meeting-demo-review/reports/business-meeting-demo-review-report.json',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/business-meeting-demo-review.md',
    intakeFolder: '05-business-meeting-demo-review',
    doneWhen: 'Raw session, replay, video, exported meeting output, reviewer CSV, analyzer report, and board-mark evidence are linked.',
  },
  'G-SUPPLY-1': {
    priority: 'P0',
    owner: 'Ops / Hardware',
    due: '2026-09-05 EVT BOM v0.1; 2026-09-30 BOM >= 80%',
    sourceMilestone: '9/05 EVT BOM v0.1; 9/30 launch readiness review',
    action: 'Build BOM v0.2 with unit costs, MOQ, lead time, primary supplier, backup supplier, quote status, and quote files for core rows.',
    command:
      'npm --workspace ./examples/ai-annotation-demo run evidence:reward-pricing -- <intake>/06-bom-supplier-readiness/raw/bom.csv --out <intake>/06-bom-supplier-readiness/reports/reward-pricing-report.json',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/bom-supplier-tracker.md',
    intakeFolder: '06-bom-supplier-readiness',
    doneWhen: 'BOM completeness >= 80%, confirmed quote coverage >= 80%, backup coverage >= 80%, pricing sheet, analyzer report, and quote folder are linked.',
  },
  'G-GTM-1': {
    priority: 'P0',
    owner: 'GTM',
    due: '2026-09-30 checkpoint; 2026-10-15 launch target review',
    sourceMilestone: '9/30 email >= 500 and KS followers >= 150; before launch email >= 1000 and KS followers >= 300',
    action: 'Export weekly CRM, Kickstarter follower, testimonial, and first-day supporter snapshots with education/business segment split.',
    command:
      'npm --workspace ./examples/ai-annotation-demo run evidence:gtm-metrics -- <intake>/07-gtm-demand-readiness/raw/gtm-snapshots.csv --out <intake>/07-gtm-demand-readiness/reports/gtm-report.json',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/gtm-metrics-tracker.md',
    intakeFolder: '07-gtm-demand-readiness',
    doneWhen: 'Email >= 1000, KS followers >= 300, testimonials >= 8, first-day likely backers >= 50, source exports, and analyzer report are linked.',
  },
  'G-PAGE-1': {
    priority: 'P0',
    owner: 'Campaign / Legal',
    due: '2026-09-10 page draft; 2026-10-20 page, price, risk freeze',
    sourceMilestone: '9/10 Kickstarter page draft; 10/16-10/20 page freeze',
    action: 'Prepare Kickstarter preview, claim evidence links, AI/privacy disclosure, risk disclosures, rewards/FAQ, video script, and outside legal/privacy review.',
    command: 'npm run verify:kickstarter-claims',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/kickstarter-page-risk-checklist.md',
    intakeFolder: '08-kickstarter-page-review',
    doneWhen: 'Kickstarter preview link, legal/privacy review link, campaign page draft, video script, and claim-evidence matrix all pass review.',
  },
};

function actionStatus(gateResult) {
  if (gateResult.status === 'launch_ready_evidence_present') return 'ready';
  if ((gateResult.placeholder_count ?? 0) > 0) return 'needs_real_evidence';
  if (gateResult.analyzer_checks_total > 0 && gateResult.analyzer_checks_passed < gateResult.analyzer_checks_total) {
    return 'needs_analyzer_report';
  }
  if (gateResult.artifact_checks_passed < gateResult.artifact_checks_total) return 'needs_artifacts';
  if (gateResult.positive_checks_passed < gateResult.positive_checks_total) return 'needs_decision';
  return 'needs_review';
}

function buildActionItems(report) {
  return report.gates.map((gate) => {
    const meta = gateActions[gate.id];
    if (!meta) throw new Error(`missing action metadata for ${gate.id}`);
    return {
      id: gate.id,
      label: gate.label,
      priority: meta.priority,
      owner: meta.owner,
      due: meta.due,
      source_milestone: meta.sourceMilestone,
      status: actionStatus(gate),
      action: meta.action,
      evidence_record: meta.record,
      intake_folder: meta.intakeFolder,
      command: meta.command,
      done_when: meta.doneWhen,
      audit: {
        status: gate.status,
        placeholder_count: gate.placeholder_count,
        positive_checks: `${gate.positive_checks_passed}/${gate.positive_checks_total}`,
        artifact_checks: `${gate.artifact_checks_passed}/${gate.artifact_checks_total}`,
        analyzer_checks: `${gate.analyzer_checks_passed}/${gate.analyzer_checks_total}`,
        blockers: gate.blockers,
      },
    };
  });
}

function readme(report, actionItems) {
  const rows = actionItems
    .map(
      (item) =>
        `| ${item.priority} | ${item.id} | ${item.status} | ${item.owner} | ${item.due} | ${item.action} | \`${item.evidence_record}\` |`,
    )
    .join('\n');
  const details = actionItems
    .map(
      (item) => `## ${item.id} ${item.label}

- Owner: ${item.owner}
- Due: ${item.due}
- Source milestone: ${item.source_milestone}
- Intake folder: \`${item.intake_folder}\`
- Evidence record: \`${item.evidence_record}\`
- Command: \`${item.command}\`
- Done when: ${item.done_when}
- Audit: positive ${item.audit.positive_checks}, artifacts ${item.audit.artifact_checks}, analyzer ${item.audit.analyzer_checks}, placeholders ${item.audit.placeholder_count ?? 'n/a'}
- Blockers: ${item.audit.blockers.join('; ')}
`,
    )
    .join('\n');

  return `# InkLoop AI Pen Launch Action Plan

Schema: \`inkloop.launch_action_plan.v1\`

Generated from: \`${auditPath}\`

Audit status: ${report.status}

This action plan converts the latest launch evidence audit into an execution queue. It does not make any launch claim. A gate moves out of this list only when the evidence record contains real artifacts, required analyzer reports, and pass or conditional-pass decisions.

## Summary

| Priority | Gate | Status | Owner | Due | Next Action | Evidence Record |
| --- | --- | --- | --- | --- | --- | --- |
${rows}

## Operating Loop

1. Run \`npm run launch:evidence:intake\` for a new dated intake package.
2. Put real raw files, videos, quote PDFs, CRM exports, or review notes into the matching gate folder.
3. Run the gate analyzer command when the gate has one.
4. Run \`npm run launch:evidence:intake-audit\` to catch template-only folders, missing analyzer reports, failing \`gate_checks\`, or missing support files before editing records.
5. Paste raw artifact paths, analyzer report paths, review links, and decisions into the evidence record.
6. Run \`npm run launch:evidence:audit\`.
7. Keep \`npm run launch:evidence:audit:strict\` failing until every gate is genuinely ready.

${details}
`;
}

if (!existsSync(absolute(auditPath))) {
  throw new Error(`missing launch evidence audit report: ${auditPath}. Run npm run launch:evidence:audit first.`);
}

const report = readJson(auditPath);
const actionItems = buildActionItems(report);
const output = {
  schema: 'inkloop.launch_action_plan.v1',
  generated_at: new Date().toISOString(),
  audit_path: auditPath,
  audit_status: report.status,
  action_count: actionItems.length,
  not_ready_action_count: actionItems.filter((item) => item.status !== 'ready').length,
  action_items: actionItems,
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report, actionItems));

console.log(`Launch action plan status: ${output.audit_status}`);
console.log(`Action items: ${output.not_ready_action_count}/${output.action_count} not ready`);
console.log(`Report: ${outReadmePath}`);
