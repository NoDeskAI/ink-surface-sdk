import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const criticalPathPath = 'test-results/ai-pen-kickstarter-critical-path/critical-path.json';
const actionPlanPath = 'test-results/ai-pen-launch-action-plan/action-plan.json';
const intakeAuditPath = 'test-results/ai-pen-launch-evidence-intake-audit/report.json';
const outDir = 'test-results/ai-pen-kickstarter-weekly-sprint';
const outJsonPath = `${outDir}/weekly-sprint.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');
const msPerDay = 24 * 60 * 60 * 1000;

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

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
  return Math.ceil((new Date(`${endDate}T00:00:00.000Z`).getTime() - new Date(`${startDate}T00:00:00.000Z`).getTime()) / msPerDay);
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

function selectedMilestones(criticalPath) {
  const milestones = Array.isArray(criticalPath?.critical_path) ? criticalPath.critical_path : [];
  const actionable = milestones.filter((milestone) => milestone.gate_ids?.length && milestone.status !== 'ready');
  const immediate = actionable.filter((milestone) => ['overdue', 'due_this_week', 'at_risk'].includes(milestone.status));
  return immediate.length > 0 ? immediate : actionable.slice(0, 3);
}

function actionMap(actionPlan) {
  return new Map((actionPlan?.action_items ?? []).map((item) => [item.id, item]));
}

function intakeMap(intakeAudit) {
  return new Map((intakeAudit?.gates ?? []).map((gate) => [gate.id, gate]));
}

function resolveAnalyzerCommand(command, intakeAudit, intakeGate) {
  if (intakeGate?.analyzer_command) return intakeGate.analyzer_command;
  if (!command) return null;
  if (!intakeAudit?.intake_dir) return command;
  return command.replaceAll('<intake>', intakeAudit.intake_dir);
}

function sprintStatus(tasks) {
  if (tasks.some((task) => task.pressure === 'overdue')) return 'sprint_overdue';
  if (tasks.some((task) => task.pressure === 'due_this_week')) return 'sprint_due_this_week';
  if (tasks.some((task) => task.pressure === 'at_risk')) return 'sprint_has_at_risk_work';
  return tasks.length ? 'sprint_scheduled' : 'sprint_no_red_gate_work';
}

function pressureFromMilestone(milestone) {
  if (milestone.status === 'overdue') return 'overdue';
  if (milestone.status === 'due_this_week') return 'due_this_week';
  if (milestone.status === 'at_risk') return 'at_risk';
  return 'scheduled';
}

function buildTasks({ criticalPath, actionPlan, intakeAudit, analysisDate }) {
  const actions = actionMap(actionPlan);
  const intakeGates = intakeMap(intakeAudit);
  const milestones = selectedMilestones(criticalPath);
  const tasks = milestones.flatMap((milestone) =>
    (milestone.gate_ids ?? []).map((gateId) => {
      const action = actions.get(gateId);
      const intakeGate = intakeGates.get(gateId);
      const daysToDue = daysBetween(analysisDate, milestone.date);
      return {
        gate_id: gateId,
        milestone_date: milestone.date,
        milestone: milestone.milestone,
        phase: milestone.phase,
        days_to_due: daysToDue,
        pressure: pressureFromMilestone(milestone),
        owner: action?.owner ?? milestone.owner,
        label: action?.label ?? gateId,
        status: action?.status ?? 'unknown',
        evidence_record: action?.evidence_record ?? null,
        intake_folder: action?.intake_folder ?? null,
        current_intake_dir: intakeAudit?.intake_dir ?? null,
        intake_gate_folder: intakeGate?.folder ?? null,
        expected_input: intakeGate?.expected_input ?? null,
        expected_report: intakeGate?.expected_report ?? null,
        raw_folder: intakeGate?.folder ? `${intakeGate.folder}/raw` : null,
        reports_folder: intakeGate?.folder ? `${intakeGate.folder}/reports` : null,
        artifacts_folder: intakeGate?.folder ? `${intakeGate.folder}/artifacts` : null,
        analyzer_command: action?.command ?? null,
        runnable_analyzer_command: resolveAnalyzerCommand(action?.command, intakeAudit, intakeGate),
        intake_audit_status: intakeGate?.status ?? intakeAudit?.status ?? 'unknown',
        intake_blockers: intakeGate?.blockers ?? [],
        next_action: action?.action ?? milestone.evidence_needed,
        done_when: action?.done_when ?? milestone.evidence_needed,
        blockers: action?.audit?.blockers ?? [],
      };
    }),
  );
  return uniqueBy(tasks, (task) => `${task.gate_id}:${task.milestone_date}`).sort((a, b) => a.days_to_due - b.days_to_due || a.gate_id.localeCompare(b.gate_id));
}

function evidenceChecklist(task) {
  if (task.gate_id === 'G-HW-1') {
    return [
      'RawPenFrame JSONL from real or closest engineering prototype',
      'Prototype inventory row with unit id, firmware, battery, session minutes, event count, and result',
      'Replay/export artifact',
      'Prototype video showing pen down/up and coordinates',
      'AI Pen analyzer report JSON',
    ];
  }
  if (task.gate_id === 'G-SURF-1') {
    return [
      'Capture Surface calibration CSV with center, edge, and corner points',
      'Material notes for ink, glare, wipe, marker type, and surface batch',
      'Photo/video of the tested surface and conditions',
      'Capture Surface analyzer report JSON',
    ];
  }
  if (task.gate_id === 'G-LIVE-1') {
    return [
      'Live Board timing CSV from raw frame through render commit',
      'Transport label showing BLE, wired, or closest prototype path',
      'Replay or screen recording',
      'Live Board latency analyzer report JSON',
    ];
  }
  if (task.gate_id === 'G-EDU-1') {
    return [
      '5-8 minute teacher board session raw file',
      'Exported lesson note',
      'Reviewer CSV with accept/edit/dismiss decisions',
      'Demo review analyzer report JSON',
      'Public demo decision',
    ];
  }
  if (task.gate_id === 'G-MTG-1') {
    return [
      '5-8 minute business whiteboard session raw file',
      'Exported meeting output',
      'Board-mark evidence for decisions, actions, risks, and diagrams',
      'Reviewer CSV with accept/edit/dismiss decisions',
      'Demo review analyzer report JSON',
    ];
  }
  if (task.gate_id === 'G-SUPPLY-1') {
    return [
      'BOM CSV with cost, MOQ, lead time, supplier, backup supplier, and quote status',
      'Supplier quote folder or quote index',
      'Reward pricing analyzer report JSON',
    ];
  }
  if (task.gate_id === 'G-GTM-1') {
    return [
      'Weekly GTM snapshot CSV',
      'CRM/export source links',
      'Kickstarter dashboard export',
      'Consent-backed testimonial links',
      'GTM analyzer report JSON',
    ];
  }
  if (task.gate_id === 'G-PAGE-1') {
    return [
      'Kickstarter preview link',
      'Legal/privacy review link',
      'Claim review index',
      'Risk, AI/privacy, rewards, FAQ, and video-script review notes',
    ];
  }
  return [task.done_when];
}

function taskRows(tasks) {
  if (tasks.length === 0) return '| n/a | n/a | n/a | n/a | n/a | n/a | n/a |';
  return tasks
    .map(
      (task) =>
        `| ${task.pressure} | ${task.gate_id} | ${task.milestone_date} | ${task.days_to_due} | ${task.owner} | ${task.next_action} | \`${task.evidence_record ?? 'n/a'}\` |`,
    )
    .join('\n');
}

function evidenceRows(tasks) {
  if (tasks.length === 0) return '| n/a | n/a | n/a | n/a |';
  return tasks
    .map((task) => `| ${task.gate_id} | \`${task.intake_gate_folder ?? task.intake_folder ?? 'n/a'}\` | \`${task.expected_input ?? 'n/a'}\` | \`${task.expected_report ?? 'n/a'}\` | \`${task.runnable_analyzer_command ?? 'n/a'}\` | ${evidenceChecklist(task).join('<br>')} |`)
    .join('\n');
}

function captureTargetRows(tasks) {
  const uniqueTasks = uniqueBy(tasks, (task) => task.gate_id);
  if (uniqueTasks.length === 0) return '| n/a | n/a | n/a | n/a | n/a |';
  return uniqueTasks
    .map(
      (task) =>
        `| ${task.gate_id} | ${task.owner} | \`${task.raw_folder ?? 'n/a'}\` | \`${task.reports_folder ?? 'n/a'}\` | \`${task.artifacts_folder ?? 'n/a'}\` |`,
    )
    .join('\n');
}

function first48HourPlan(tasks) {
  return uniqueBy(tasks, (task) => task.gate_id)
    .slice(0, 4)
    .map((task, index) => ({
      day: index < 2 ? 'Day 1' : 'Day 2',
      gate_id: task.gate_id,
      owner: task.owner,
      action: task.next_action,
      raw_target: task.expected_input,
      report_target: task.expected_report,
      artifact_target: task.artifacts_folder,
      run_command: task.runnable_analyzer_command,
      evidence_record: task.evidence_record,
      intake_blockers: task.intake_blockers,
    }));
}

function first48HourRows(plan) {
  if (plan.length === 0) return '| n/a | n/a | n/a | n/a | n/a | n/a |';
  return plan
    .map(
      (item) =>
        `| ${item.day} | ${item.gate_id} | ${item.owner} | ${item.action} | \`${item.raw_target ?? 'n/a'}\` | \`${item.run_command ?? 'n/a'}\` |`,
    )
    .join('\n');
}

function agenda(tasks) {
  const gateList = uniqueBy(tasks, (task) => task.gate_id).map((task) => task.gate_id);
  return [
    'Confirm whether every selected task has a named owner for the next 7 days.',
    'Open the current launch evidence intake package and create or rename real raw files in the matching gate folder.',
    'Run the analyzer command for every task that has one and keep failing `gate_checks` visible.',
    'Run `npm run launch:evidence:intake-audit` before editing Markdown evidence records.',
    'Update only evidence records backed by real files, reports, and human decisions.',
    `Review selected gates: ${gateList.join(', ') || 'none'}.`,
    'Downgrade public Kickstarter claims immediately if a selected gate cannot collect real evidence before its milestone date.',
  ];
}

function readme(report) {
  const commands = report.required_commands.map((command) => `- \`${command}\``).join('\n');
  const agendaRows = report.review_agenda.map((item, index) => `${index + 1}. ${item}`).join('\n');
  return `# InkLoop AI Pen Kickstarter Weekly Sprint

Schema: \`inkloop.kickstarter_weekly_sprint.v1\`

Generated at: ${report.generated_at}

Sprint window: ${report.sprint_window.start} to ${report.sprint_window.end}

Status: \`${report.status}\`

This package converts the critical path into the next execution sprint. It is for project management only and does not make any Kickstarter launch claim.

## Summary

| Item | Value |
| --- | --- |
| Launch audit status | ${report.launch_status} |
| Intake audit status | ${report.intake_status} |
| Current intake dir | \`${report.current_intake_dir ?? 'n/a'}\` |
| Critical path status | ${report.critical_path_status} |
| Days to preferred launch | ${report.days_to_preferred_launch} |
| Selected tasks | ${report.tasks.length} |
| At-risk tasks | ${report.summary.at_risk_task_count} |
| Due-this-week tasks | ${report.summary.due_this_week_task_count} |
| Overdue tasks | ${report.summary.overdue_task_count} |

## Sprint Tasks

| Pressure | Gate | Milestone Date | Days | Owner | Next Action | Evidence Record |
| --- | --- | --- | ---: | --- | --- | --- |
${taskRows(report.tasks)}

## First 48 Hours Capture Plan

These are the exact files and commands for the current intake package. Replace template files with real capture artifacts before running analyzers.

| Day | Gate | Owner | Action | Raw Target | Runnable Analyzer Command |
| --- | --- | --- | --- | --- | --- |
${first48HourRows(report.first_48h_capture_plan)}

## Current Intake Targets

| Gate | Owner | Raw Folder | Reports Folder | Artifacts Folder |
| --- | --- | --- | --- | --- |
${captureTargetRows(report.tasks)}

## Evidence To Collect

| Gate | Intake Folder | Expected Input | Expected Report | Runnable Analyzer Command | Evidence Checklist |
| --- | --- | --- | --- | --- | --- |
${evidenceRows(report.tasks)}

## Weekly Review Agenda

${agendaRows}

## Required Commands

${commands}

## Non-Claims

${report.non_claims.map((item) => `- ${item}`).join('\n')}

Detailed JSON: [weekly-sprint.json](./weekly-sprint.json)
`;
}

const criticalPathSource = readJsonSource(criticalPathPath);
const actionPlanSource = readJsonSource(actionPlanPath);
const intakeAuditSource = readJsonSource(intakeAuditPath);
if (!criticalPathSource.available) throw new Error(`missing critical path: ${criticalPathSource.error}. Run npm run launch:critical-path first.`);
if (!actionPlanSource.available) throw new Error(`missing action plan: ${actionPlanSource.error}. Run npm run launch:action-plan first.`);

const generatedAt = new Date().toISOString();
const analysisDate = criticalPathSource.data?.analysis_date ?? dateOnly(new Date(generatedAt));
const tasks = buildTasks({
  criticalPath: criticalPathSource.data,
  actionPlan: actionPlanSource.data,
  intakeAudit: intakeAuditSource.data,
  analysisDate,
});
const first48hCapturePlan = first48HourPlan(tasks);
const report = {
  schema: 'inkloop.kickstarter_weekly_sprint.v1',
  generated_at: generatedAt,
  sprint_window: {
    start: analysisDate,
    end: addDays(analysisDate, 7),
  },
  status: sprintStatus(tasks),
  source_files: [criticalPathPath, actionPlanPath, intakeAuditPath],
  launch_status: criticalPathSource.data?.launch_audit_status ?? actionPlanSource.data?.audit_status ?? 'unknown',
  intake_status: intakeAuditSource.data?.status ?? criticalPathSource.data?.intake_audit_status ?? 'unknown',
  current_intake_dir: intakeAuditSource.data?.intake_dir ?? null,
  critical_path_status: criticalPathSource.data?.status ?? 'unknown',
  days_to_preferred_launch: criticalPathSource.data?.summary?.days_to_preferred_launch ?? null,
  summary: {
    task_count: tasks.length,
    at_risk_task_count: tasks.filter((task) => task.pressure === 'at_risk').length,
    due_this_week_task_count: tasks.filter((task) => task.pressure === 'due_this_week').length,
    overdue_task_count: tasks.filter((task) => task.pressure === 'overdue').length,
  },
  tasks: tasks.map((task) => ({
    ...task,
    evidence_checklist: evidenceChecklist(task),
  })),
  first_48h_capture_plan: first48hCapturePlan,
  review_agenda: agenda(tasks),
  required_commands: [
    'npm run launch:evidence:intake',
    'npm run launch:evidence:intake-audit',
    'npm run launch:evidence:audit',
    'npm run launch:action-plan',
    'npm run launch:critical-path',
    'npm run launch:weekly-sprint',
    'npm run launch:review-pack',
  ],
  non_claims: [
    'This sprint package is an execution queue, not launch approval.',
    'A task can appear in this sprint even when only local demo evidence exists.',
    'Do not turn fixture data, template rows, or missing analyzer reports into Kickstarter claims.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Kickstarter weekly sprint status: ${report.status}`);
console.log(`Tasks: ${report.summary.task_count}; at-risk=${report.summary.at_risk_task_count}; due-this-week=${report.summary.due_this_week_task_count}; overdue=${report.summary.overdue_task_count}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status === 'sprint_overdue') {
  console.error('Strict Kickstarter weekly sprint failed: at least one selected milestone is overdue.');
  process.exit(1);
}
