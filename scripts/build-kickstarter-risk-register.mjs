import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourceRiskPath = 'docs/project/inkloop-ai-pen-kickstarter/source/07_风险_验收指标_降级方案.md';
const launchAuditPath = 'test-results/ai-pen-launch-evidence-audit/report.json';
const actionPlanPath = 'test-results/ai-pen-launch-action-plan/action-plan.json';
const criticalPathPath = 'test-results/ai-pen-kickstarter-critical-path/critical-path.json';
const weeklySprintPath = 'test-results/ai-pen-kickstarter-weekly-sprint/weekly-sprint.json';
const kpiDashboardPath = 'test-results/ai-pen-launch-kpi-dashboard/dashboard.json';
const claimDowngradePath = 'test-results/ai-pen-kickstarter-claim-downgrade/claim-downgrade.json';
const publicCopyLockPath = 'test-results/ai-pen-kickstarter-public-copy-lock/copy-lock.json';
const outDir = 'test-results/ai-pen-kickstarter-risk-register';
const outJsonPath = `${outDir}/risk-register.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

const riskDefinitions = [
  {
    id: 'R-OPTICAL',
    risk: '光学定位稳定性',
    probability: '高',
    impact: '高',
    owner: 'Hardware / Runtime',
    gate_ids: ['G-HW-1', 'G-SURF-1'],
    claim_ids: ['C-HW-2', 'C-SURF-1'],
    early_signals: ['笔迹漂移', '丢点', '边缘误差大'],
    downgrade_path: '缩小首发 Surface 尺寸为 A3/A2 Starter；提升校准点密度；公开演示限制。',
    p0_trigger: 'AI Pen 无法稳定输出坐标流，或 A2 Capture Surface 在演示场景漂移严重。',
    p0_relevant: true,
  },
  {
    id: 'R-SURFACE-MATERIAL',
    risk: 'Surface 材料',
    probability: '高',
    impact: '高',
    owner: 'Hardware',
    gate_ids: ['G-SURF-1'],
    claim_ids: ['C-SURF-1', 'C-SURF-2'],
    early_signals: ['墨水覆盖后读取下降', '会议室灯光反光', '擦除循环后质量波动'],
    downgrade_path: '限定 Surface 批次、尺寸、墨水类型和光照条件；页面明确 Capture Surface 是必需组件。',
    p0_trigger: 'A2/A3 Surface 稳定性、墨水遮挡、反光测试不能支撑公开演示。',
    p0_relevant: true,
  },
  {
    id: 'R-PEN-ERGONOMICS',
    risk: '笔身结构',
    probability: '中',
    impact: '中',
    owner: 'Hardware',
    gate_ids: ['G-HW-1'],
    claim_ids: ['C-HW-1'],
    early_signals: ['笔身偏粗', '重心差', '试写反馈差'],
    downgrade_path: 'P0 接受偏粗工程样机；P1 再优化结构、握持和重心；页面只展示真实样机状态。',
    p0_trigger: '结构体验影响 demo 可信度，但不是单独的 P0，除非导致 30 分钟 session 失败。',
    p0_relevant: false,
  },
  {
    id: 'R-BLE-LIVE',
    risk: 'BLE 延迟',
    probability: '中',
    impact: '中',
    owner: 'Runtime',
    gate_ids: ['G-LIVE-1'],
    claim_ids: ['C-LIVE-1'],
    early_signals: ['Live Board 不流畅', '丢包', '30 分钟 session 崩溃'],
    downgrade_path: 'Host 端补点平滑和本地缓存；必要时改用有线、专用 2.4G 或 Hub 路线；云端 AI 不进入实时主链路。',
    p0_trigger: 'Live Board 延迟不可接受，或 30 分钟 session 容易崩溃。',
    p0_relevant: true,
  },
  {
    id: 'R-AI-USEFULNESS',
    risk: 'AI 有用性',
    probability: '中',
    impact: '高',
    owner: 'Product / AI',
    gate_ids: ['G-EDU-1', 'G-MTG-1'],
    claim_ids: ['C-EDU-1', 'C-MTG-1'],
    early_signals: ['公式或步骤错误', 'Mermaid 图错误', '行动项/决策需要大量重写'],
    downgrade_path: 'AI 输出保持 editable/reviewable；公式和图解标 needs_review 或 Beta；公开页不承诺完美识别。',
    p0_trigger: '真实教育或商务 demo 不能产出可接受/可编辑的候选结果。',
    p0_relevant: false,
  },
  {
    id: 'R-SOURCE-REFS',
    risk: 'source_refs',
    probability: '中',
    impact: '高',
    owner: 'Product / AI / Runtime',
    gate_ids: ['G-EDU-1', 'G-MTG-1'],
    claim_ids: ['C-AI-1', 'C-EDU-1', 'C-MTG-1'],
    early_signals: ['AI 结果无法反查', 'Result Validator 拦不住无来源对象', 'Obsidian 投影缺少回跳链接'],
    downgrade_path: '无 source_refs 的 AI 结果只进 debug，不进入公开 demo 或知识投影；先保留 reviewed/editable 输出。',
    p0_trigger: 'AI 结果无法追溯 source_refs。',
    p0_relevant: true,
  },
  {
    id: 'R-BOM-SUPPLY',
    risk: 'BOM',
    probability: '中',
    impact: '高',
    owner: 'Ops / Hardware',
    gate_ids: ['G-SUPPLY-1'],
    claim_ids: ['C-SUPPLY-1'],
    early_signals: ['关键传感器采购周期长', 'Surface 供应商不稳定', '奖励档价格无法覆盖成本'],
    downgrade_path: '先锁定 2 家备选和现货评估路线；未拿到报价前不公开确定价格、数量或交付承诺。',
    p0_trigger: 'BOM / 供应链无法支持奖励档价格。',
    p0_relevant: true,
  },
  {
    id: 'R-PRELAUNCH',
    risk: 'Prelaunch followers',
    probability: '中',
    impact: '高',
    owner: 'GTM',
    gate_ids: ['G-GTM-1'],
    claim_ids: ['C-GTM-1'],
    early_signals: ['Email list 增长慢', 'KS followers 不足', '首日支持名单薄弱'],
    downgrade_path: '缩小首发受众和广告承诺；把推广节奏改成受众验证优先，不用冷启动硬上。',
    p0_trigger: 'GTM 证据不足会影响上线判断，但不单独作为技术 P0。',
    p0_relevant: false,
  },
  {
    id: 'R-KS-PAGE',
    risk: 'Kickstarter 页面审核',
    probability: '中',
    impact: '中',
    owner: 'Campaign / Legal',
    gate_ids: ['G-PAGE-1'],
    claim_ids: ['C-HW-1', 'C-HW-2', 'C-SURF-1', 'C-LIVE-1', 'C-AI-1', 'C-SUPPLY-1', 'C-GTM-1'],
    early_signals: ['页面像概念片', '用户误解任意白板适配', 'AI/privacy/交付风险披露不足'],
    downgrade_path: '页面只承诺 Live Board、Replay、AI Notes/Actions；Beta/roadmap 功能降级为计划或风险披露。',
    p0_trigger: '页面承诺和真实能力不一致。',
    p0_relevant: true,
  },
];

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function readJsonSource(relativePath) {
  if (!existsSync(absolute(relativePath))) {
    return { path: relativePath, available: false, error: `missing source file: ${relativePath}`, data: null };
  }
  try {
    return { path: relativePath, available: true, error: null, data: JSON.parse(readFileSync(absolute(relativePath), 'utf8')) };
  } catch (error) {
    return { path: relativePath, available: false, error: `unreadable source file: ${relativePath}: ${error.message}`, data: null };
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

function mapById(items) {
  return new Map((items ?? []).map((item) => [item.id, item]));
}

function groupMetricsByGate(metrics) {
  const map = new Map();
  for (const metric of metrics ?? []) {
    for (const gateId of metric.launch_gate_ids ?? []) {
      const existing = map.get(gateId) ?? [];
      existing.push(metric);
      map.set(gateId, existing);
    }
  }
  return map;
}

function groupTasksByGate(tasks) {
  const map = new Map();
  for (const task of tasks ?? []) {
    const existing = map.get(task.gate_id) ?? [];
    existing.push(task);
    map.set(task.gate_id, existing);
  }
  return map;
}

function claimById(claims) {
  return new Map((claims ?? []).map((claim) => [claim.claim_id, claim]));
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

function gateIsReady(gate) {
  return gate?.status === 'launch_ready_evidence_present';
}

function claimIsBlocked(claim) {
  return ['draft_only_until_evidence', 'demo_wording_only', 'review_required'].includes(claim?.public_decision);
}

function publicCopyIsBlocked(publicCopyLock) {
  return publicCopyLock?.status !== 'public_copy_lock_ready';
}

function pressureRank(pressure) {
  if (pressure === 'overdue') return 4;
  if (pressure === 'due_this_week') return 3;
  if (pressure === 'at_risk') return 2;
  if (pressure === 'scheduled') return 1;
  return 0;
}

function strongestPressure(pressures) {
  return pressures.reduce((strongest, pressure) => (pressureRank(pressure) > pressureRank(strongest) ? pressure : strongest), 'unknown');
}

function currentStatus({ gates, claims, pressure, publicCopyBlocked }) {
  if (publicCopyBlocked) return 'public_copy_lock_not_ready';
  if (gates.some((gate) => !gateIsReady(gate)) && pressure === 'at_risk') return 'at_risk_real_evidence_missing';
  if (gates.some((gate) => !gateIsReady(gate))) return 'open_real_evidence_missing';
  if (claims.some(claimIsBlocked)) return 'copy_downgrade_required';
  return 'controlled';
}

function p0Status({ definition, gates, claims, pressure, publicCopyBlocked }) {
  const gateOpen = gates.some((gate) => !gateIsReady(gate));
  const claimBlocked = claims.some((claim) => claim?.public_decision === 'draft_only_until_evidence');
  if (definition.p0_relevant && (gateOpen || claimBlocked || publicCopyBlocked)) return 'p0_open';
  if (gateOpen && definition.impact.includes('高')) return 'launch_blocking_watch';
  if (pressure === 'at_risk') return 'watch_this_week';
  return 'controlled';
}

function buildRiskRegister({ launchAudit, actionPlan, criticalPath, weeklySprint, kpiDashboard, claimDowngrade, publicCopyLock }) {
  const gates = mapById(launchAudit?.gates ?? []);
  const actions = mapById(actionPlan?.action_items ?? []);
  const gatePressure = mapById(criticalPath?.gate_pressure ?? []);
  const metricsByGate = groupMetricsByGate(kpiDashboard?.metrics ?? []);
  const sprintTasksByGate = groupTasksByGate(weeklySprint?.tasks ?? []);
  const claims = claimById(claimDowngrade?.claims ?? []);
  const publicCopyBlocked = publicCopyIsBlocked(publicCopyLock);
  const publicCopyStatus = publicCopyLock?.status ?? 'unknown';

  return riskDefinitions.map((definition) => {
    const relatedGates = definition.gate_ids.map((gateId) => gates.get(gateId)).filter(Boolean);
    const relatedActions = definition.gate_ids.map((gateId) => actions.get(gateId)).filter(Boolean);
    const relatedPressure = definition.gate_ids.map((gateId) => gatePressure.get(gateId)?.pressure).filter(Boolean);
    const relatedMetrics = uniqueBy(
      definition.gate_ids.flatMap((gateId) => metricsByGate.get(gateId) ?? []),
      (metric) => metric.id,
    );
    const relatedSprintTasks = uniqueBy(
      definition.gate_ids.flatMap((gateId) => sprintTasksByGate.get(gateId) ?? []),
      (task) => `${task.gate_id}:${task.milestone_date}`,
    );
    const relatedClaims = definition.claim_ids.map((claimId) => claims.get(claimId)).filter(Boolean);
    const pressure = strongestPressure([...relatedPressure, ...relatedSprintTasks.map((task) => task.pressure)]);
    const publicCopyBlockers =
      definition.id === 'R-KS-PAGE' && publicCopyBlocked ? [`public copy lock status: ${publicCopyStatus}`] : [];
    const blockers = uniqueBy([...publicCopyBlockers, ...relatedGates.flatMap((gate) => gate.blockers ?? [])], (blocker) => blocker).slice(0, 5);
    const nextAction =
      relatedSprintTasks.find((task) => task.next_action)?.next_action ??
      relatedMetrics.find((metric) => metric.next_week_action)?.next_week_action ??
      relatedActions.find((action) => action.action)?.action ??
      'Review the linked evidence gate and decide whether to fix, downgrade, or disclose.';
    const riskPublicCopyBlocked = definition.id === 'R-KS-PAGE' && publicCopyBlocked;
    const status = currentStatus({ gates: relatedGates, claims: relatedClaims, pressure, publicCopyBlocked: riskPublicCopyBlocked });
    const p0 = p0Status({ definition, gates: relatedGates, claims: relatedClaims, pressure, publicCopyBlocked: riskPublicCopyBlocked });

    return {
      id: definition.id,
      risk: definition.risk,
      probability: definition.probability,
      impact: definition.impact,
      owner: definition.owner,
      current_status: status,
      p0_status: p0,
      affects_launch: status !== 'controlled',
      pressure,
      p0_trigger: definition.p0_trigger,
      early_signals: definition.early_signals,
      downgrade_path: definition.downgrade_path,
      next_week_action: nextAction,
      launch_gate_ids: definition.gate_ids,
      launch_gate_statuses: relatedGates.map((gate) => ({ id: gate.id, status: gate.status })),
      kpi_metric_ids: relatedMetrics.map((metric) => metric.id),
      sprint_task_refs: relatedSprintTasks.map((task) => `${task.gate_id}:${task.milestone_date}`),
      claim_ids: definition.claim_ids,
      claim_decisions: relatedClaims.map((claim) => ({ id: claim.claim_id, decision: claim.public_decision })),
      public_copy_lock_status: definition.id === 'R-KS-PAGE' ? publicCopyStatus : null,
      evidence_records: uniqueBy(relatedActions.map((action) => action.evidence_record).filter(Boolean), (record) => record),
      blockers,
      p0_response_sla: '24h owner/impact/repro; 48h fix/downgrade; 7d close/downgrade/disclose',
    };
  });
}

function statusFor({ sourceErrors, risks }) {
  if (sourceErrors.length > 0) return 'risk_register_missing_sources';
  if (risks.some((risk) => risk.p0_status === 'p0_open')) return 'risk_register_has_open_p0';
  if (risks.some((risk) => risk.affects_launch)) return 'risk_register_has_launch_risks';
  return 'risk_register_ready';
}

function riskRows(risks) {
  if (risks.length === 0) return '| n/a | n/a | n/a | n/a | n/a | n/a | n/a |';
  return risks
    .map(
      (risk) =>
        `| ${risk.risk} | ${risk.probability} | ${risk.impact} | ${risk.owner} | ${risk.current_status} | ${risk.next_week_action} | ${risk.affects_launch ? 'yes' : 'no'} |`,
    )
    .join('\n');
}

function p0Rows(risks) {
  const p0Risks = risks.filter((risk) => risk.p0_status === 'p0_open');
  if (p0Risks.length === 0) return '| n/a | n/a | n/a | n/a | n/a |';
  return p0Risks
    .map((risk) => `| ${risk.id} | ${risk.risk} | ${risk.owner} | ${risk.p0_trigger} | ${risk.downgrade_path} |`)
    .join('\n');
}

function downgradeRows(risks) {
  const rows = risks.filter((risk) => risk.affects_launch);
  if (rows.length === 0) return '| n/a | n/a | n/a | n/a |';
  return rows.map((risk) => `| ${risk.id} | ${risk.current_status} | ${risk.downgrade_path} | ${risk.claim_decisions.map((claim) => `${claim.id}:${claim.decision}`).join(', ') || 'n/a'} |`).join('\n');
}

function readme(report) {
  const accessIssues = report.access_issues.length
    ? report.access_issues.map((issue) => `- ${issue}`).join('\n')
    : '- None';
  const commands = report.required_commands.map((command) => `- \`${command}\``).join('\n');
  const nonClaims = report.non_claims.map((claim) => `- ${claim}`).join('\n');

  return `# InkLoop AI Pen Kickstarter Risk Register

Schema: \`inkloop.kickstarter_risk_register.v1\`

Status: \`${report.status}\`

This risk register converts the source risk matrix, current launch gates, weekly sprint, KPI dashboard, and claim downgrade pack into the weekly P0 board. This risk register is not launch approval.

## Summary

| Item | Value |
| --- | --- |
| Launch audit status | ${report.launch_status} |
| Action plan status | ${report.action_plan_status} |
| Critical path status | ${report.critical_path_status} |
| Weekly sprint status | ${report.weekly_sprint_status} |
| KPI dashboard status | ${report.kpi_dashboard_status} |
| Claim downgrade status | ${report.claim_downgrade_status} |
| Public copy lock status | ${report.public_copy_lock_status} |
| Risks | ${report.summary.risk_count} |
| Open P0 risks | ${report.summary.open_p0_count} |
| Launch-impacting risks | ${report.summary.launch_impact_count} |
| At-risk this week | ${report.summary.at_risk_count} |

## Weekly Risk Board

| 风险 | 概率 | 影响 | Owner | 当前状态 | 下周动作 | 是否影响上线 |
| --- | ---: | ---: | --- | --- | --- | --- |
${riskRows(report.weekly_risk_board)}

## P0 Response

P0 SLA: \`${report.p0_response_sla}\`

| Risk ID | Risk | Owner | Trigger | Fix / Downgrade Path |
| --- | --- | --- | --- | --- |
${p0Rows(report.weekly_risk_board)}

## Downgrade Queue

| Risk ID | Status | Downgrade Path | Claim Decisions |
| --- | --- | --- | --- |
${downgradeRows(report.weekly_risk_board)}

## Required Commands

${commands}

## Non-Claims

${nonClaims}

## Access Issues

${accessIssues}

Detailed JSON: [risk-register.json](./risk-register.json)
`;
}

const sources = {
  launchAudit: readJsonSource(launchAuditPath),
  actionPlan: readJsonSource(actionPlanPath),
  criticalPath: readJsonSource(criticalPathPath),
  weeklySprint: readJsonSource(weeklySprintPath),
  kpiDashboard: readJsonSource(kpiDashboardPath),
  claimDowngrade: readJsonSource(claimDowngradePath),
  publicCopyLock: readJsonSource(publicCopyLockPath),
  sourceRisk: existsSync(absolute(sourceRiskPath))
    ? { path: sourceRiskPath, available: true, error: null, data: null }
    : { path: sourceRiskPath, available: false, error: `missing source file: ${sourceRiskPath}`, data: null },
};
const sourceErrors = sourceIssues(sources);
const risks = buildRiskRegister({
  launchAudit: sources.launchAudit.data,
  actionPlan: sources.actionPlan.data,
  criticalPath: sources.criticalPath.data,
  weeklySprint: sources.weeklySprint.data,
  kpiDashboard: sources.kpiDashboard.data,
  claimDowngrade: sources.claimDowngrade.data,
  publicCopyLock: sources.publicCopyLock.data,
});
const openP0 = risks.filter((risk) => risk.p0_status === 'p0_open');
const launchImpact = risks.filter((risk) => risk.affects_launch);
const atRisk = risks.filter((risk) => risk.pressure === 'at_risk');

const report = {
  schema: 'inkloop.kickstarter_risk_register.v1',
  generated_at: new Date().toISOString(),
  status: statusFor({ sourceErrors, risks }),
  sources: sourceMap(sources),
  access_issues: sourceErrors,
  launch_status: sources.launchAudit.data?.status ?? 'unknown',
  action_plan_status: sources.actionPlan.data?.audit_status ?? 'unknown',
  critical_path_status: sources.criticalPath.data?.status ?? 'unknown',
  weekly_sprint_status: sources.weeklySprint.data?.status ?? 'unknown',
  kpi_dashboard_status: sources.kpiDashboard.data?.status ?? 'unknown',
  claim_downgrade_status: sources.claimDowngrade.data?.status ?? 'unknown',
  public_copy_lock_status: sources.publicCopyLock.data?.status ?? 'unknown',
  p0_response_sla: '24h owner/impact/repro; 48h fix/downgrade; 7d close/downgrade/disclose',
  summary: {
    risk_count: risks.length,
    open_p0_count: openP0.length,
    launch_impact_count: launchImpact.length,
    at_risk_count: atRisk.length,
  },
  weekly_risk_board: risks,
  p0_queue: openP0,
  downgrade_queue: launchImpact,
  required_commands: [
    'npm run launch:evidence:audit',
    'npm run launch:action-plan',
    'npm run launch:critical-path',
    'npm run launch:weekly-sprint',
    'npm run launch:kpi-dashboard',
    'npm run kickstarter:claim-downgrade',
    'npm run kickstarter:public-copy-lock',
    'npm run kickstarter:risk-register',
    'npm run launch:review-pack',
  ],
  non_claims: [
    'This risk register is not launch approval.',
    'Public copy lock must be ready before Kickstarter page, video, ads, or landing-page copy is treated as final.',
    'Open P0 risks must be fixed, downgraded, or disclosed before public launch copy is treated as final.',
    'A closed project-management risk does not prove hardware, supply, GTM, or legal evidence; only evidence records can close launch gates.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Kickstarter risk register status: ${report.status}`);
console.log(`Risks: ${report.summary.risk_count}; open P0=${report.summary.open_p0_count}; launch-impact=${report.summary.launch_impact_count}; at-risk=${report.summary.at_risk_count}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status === 'risk_register_missing_sources') {
  console.error('Strict Kickstarter risk register failed: required source reports are missing or unreadable.');
  process.exit(1);
}
