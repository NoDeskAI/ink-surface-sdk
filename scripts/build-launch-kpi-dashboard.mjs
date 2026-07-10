import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = 'test-results/ai-pen-launch-kpi-dashboard';
const outJsonPath = `${outDir}/dashboard.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

const sourcePaths = {
  launchAudit: 'test-results/ai-pen-launch-evidence-audit/report.json',
  intakeAudit: 'test-results/ai-pen-launch-evidence-intake-audit/report.json',
  actionPlan: 'test-results/ai-pen-launch-action-plan/action-plan.json',
  criticalPath: 'test-results/ai-pen-kickstarter-critical-path/critical-path.json',
  weeklySprint: 'test-results/ai-pen-kickstarter-weekly-sprint/weekly-sprint.json',
};

const metricDefinitions = [
  {
    id: 'KPI-HW-PROTOTYPES',
    line: 'Pen Hardware',
    metric: '可演示 AI Pen 样机数',
    target: '5+ verified prototype units',
    launch_gate_ids: ['G-HW-1'],
  },
  {
    id: 'KPI-SURFACE-A2',
    line: 'Pen Hardware',
    metric: 'A2 Surface 稳定性',
    target: 'P95 error <= 5mm and >=95% stable sessions',
    launch_gate_ids: ['G-SURF-1'],
  },
  {
    id: 'KPI-LIVE-LATENCY',
    line: 'Capture Runtime',
    metric: 'Live Board 延迟 P50',
    target: 'P50 <= 150ms, P95 <= 300ms',
    launch_gate_ids: ['G-LIVE-1'],
  },
  {
    id: 'KPI-STABLE-SESSION',
    line: 'Capture Runtime',
    metric: '30 分钟稳定 session 数',
    target: '>=90% real 30-minute sessions stable',
    launch_gate_ids: ['G-HW-1', 'G-LIVE-1'],
  },
  {
    id: 'KPI-EDU-USERS',
    line: 'Product / GTM',
    metric: '教育试用用户数',
    target: '20+ education users before launch',
    launch_gate_ids: ['G-GTM-1', 'G-EDU-1'],
  },
  {
    id: 'KPI-MTG-USERS',
    line: 'Product / GTM',
    metric: '商务试用团队数',
    target: '10+ business teams before launch',
    launch_gate_ids: ['G-GTM-1', 'G-MTG-1'],
  },
  {
    id: 'KPI-TESTIMONIALS',
    line: 'Product / GTM',
    metric: '可公开证言',
    target: '8+ consent-backed public testimonials',
    launch_gate_ids: ['G-GTM-1', 'G-EDU-1', 'G-MTG-1'],
  },
  {
    id: 'KPI-EMAIL-LIST',
    line: 'Campaign Ops',
    metric: 'Email list',
    target: '1,000+ opted-in emails',
    launch_gate_ids: ['G-GTM-1'],
  },
  {
    id: 'KPI-KS-FOLLOWERS',
    line: 'Campaign Ops',
    metric: 'KS followers',
    target: '300+ Kickstarter pre-launch followers',
    launch_gate_ids: ['G-GTM-1'],
  },
  {
    id: 'KPI-AI-USEFULNESS',
    line: 'AI / InkGraph',
    metric: 'AI 有用性',
    target: 'accept/edit/follow-up rate >=30%',
    launch_gate_ids: ['G-EDU-1', 'G-MTG-1'],
  },
  {
    id: 'KPI-SOURCE-REFS',
    line: 'AI / InkGraph',
    metric: 'source_refs 追溯率',
    target: '>=90% promoted outputs have valid source_refs',
    launch_gate_ids: ['G-EDU-1', 'G-MTG-1'],
  },
  {
    id: 'KPI-BOM',
    line: 'Pen Hardware',
    metric: 'BOM 完成度',
    target: '>=80% BOM completeness with supplier evidence',
    launch_gate_ids: ['G-SUPPLY-1'],
  },
  {
    id: 'KPI-PAGE-CLAIMS',
    line: 'Campaign Ops',
    metric: 'Kickstarter 页面证据链接',
    target: 'Page >=90% complete with reviewed claims and risk disclosure',
    launch_gate_ids: ['G-PAGE-1'],
  },
];

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function readJsonSource(key, relativePath) {
  if (!existsSync(absolute(relativePath))) {
    return { key, path: relativePath, available: false, error: `missing source file: ${relativePath}`, data: null };
  }

  try {
    return {
      key,
      path: relativePath,
      available: true,
      error: null,
      data: JSON.parse(readFileSync(absolute(relativePath), 'utf8')),
    };
  } catch (error) {
    return {
      key,
      path: relativePath,
      available: false,
      error: `unreadable source file: ${relativePath}: ${error.message}`,
      data: null,
    };
  }
}

function readSources() {
  return Object.fromEntries(
    Object.entries(sourcePaths).map(([key, relativePath]) => [key, readJsonSource(key, relativePath)]),
  );
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

function gateMaps({ launchAudit, actionPlan, criticalPath, weeklySprint }) {
  const gates = new Map((launchAudit?.gates ?? []).map((gate) => [gate.id, gate]));
  const actions = new Map((actionPlan?.action_items ?? []).map((action) => [action.id, action]));
  const pressures = new Map((criticalPath?.gate_pressure ?? []).map((gate) => [gate.id, gate]));
  const sprintTasks = new Map();

  for (const task of weeklySprint?.tasks ?? []) {
    const existing = sprintTasks.get(task.gate_id);
    if (!existing || task.days_to_due < existing.days_to_due) sprintTasks.set(task.gate_id, task);
  }

  return { gates, actions, pressures, sprintTasks };
}

function checkProgressForGate(gate) {
  if (!gate) return { passed: 0, total: 0, ratio: 0 };
  const passed = (gate.positive_checks_passed ?? 0) + (gate.artifact_checks_passed ?? 0) + (gate.analyzer_checks_passed ?? 0);
  const total = (gate.positive_checks_total ?? 0) + (gate.artifact_checks_total ?? 0) + (gate.analyzer_checks_total ?? 0);
  return { passed, total, ratio: total ? Number((passed / total).toFixed(4)) : 0 };
}

function aggregateProgress(gateIds, gates) {
  return gateIds.reduce(
    (acc, gateId) => {
      const progress = checkProgressForGate(gates.get(gateId));
      return {
        passed: acc.passed + progress.passed,
        total: acc.total + progress.total,
        ratio: 0,
      };
    },
    { passed: 0, total: 0, ratio: 0 },
  );
}

function strongestPressure(gateIds, pressures) {
  const order = ['overdue', 'at_risk', 'due_this_week', 'scheduled', 'documented_ready', 'unknown'];
  return gateIds
    .map((gateId) => pressures.get(gateId)?.pressure ?? 'unknown')
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
}

function currentStateForMetric(definition, gates) {
  const relatedGates = definition.launch_gate_ids.map((gateId) => gates.get(gateId)).filter(Boolean);
  if (relatedGates.length === 0) return 'No launch gate evidence loaded';
  if (relatedGates.every((gate) => gate.status === 'launch_ready_evidence_present')) return 'Verified by launch evidence';
  const placeholders = relatedGates.reduce((sum, gate) => sum + (gate.placeholder_count ?? 0), 0);
  const missingArtifacts = relatedGates.reduce(
    (sum, gate) => sum + Math.max(0, (gate.artifact_checks_total ?? 0) - (gate.artifact_checks_passed ?? 0)),
    0,
  );
  const missingReports = relatedGates.reduce(
    (sum, gate) => sum + Math.max(0, (gate.analyzer_checks_total ?? 0) - (gate.analyzer_checks_passed ?? 0)),
    0,
  );
  return `Not launch-verified: ${placeholders} placeholders, ${missingArtifacts} artifact gaps, ${missingReports} analyzer gaps`;
}

function nextActionForMetric(definition, { actions, pressures, sprintTasks }) {
  const sprintTask = definition.launch_gate_ids.map((gateId) => sprintTasks.get(gateId)).find(Boolean);
  if (sprintTask) return sprintTask.next_action;
  const pressure = definition.launch_gate_ids.map((gateId) => pressures.get(gateId)).find(Boolean);
  if (pressure?.next_action) return pressure.next_action;
  const action = definition.launch_gate_ids.map((gateId) => actions.get(gateId)).find(Boolean);
  return action?.action ?? 'Collect real evidence and update the matching evidence record.';
}

function buildMetrics({ launchAudit, actionPlan, criticalPath, weeklySprint }) {
  const maps = gateMaps({ launchAudit, actionPlan, criticalPath, weeklySprint });
  return metricDefinitions.map((definition) => {
    const progress = aggregateProgress(definition.launch_gate_ids, maps.gates);
    const ratio = progress.total ? Number((progress.passed / progress.total).toFixed(4)) : 0;
    const gateStatuses = definition.launch_gate_ids.map((gateId) => maps.gates.get(gateId)?.status ?? 'missing');
    const evidenceState = gateStatuses.every((status) => status === 'launch_ready_evidence_present')
      ? 'launch_evidence_ready'
      : 'needs_real_evidence';
    const pressure = strongestPressure(definition.launch_gate_ids, maps.pressures);

    return {
      ...definition,
      current: currentStateForMetric(definition, maps.gates),
      evidence_state: evidenceState,
      pressure,
      evidence_check_progress: {
        passed: progress.passed,
        total: progress.total,
        ratio,
      },
      evidence_records: definition.launch_gate_ids
        .map((gateId) => maps.gates.get(gateId)?.file ?? maps.actions.get(gateId)?.evidence_record)
        .filter(Boolean),
      next_week_action: nextActionForMetric(definition, maps),
    };
  });
}

function statusFor({ sourceErrors, launchAudit, metrics }) {
  if (sourceErrors.length > 0) return 'dashboard_missing_sources';
  if (launchAudit?.status === 'launch_ready_evidence_present' && metrics.every((metric) => metric.evidence_state === 'launch_evidence_ready')) {
    return 'launch_kpis_ready';
  }
  return 'launch_kpis_not_ready';
}

function metricRows(metrics) {
  if (metrics.length === 0) return '| n/a | n/a | n/a | n/a | n/a |';
  return metrics
    .map(
      (metric) =>
        `| ${metric.metric} | ${metric.current} | ${metric.target} | ${metric.pressure} / ${metric.evidence_state} | ${metric.next_week_action} |`,
    )
    .join('\n');
}

function gateRows(gates) {
  if (gates.length === 0) return '| n/a | n/a | n/a | n/a | n/a |';
  return gates
    .map(
      (gate) =>
        `| ${gate.id} | ${gate.label} | ${gate.status} | ${gate.placeholder_count ?? 'n/a'} | ${gate.blockers?.[0] ?? 'none'} |`,
    )
    .join('\n');
}

function readme(report) {
  const accessIssues = report.access_issues.length
    ? report.access_issues.map((issue) => `- ${issue}`).join('\n')
    : '- None';
  const commands = report.required_commands.map((command) => `- \`${command}\``).join('\n');
  const nonClaims = report.non_claims.map((claim) => `- ${claim}`).join('\n');

  return `# InkLoop AI Pen Launch KPI Dashboard

Schema: \`inkloop.launch_kpi_dashboard.v1\`

Status: \`${report.status}\`

This dashboard is the weekly meeting board from the Kickstarter source package. It maps the 10 月底 Launch KRs to current evidence gates, current pressure, and next-week actions. It does not convert local demo fixtures into launch proof.

## Summary

| Item | Value |
| --- | --- |
| Launch audit status | ${report.launch_status} |
| Intake audit status | ${report.intake_status} |
| Critical path status | ${report.critical_path_status} |
| Weekly sprint status | ${report.weekly_sprint_status} |
| Metrics ready | ${report.summary.ready_metric_count}/${report.summary.metric_count} |
| Metrics needing real evidence | ${report.summary.not_ready_metric_count}/${report.summary.metric_count} |
| Ready launch gates | ${report.summary.ready_gate_count}/${report.summary.gate_count} |
| Red launch gates | ${report.summary.red_gate_count} |
| At-risk gates | ${report.summary.at_risk_gate_count} |
| Days to preferred launch | ${report.summary.days_to_preferred_launch} |

## Weekly KPI Board

| Metric | Current | Target | Risk / Evidence State | Next Week Action |
| --- | --- | --- | --- | --- |
${metricRows(report.metrics)}

## Launch Gate Evidence

| Gate | Label | Status | Placeholder Count | First Blocker |
| --- | --- | --- | ---: | --- |
${gateRows(report.launch_gates)}

## Required Commands

${commands}

## Non-Claims

${nonClaims}

## Access Issues

${accessIssues}

Detailed JSON: [dashboard.json](./dashboard.json)
`;
}

const sources = readSources();
const sourceErrors = sourceIssues(sources);
const launchAudit = sources.launchAudit.data;
const intakeAudit = sources.intakeAudit.data;
const actionPlan = sources.actionPlan.data;
const criticalPath = sources.criticalPath.data;
const weeklySprint = sources.weeklySprint.data;
const metrics = buildMetrics({ launchAudit, actionPlan, criticalPath, weeklySprint });
const readyMetrics = metrics.filter((metric) => metric.evidence_state === 'launch_evidence_ready');
const atRiskGateCount = (criticalPath?.gate_pressure ?? []).filter((gate) => gate.pressure === 'at_risk').length;

const report = {
  schema: 'inkloop.launch_kpi_dashboard.v1',
  generated_at: new Date().toISOString(),
  status: statusFor({ sourceErrors, launchAudit, metrics }),
  sources: sourceMap(sources),
  access_issues: sourceErrors,
  launch_status: launchAudit?.status ?? 'unknown',
  intake_status: intakeAudit?.status ?? 'unknown',
  critical_path_status: criticalPath?.status ?? 'unknown',
  weekly_sprint_status: weeklySprint?.status ?? 'unknown',
  summary: {
    metric_count: metrics.length,
    ready_metric_count: readyMetrics.length,
    not_ready_metric_count: metrics.length - readyMetrics.length,
    gate_count: launchAudit?.summary?.gate_count ?? 0,
    ready_gate_count: launchAudit?.summary?.ready_gate_count ?? 0,
    red_gate_count: launchAudit?.summary?.not_ready_gate_count ?? 0,
    at_risk_gate_count: atRiskGateCount,
    days_to_preferred_launch: criticalPath?.summary?.days_to_preferred_launch ?? null,
  },
  metrics,
  launch_gates: launchAudit?.gates ?? [],
  required_commands: [
    'npm run launch:evidence:audit',
    'npm run launch:action-plan',
    'npm run launch:critical-path',
    'npm run launch:weekly-sprint',
    'npm run launch:kpi-dashboard',
    'npm run launch:review-pack',
  ],
  non_claims: [
    'This KPI dashboard is a weekly management view, not launch approval.',
    'Demo fixtures, analyzer samples, and local smoke tests do not count as real KPI current values.',
    'A metric is launch-ready only when its evidence records contain real artifacts, passing analyzer reports, and a pass or conditional-pass decision.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Launch KPI dashboard status: ${report.status}`);
console.log(`Metrics ready: ${report.summary.ready_metric_count}/${report.summary.metric_count}`);
console.log(`Launch gates ready: ${report.summary.ready_gate_count}/${report.summary.gate_count}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status === 'dashboard_missing_sources') {
  console.error('Strict launch KPI dashboard failed: required source reports are missing or unreadable.');
  process.exit(1);
}
