/**
 * Analyze reviewed education and business meeting demo outputs.
 *
 * Accepted input:
 * - CSV with one reviewed candidate per row
 * - JSON array of reviewed candidates
 * - wrappers shaped as { rows: [...] }, { reviews: [...] }, or { records: [...] }
 *
 * Usage:
 *   npm run evidence:demo-review -- fixtures/demo-review-sample.csv
 *   npm run evidence:demo-review -- /path/to/demo-review.csv --out /tmp/demo-review-report.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type Scenario = 'education' | 'meeting' | 'unknown';
type ReviewerAction = 'accept' | 'edit' | 'dismiss' | 'follow_up' | 'unknown';
type HallucinationSeverity = 'none' | 'minor' | 'severe' | 'unknown';

interface InputRecord {
  line: number;
  fields: Record<string, unknown>;
}

interface ValidationIssueRecord {
  line: number;
  path: string;
  message: string;
}

interface ReviewItem {
  line: number;
  session_id: string;
  scenario: Scenario;
  real_hardware: boolean;
  duration_min: number;
  candidate_id: string;
  kind: string;
  source_ref_valid: boolean;
  source_ref_type: string;
  reviewer_action: ReviewerAction;
  hallucination_severity: HallucinationSeverity;
  audio_only: boolean;
  diagram_was_drawn: boolean;
  final_use?: string;
}

interface SessionSummary {
  session_id: string;
  scenario: Scenario;
  real_hardware: boolean;
  duration_min: number;
  candidate_count: number;
  valid_source_ref_count: number;
  valid_source_ref_rate: number;
  accepted_count: number;
  edited_count: number;
  dismissed_count: number;
  follow_up_count: number;
  promoted_count: number;
  severe_hallucination_count: number;
  source_ref_gate_pass: boolean;
  duration_gate_pass: boolean;
  real_hardware_gate_pass: boolean;
  campaign_demo_ready: boolean;
  education?: {
    formula_steps_usable: number;
    concepts_usable: number;
    lesson_candidate_gate_pass: boolean;
  };
  meeting?: {
    decisions_usable: number;
    actions_usable: number;
    risks_usable: number;
    diagrams_usable: number;
    audio_only_items_blocked_rate: number;
    meeting_candidate_gate_pass: boolean;
    board_evidence_gate_pass: boolean;
  };
}

interface AnalyzerReport {
  ok: boolean;
  input: string;
  row_count: number;
  valid_row_count: number;
  invalid_row_count: number;
  validation_issues: ValidationIssueRecord[];
  summary: {
    sessions: SessionSummary[];
    education_sessions: number;
    meeting_sessions: number;
    campaign_ready_sessions: number;
    review_model_has_required_inputs: boolean;
  };
  gate_checks: {
    schema_pass_rate: number;
    has_education_session: boolean;
    has_meeting_session: boolean;
    all_sessions_duration_5_to_8_min: boolean;
    all_promoted_items_have_valid_source_refs: boolean;
    no_severe_hallucinations: boolean;
    education_campaign_demo_ready: boolean;
    meeting_campaign_demo_ready: boolean;
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseArgs(argv: string[]): { input: string; out?: string } {
  const args = [...argv];
  const input = args.shift();
  assert(input, 'usage: analyze-demo-review.ts <review.csv|review.json> [--out report.json]');
  let out: string | undefined;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--out') {
      out = args.shift();
      assert(out, '--out requires a path');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { input: resolve(input), out: out ? resolve(out) : undefined };
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  return rows;
}

function parseCsvRecords(text: string): InputRecord[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.trim().toLowerCase());
  return rows.slice(1).map((row, index) => {
    const fields: Record<string, unknown> = {};
    headers.forEach((header, headerIndex) => {
      fields[header] = row[headerIndex]?.trim() ?? '';
    });
    return { line: index + 2, fields };
  });
}

function unwrapJsonRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const wrapped = record.rows ?? record.reviews ?? record.records;
  return Array.isArray(wrapped) ? wrapped : [];
}

function parseRecords(text: string): InputRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const rows = unwrapJsonRows(JSON.parse(trimmed));
    return rows.map((value, index) => ({
      line: index + 1,
      fields: value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
    }));
  }
  return parseCsvRecords(text);
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function readString(fields: Record<string, unknown>, field: string): string {
  return String(fields[field] ?? '').trim();
}

function readNumber(fields: Record<string, unknown>, field: string): number | null {
  const value = fields[field];
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readBoolean(fields: Record<string, unknown>, field: string): boolean {
  const raw = readString(fields, field).toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y';
}

function normalizeScenario(value: string): Scenario {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'education' || normalized === 'lesson' || normalized === 'teacher') return 'education';
  if (normalized === 'meeting' || normalized === 'business' || normalized === 'business_meeting') return 'meeting';
  return 'unknown';
}

function normalizeAction(value: string): ReviewerAction {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'accept' || normalized === 'accepted') return 'accept';
  if (normalized === 'edit' || normalized === 'edited') return 'edit';
  if (normalized === 'dismiss' || normalized === 'dismissed') return 'dismiss';
  if (normalized === 'follow_up' || normalized === 'follow-up' || normalized === 'needs_follow_up') return 'follow_up';
  return 'unknown';
}

function normalizeHallucination(value: string): HallucinationSeverity {
  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'none' || normalized === 'no') return 'none';
  if (normalized === 'minor') return 'minor';
  if (normalized === 'severe') return 'severe';
  return 'unknown';
}

function validateRecord(record: InputRecord): { value?: ReviewItem; issues: ValidationIssueRecord[] } {
  const issues: ValidationIssueRecord[] = [];
  const requireString = (field: string): string => {
    const value = readString(record.fields, field);
    if (!value) issues.push({ line: record.line, path: `rows.${record.line}.${field}`, message: 'required string is missing' });
    return value;
  };
  const requireNumber = (field: string): number => {
    const value = readNumber(record.fields, field);
    if (value === null || value < 0) {
      issues.push({ line: record.line, path: `rows.${record.line}.${field}`, message: 'required non-negative number is missing' });
      return 0;
    }
    return value;
  };

  const scenario = normalizeScenario(requireString('scenario'));
  if (scenario === 'unknown') {
    issues.push({ line: record.line, path: `rows.${record.line}.scenario`, message: 'scenario must be education or meeting' });
  }
  const reviewerAction = normalizeAction(requireString('reviewer_action'));
  if (reviewerAction === 'unknown') {
    issues.push({ line: record.line, path: `rows.${record.line}.reviewer_action`, message: 'reviewer_action must be accept, edit, dismiss, or follow_up' });
  }
  const hallucination = normalizeHallucination(readString(record.fields, 'hallucination_severity'));
  if (hallucination === 'unknown') {
    issues.push({
      line: record.line,
      path: `rows.${record.line}.hallucination_severity`,
      message: 'hallucination_severity must be none, minor, or severe',
    });
  }

  const item: ReviewItem = {
    line: record.line,
    session_id: requireString('session_id'),
    scenario,
    real_hardware: readBoolean(record.fields, 'real_hardware'),
    duration_min: requireNumber('duration_min'),
    candidate_id: requireString('candidate_id'),
    kind: requireString('kind').trim().toLowerCase(),
    source_ref_valid: readBoolean(record.fields, 'source_ref_valid'),
    source_ref_type: readString(record.fields, 'source_ref_type').trim().toLowerCase() || 'unknown',
    reviewer_action: reviewerAction,
    hallucination_severity: hallucination,
    audio_only: readBoolean(record.fields, 'audio_only'),
    diagram_was_drawn: readBoolean(record.fields, 'diagram_was_drawn'),
    final_use: readString(record.fields, 'final_use') || undefined,
  };
  return issues.length > 0 ? { issues } : { issues, value: item };
}

function isPromoted(item: ReviewItem): boolean {
  return item.reviewer_action === 'accept' || item.reviewer_action === 'edit' || item.reviewer_action === 'follow_up';
}

function usableCount(items: ReviewItem[], kinds: string[]): number {
  return items.filter((item) => isPromoted(item) && kinds.includes(item.kind)).length;
}

function summarizeSession(sessionId: string, items: ReviewItem[]): SessionSummary {
  const scenario = items[0]?.scenario ?? 'unknown';
  const realHardware = items.every((item) => item.real_hardware);
  const durationMin = items[0]?.duration_min ?? 0;
  const promoted = items.filter(isPromoted);
  const validSourceRefCount = items.filter((item) => item.source_ref_valid).length;
  const sourceRefRate = items.length ? round(validSourceRefCount / items.length) : 0;
  const promotedSourceRefRate = promoted.length ? round(promoted.filter((item) => item.source_ref_valid).length / promoted.length) : 1;
  const severeHallucinations = items.filter((item) => item.hallucination_severity === 'severe').length;
  const durationPass = durationMin >= 5 && durationMin <= 8;
  const promotedSourceRefsPass = promoted.length > 0 && promotedSourceRefRate === 1;
  const base: SessionSummary = {
    session_id: sessionId,
    scenario,
    real_hardware: realHardware,
    duration_min: durationMin,
    candidate_count: items.length,
    valid_source_ref_count: validSourceRefCount,
    valid_source_ref_rate: sourceRefRate,
    accepted_count: items.filter((item) => item.reviewer_action === 'accept').length,
    edited_count: items.filter((item) => item.reviewer_action === 'edit').length,
    dismissed_count: items.filter((item) => item.reviewer_action === 'dismiss').length,
    follow_up_count: items.filter((item) => item.reviewer_action === 'follow_up').length,
    promoted_count: promoted.length,
    severe_hallucination_count: severeHallucinations,
    source_ref_gate_pass: promotedSourceRefsPass,
    duration_gate_pass: durationPass,
    real_hardware_gate_pass: realHardware,
    campaign_demo_ready: false,
  };
  if (scenario === 'education') {
    const formulaSteps = usableCount(items, ['formula_step']);
    const concepts = usableCount(items, ['concept']);
    const lessonGate = items.length >= 3 && promotedSourceRefsPass && formulaSteps >= 1 && concepts >= 1 && severeHallucinations === 0;
    base.education = {
      formula_steps_usable: formulaSteps,
      concepts_usable: concepts,
      lesson_candidate_gate_pass: lessonGate,
    };
    base.campaign_demo_ready = realHardware && durationPass && lessonGate;
  } else if (scenario === 'meeting') {
    const audioOnlyItems = items.filter((item) => item.audio_only);
    const audioOnlyBlocked =
      audioOnlyItems.length === 0 ? 1 : round(audioOnlyItems.filter((item) => item.reviewer_action === 'dismiss').length / audioOnlyItems.length);
    const boardEvidencePass = promoted.every((item) => item.source_ref_type === 'ink_event' || item.source_ref_type === 'board_object');
    const decisions = usableCount(items, ['meeting_decision']);
    const actions = usableCount(items, ['meeting_action']);
    const risks = usableCount(items, ['meeting_risk']);
    const diagrams = usableCount(items, ['diagram']);
    const diagramWasDrawn = items.some((item) => item.diagram_was_drawn);
    const meetingGate =
      items.length >= 4 &&
      boardEvidencePass &&
      decisions >= 1 &&
      actions >= 1 &&
      (!items.some((item) => item.kind === 'meeting_risk') || risks >= 1) &&
      (!diagramWasDrawn || diagrams >= 1) &&
      audioOnlyBlocked === 1 &&
      severeHallucinations === 0;
    base.meeting = {
      decisions_usable: decisions,
      actions_usable: actions,
      risks_usable: risks,
      diagrams_usable: diagrams,
      audio_only_items_blocked_rate: audioOnlyBlocked,
      meeting_candidate_gate_pass: meetingGate,
      board_evidence_gate_pass: boardEvidencePass,
    };
    base.campaign_demo_ready = realHardware && durationPass && meetingGate;
  }
  return base;
}

function groupBySession(items: ReviewItem[]): Map<string, ReviewItem[]> {
  const groups = new Map<string, ReviewItem[]>();
  for (const item of items) {
    const current = groups.get(item.session_id) ?? [];
    current.push(item);
    groups.set(item.session_id, current);
  }
  return groups;
}

function analyze(input: string, records: InputRecord[]): AnalyzerReport {
  const validationIssues: ValidationIssueRecord[] = [];
  const items: ReviewItem[] = [];
  for (const record of records) {
    const result = validateRecord(record);
    validationIssues.push(...result.issues);
    if (result.value) items.push(result.value);
  }

  const sessions = [...groupBySession(items).entries()]
    .map(([sessionId, sessionItems]) => summarizeSession(sessionId, sessionItems))
    .sort((a, b) => a.session_id.localeCompare(b.session_id));
  const educationSessions = sessions.filter((session) => session.scenario === 'education');
  const meetingSessions = sessions.filter((session) => session.scenario === 'meeting');
  const promotedItems = items.filter(isPromoted);
  const allPromotedHaveRefs = promotedItems.length > 0 && promotedItems.every((item) => item.source_ref_valid);
  const noSevereHallucinations = items.every((item) => item.hallucination_severity !== 'severe');

  return {
    ok: validationIssues.length === 0 && sessions.length > 0,
    input,
    row_count: records.length,
    valid_row_count: items.length,
    invalid_row_count: records.length - items.length,
    validation_issues: validationIssues,
    summary: {
      sessions,
      education_sessions: educationSessions.length,
      meeting_sessions: meetingSessions.length,
      campaign_ready_sessions: sessions.filter((session) => session.campaign_demo_ready).length,
      review_model_has_required_inputs: sessions.length > 0,
    },
    gate_checks: {
      schema_pass_rate: records.length ? round(items.length / records.length) : 0,
      has_education_session: educationSessions.length > 0,
      has_meeting_session: meetingSessions.length > 0,
      all_sessions_duration_5_to_8_min: sessions.length > 0 && sessions.every((session) => session.duration_gate_pass),
      all_promoted_items_have_valid_source_refs: allPromotedHaveRefs,
      no_severe_hallucinations: noSevereHallucinations,
      education_campaign_demo_ready: educationSessions.some((session) => session.campaign_demo_ready),
      meeting_campaign_demo_ready: meetingSessions.some((session) => session.campaign_demo_ready),
    },
  };
}

async function main(): Promise<void> {
  const { input, out } = parseArgs(process.argv.slice(2));
  const records = parseRecords(await readFile(input, 'utf8'));
  const report = analyze(input, records);
  const json = JSON.stringify(report, null, 2);
  if (out) await writeFile(out, `${json}\n`, 'utf8');
  console.log(json);
  if (!report.ok) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
