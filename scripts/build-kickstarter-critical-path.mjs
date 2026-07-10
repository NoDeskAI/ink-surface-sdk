import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const actionPlanPath = 'test-results/ai-pen-launch-action-plan/action-plan.json';
const launchAuditPath = 'test-results/ai-pen-launch-evidence-audit/report.json';
const intakeAuditPath = 'test-results/ai-pen-launch-evidence-intake-audit/report.json';
const outDir = 'test-results/ai-pen-kickstarter-critical-path';
const outJsonPath = `${outDir}/critical-path.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');
const msPerDay = 24 * 60 * 60 * 1000;

const launchWindow = {
  preferred_open: '2026-10-27',
  preferred_close: '2026-10-28',
  latest_fallback: '2026-10-30',
  avoid: '2026-10-31',
};

const milestones = [
  {
    date: '2026-07-05',
    phase: 'G0 scope freeze',
    milestone: 'Kickstarter product scope frozen',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: [],
    owner: 'Product / Campaign',
    evidence_needed: 'AI Pen + Capture Surface + App promise remains frozen; no e-paper base reward or arbitrary whiteboard promise.',
    local_status: 'documented_ready',
  },
  {
    date: '2026-07-07',
    phase: 'G0 architecture freeze',
    milestone: 'V1 architecture and data-contract docs frozen',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: [],
    owner: 'Product / Architecture',
    evidence_needed: 'Project docs, architecture, module plan, and InkGraph contract stay aligned to source package.',
    local_status: 'documented_ready',
  },
  {
    date: '2026-07-10',
    phase: 'G1 schema freeze',
    milestone: 'PenFrame / InkEvent schema frozen',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: [],
    owner: 'Runtime / AI',
    evidence_needed: 'RawPenFrame, InkEvent, LessonGraph, MeetingGraph, and KnowledgeObject validators remain in standard verification.',
    local_status: 'documented_ready',
  },
  {
    date: '2026-07-15',
    phase: 'G1 P0 hardware',
    milestone: 'P0 AI Pen prototype can output pen down/up and coordinates',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-HW-1'],
    owner: 'Hardware / Runtime',
    evidence_needed: 'Real or closest engineering prototype raw pen log, firmware, replay/export, and video.',
  },
  {
    date: '2026-07-18',
    phase: 'G1 Capture Surface',
    milestone: 'Capture Surface material test 1',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-SURF-1'],
    owner: 'Hardware',
    evidence_needed: 'Material batch, glare/wipe/ink notes, calibration CSV, analyzer report, and photo/video evidence.',
  },
  {
    date: '2026-07-21',
    phase: 'G1 Live Board',
    milestone: 'Live Board demo with real or closest prototype input',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-HW-1', 'G-LIVE-1'],
    owner: 'Runtime',
    evidence_needed: 'Real transport timing from raw frame through host receive, InkEvent append, and render commit.',
  },
  {
    date: '2026-07-31',
    phase: 'G2 education demo',
    milestone: 'P0 education demo',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-EDU-1'],
    owner: 'Product / AI',
    evidence_needed: '5-8 minute teacher board session, exported lesson note, reviewer CSV, analyzer report, and public-demo decision.',
  },
  {
    date: '2026-08-20',
    phase: 'G3 meeting alpha',
    milestone: 'Meeting App Alpha',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-MTG-1'],
    owner: 'Product / AI',
    evidence_needed: 'Business whiteboard session, reviewed decisions/actions/risks/diagrams, board-mark evidence, and analyzer report.',
  },
  {
    date: '2026-08-31',
    phase: 'G3 dual-scenario demo',
    milestone: '5 demo units and education/business dual-scenario end-to-end demo',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-HW-1', 'G-LIVE-1', 'G-EDU-1', 'G-MTG-1'],
    owner: 'Hardware / Runtime / Product',
    evidence_needed: 'Five units, real latency report, real education review, real meeting review, and replay/video assets.',
  },
  {
    date: '2026-09-05',
    phase: 'G4 supply',
    milestone: 'EVT BOM v0.1',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-SUPPLY-1'],
    owner: 'Ops / Hardware',
    evidence_needed: 'BOM v0.2 path, supplier quotes, backup suppliers, lead times, MOQ, pricing analyzer report.',
  },
  {
    date: '2026-09-10',
    phase: 'G5 page draft',
    milestone: 'Kickstarter page draft',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-PAGE-1'],
    owner: 'Campaign / Legal',
    evidence_needed: 'Kickstarter preview, page draft, video script, risk/AI privacy copy, and claim evidence links.',
  },
  {
    date: '2026-09-20',
    phase: 'G4 testimonials',
    milestone: 'First trial testimonial batch',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-GTM-1', 'G-EDU-1', 'G-MTG-1'],
    owner: 'GTM / Product',
    evidence_needed: 'At least 8 consent-backed public testimonials plus education/business trial evidence.',
  },
  {
    date: '2026-09-25',
    phase: 'G5 campaign video',
    milestone: 'Main campaign video rough cut',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-HW-1', 'G-SURF-1', 'G-LIVE-1', 'G-EDU-1', 'G-MTG-1', 'G-PAGE-1'],
    owner: 'Campaign / Product / Hardware',
    evidence_needed: 'Real prototype proof shots, approved claim reviews, and visible risk/limits disclosure.',
  },
  {
    date: '2026-09-30',
    phase: 'G4/G5 readiness review',
    milestone: 'Launch Readiness Review',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-HW-1', 'G-SURF-1', 'G-LIVE-1', 'G-EDU-1', 'G-MTG-1', 'G-SUPPLY-1', 'G-GTM-1', 'G-PAGE-1'],
    owner: 'All workstreams',
    evidence_needed: 'Technology, supply, page, campaign video, testimonials, prelaunch metrics, and claim evidence all over threshold.',
  },
  {
    date: '2026-10-15',
    phase: 'G5 launch target review',
    milestone: 'Pre-launch audience and page target review',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-GTM-1', 'G-PAGE-1'],
    owner: 'GTM / Campaign',
    evidence_needed: 'Email list >= 1000, KS followers >= 300, testimonials >= 8, first-day likely backers >= 50, and reviewed page assets.',
  },
  {
    date: '2026-10-20',
    phase: 'G6 launch freeze',
    milestone: 'Page, price, FAQ, risk, AI disclosure, rewards, and video freeze',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-SUPPLY-1', 'G-GTM-1', 'G-PAGE-1'],
    owner: 'Campaign / Legal / Ops',
    evidence_needed: 'Frozen preview page, legal/privacy review, reward pricing, supplier-backed copy, and final video.',
  },
  {
    date: '2026-10-24',
    phase: 'G6 launch notification',
    milestone: 'Media, community, and seed-user launch notifications locked',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-GTM-1', 'G-PAGE-1'],
    owner: 'GTM',
    evidence_needed: 'First-day supporter list, campaign announcement assets, and FAQ/comment scripts.',
  },
  {
    date: launchWindow.preferred_open,
    phase: 'G6 preferred launch',
    milestone: 'Preferred Kickstarter launch window opens',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-HW-1', 'G-SURF-1', 'G-LIVE-1', 'G-EDU-1', 'G-MTG-1', 'G-SUPPLY-1', 'G-GTM-1', 'G-PAGE-1'],
    owner: 'All workstreams',
    evidence_needed: 'Strict launch evidence audit passes and no unsupported campaign claims remain.',
  },
  {
    date: launchWindow.latest_fallback,
    phase: 'G6 latest fallback',
    milestone: 'Latest Kickstarter fallback launch date',
    source: 'source/05_目标与里程碑_10月底Kickstarter倒排.md',
    gate_ids: ['G-HW-1', 'G-SURF-1', 'G-LIVE-1', 'G-EDU-1', 'G-MTG-1', 'G-SUPPLY-1', 'G-GTM-1', 'G-PAGE-1'],
    owner: 'All workstreams',
    evidence_needed: 'If strict launch evidence is still not ready by this date, the public launch promise must be downgraded or delayed.',
  },
];

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(absolute(relativePath), 'utf8'));
}

function readJsonSource(relativePath) {
  if (!existsSync(absolute(relativePath))) return { available: false, data: null, error: `missing ${relativePath}` };
  try {
    return { available: true, data: readJson(relativePath), error: null };
  } catch (error) {
    return {
      available: false,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function asUtcDate(dateString) {
  return new Date(`${dateString}T00:00:00.000Z`);
}

function daysBetween(startDate, endDate) {
  return Math.ceil((asUtcDate(endDate).getTime() - asUtcDate(startDate).getTime()) / msPerDay);
}

function earliestIsoDate(value) {
  const dates = String(value ?? '').match(/2026-\d{2}-\d{2}/g) ?? [];
  return dates.sort()[0] ?? null;
}

function milestoneStatus({ daysToDue, gateStatuses, localStatus, launchReady }) {
  if (localStatus === 'documented_ready') return 'documented_ready';
  if (launchReady && gateStatuses.length > 0) return 'ready';
  if (gateStatuses.length > 0 && gateStatuses.every((status) => status === 'ready')) return 'ready';
  if (daysToDue < 0) return 'overdue';
  if (daysToDue <= 7) return 'due_this_week';
  if (daysToDue <= 21) return 'at_risk';
  return 'scheduled';
}

function pressureStatus(daysToDue, itemStatus) {
  if (itemStatus === 'ready') return 'ready';
  if (daysToDue === null) return 'unscheduled';
  if (daysToDue < 0) return 'overdue';
  if (daysToDue <= 7) return 'due_this_week';
  if (daysToDue <= 21) return 'at_risk';
  return 'scheduled';
}

function buildCriticalPath({ actionPlan, launchAudit, intakeAudit, analysisDate }) {
  const actionItems = Array.isArray(actionPlan?.action_items) ? actionPlan.action_items : [];
  const actionById = new Map(actionItems.map((item) => [item.id, item]));
  const launchReady = launchAudit?.status === 'launch_ready_evidence_present';
  return milestones.map((milestone) => {
    const gateItems = milestone.gate_ids.map((id) => actionById.get(id)).filter(Boolean);
    const gateStatuses = gateItems.map((item) => item.status);
    const daysToDue = daysBetween(analysisDate, milestone.date);
    const status = milestoneStatus({
      daysToDue,
      gateStatuses,
      localStatus: milestone.local_status,
      launchReady,
    });
    return {
      ...milestone,
      days_to_due: daysToDue,
      status,
      gates: gateItems.map((item) => ({
        id: item.id,
        label: item.label,
        status: item.status,
        evidence_record: item.evidence_record,
        next_action: item.action,
        blockers: item.audit?.blockers ?? [],
      })),
      intake_audit_status: intakeAudit?.status ?? 'unknown',
      launch_audit_status: launchAudit?.status ?? 'unknown',
    };
  });
}

function buildGatePressure({ actionPlan, analysisDate }) {
  const actionItems = Array.isArray(actionPlan?.action_items) ? actionPlan.action_items : [];
  return actionItems.map((item) => {
    const earliestDue = earliestIsoDate(item.due);
    const daysToDue = earliestDue ? daysBetween(analysisDate, earliestDue) : null;
    return {
      id: item.id,
      label: item.label,
      priority: item.priority,
      owner: item.owner,
      due: item.due,
      earliest_due: earliestDue,
      days_to_due: daysToDue,
      pressure: pressureStatus(daysToDue, item.status),
      action_status: item.status,
      next_action: item.action,
      evidence_record: item.evidence_record,
      blocker_count: item.audit?.blockers?.length ?? 0,
      blockers: item.audit?.blockers ?? [],
    };
  });
}

function overallStatus(criticalPath) {
  if (criticalPath.some((item) => item.status === 'overdue')) return 'critical_path_blocked';
  if (criticalPath.some((item) => item.status === 'due_this_week' || item.status === 'at_risk')) return 'critical_path_at_risk';
  return 'critical_path_on_track';
}

function statusCounts(items) {
  return items.reduce((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
}

function pressureCounts(items) {
  return items.reduce((counts, item) => {
    counts[item.pressure] = (counts[item.pressure] ?? 0) + 1;
    return counts;
  }, {});
}

function milestoneRows(items) {
  return items
    .map(
      (item) =>
        `| ${item.date} | ${item.days_to_due} | ${item.phase} | ${item.status} | ${item.milestone} | ${item.gate_ids.join(', ') || 'docs'} | ${item.owner} | ${item.evidence_needed} |`,
    )
    .join('\n');
}

function pressureRows(items) {
  return items
    .map(
      (item) =>
        `| ${item.priority} | ${item.id} | ${item.pressure} | ${item.earliest_due ?? 'n/a'} | ${item.days_to_due ?? 'n/a'} | ${item.owner} | ${item.next_action} |`,
    )
    .join('\n');
}

function readme(report) {
  return `# InkLoop AI Pen Kickstarter Critical Path

Schema: \`inkloop.kickstarter_critical_path.v1\`

Generated at: ${report.generated_at}

Analysis date: ${report.analysis_date}

Status: \`${report.status}\`

This report turns the October 2026 Kickstarter countdown into a date-pressure view. It does not make any launch claim and does not replace the launch evidence audit.

## Summary

| Item | Value |
| --- | --- |
| Preferred launch window | ${report.launch_window.preferred_open} to ${report.launch_window.preferred_close} |
| Latest fallback | ${report.launch_window.latest_fallback} |
| Days to preferred launch | ${report.summary.days_to_preferred_launch} |
| Days to latest fallback | ${report.summary.days_to_latest_fallback} |
| Launch audit status | ${report.launch_audit_status} |
| Intake audit status | ${report.intake_audit_status} |
| Critical milestones | ${report.summary.milestone_count} |
| Overdue milestones | ${report.summary.status_counts.overdue ?? 0} |
| Due this week | ${report.summary.status_counts.due_this_week ?? 0} |
| At risk within 21 days | ${report.summary.status_counts.at_risk ?? 0} |
| Red gate actions | ${report.summary.red_gate_count} |

## Critical Milestones

| Date | Days | Phase | Status | Milestone | Gates | Owner | Evidence Needed |
| --- | ---: | --- | --- | --- | --- | --- | --- |
${milestoneRows(report.critical_path)}

## Red Gate Date Pressure

| Priority | Gate | Pressure | Earliest Due | Days | Owner | Next Action |
| --- | --- | --- | --- | ---: | --- | --- |
${pressureRows(report.gate_pressure)}

## Non-Claims

${report.non_claims.map((item) => `- ${item}`).join('\n')}

Detailed JSON: [critical-path.json](./critical-path.json)
`;
}

const generatedAt = new Date().toISOString();
const analysisDate = dateOnly(new Date(generatedAt));
const actionPlanSource = readJsonSource(actionPlanPath);
const launchAuditSource = readJsonSource(launchAuditPath);
const intakeAuditSource = readJsonSource(intakeAuditPath);
if (!actionPlanSource.available) throw new Error(`missing action plan: ${actionPlanSource.error}. Run npm run launch:action-plan first.`);

const criticalPath = buildCriticalPath({
  actionPlan: actionPlanSource.data,
  launchAudit: launchAuditSource.data,
  intakeAudit: intakeAuditSource.data,
  analysisDate,
});
const gatePressure = buildGatePressure({ actionPlan: actionPlanSource.data, analysisDate });
const status = overallStatus(criticalPath);
const report = {
  schema: 'inkloop.kickstarter_critical_path.v1',
  generated_at: generatedAt,
  analysis_date: analysisDate,
  strict,
  status,
  launch_window: launchWindow,
  source_files: [
    'docs/project/inkloop-ai-pen-kickstarter/source/05_目标与里程碑_10月底Kickstarter倒排.md',
    actionPlanPath,
    launchAuditPath,
    intakeAuditPath,
  ],
  launch_audit_status: launchAuditSource.data?.status ?? 'unknown',
  intake_audit_status: intakeAuditSource.data?.status ?? 'unknown',
  summary: {
    days_to_preferred_launch: daysBetween(analysisDate, launchWindow.preferred_open),
    days_to_latest_fallback: daysBetween(analysisDate, launchWindow.latest_fallback),
    milestone_count: criticalPath.length,
    status_counts: statusCounts(criticalPath),
    gate_pressure_counts: pressureCounts(gatePressure),
    red_gate_count: gatePressure.filter((item) => item.action_status !== 'ready').length,
  },
  non_claims: [
    'This report is a countdown and risk view only.',
    'It does not prove real hardware, Capture Surface, GTM, supplier, or Kickstarter page readiness.',
    'A milestone can be documented-ready locally while the public launch still requires strict evidence audit pass.',
  ],
  critical_path: criticalPath,
  gate_pressure: gatePressure,
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Kickstarter critical path status: ${report.status}`);
console.log(`Days to preferred launch: ${report.summary.days_to_preferred_launch}`);
console.log(`Milestones: overdue=${report.summary.status_counts.overdue ?? 0}, due_this_week=${report.summary.status_counts.due_this_week ?? 0}, at_risk=${report.summary.status_counts.at_risk ?? 0}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status === 'critical_path_blocked') {
  console.error('Strict Kickstarter critical path failed: at least one dated launch milestone is overdue.');
  process.exit(1);
}
