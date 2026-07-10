import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const projectRoot = 'docs/project/inkloop-ai-pen-kickstarter';
const evidenceRoot = `${projectRoot}/evidence`;
const outDir = 'test-results/ai-pen-launch-evidence-audit';
const outPath = `${outDir}/report.json`;
const readmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function readText(relativePath) {
  return readFileSync(absolute(relativePath), 'utf8');
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitMarkdownTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function normalizeArtifactReference(value) {
  const markdownLink = value.match(/\[[^\]]+\]\(([^)]+)\)/);
  const raw = markdownLink ? markdownLink[1] : value;
  return raw
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/^`|`$/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function isPlaceholderArtifact(value) {
  const normalized = normalizeArtifactReference(value);
  return (
    !normalized ||
    /^TBD$/i.test(normalized) ||
    /^0$/i.test(normalized) ||
    /^none$/i.test(normalized) ||
    /^n\/a$/i.test(normalized) ||
    /^not\s+(run|ready|requested|available)$/i.test(normalized) ||
    /^\{\}$/i.test(normalized)
  );
}

function isUsableArtifactReference(value, evidenceFile) {
  if (isPlaceholderArtifact(value)) return false;
  const normalized = normalizeArtifactReference(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return true;
  if (/^(feishu|lark|obsidian|inkloop):/i.test(normalized)) return true;
  if (path.isAbsolute(normalized)) return existsSync(normalized);
  const fromRoot = absolute(normalized);
  if (existsSync(fromRoot)) return true;
  const fromEvidenceFile = path.resolve(path.dirname(absolute(evidenceFile)), normalized);
  return existsSync(fromEvidenceFile);
}

function resolveLocalArtifactReference(value, evidenceFile) {
  const normalized = normalizeArtifactReference(value);
  if (isPlaceholderArtifact(value)) {
    return { kind: 'placeholder', normalized, absolute_path: null };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) || /^(feishu|lark|obsidian|inkloop):/i.test(normalized)) {
    return { kind: 'external', normalized, absolute_path: null };
  }

  const candidates = path.isAbsolute(normalized)
    ? [normalized]
    : [absolute(normalized), path.resolve(path.dirname(absolute(evidenceFile)), normalized)];
  const existing = candidates.find((candidate) => existsSync(candidate));
  return {
    kind: existing ? 'local_file' : 'missing_local_file',
    normalized,
    absolute_path: existing ?? candidates[0] ?? null,
  };
}

function readJsonFile(absolutePath) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(absolutePath, 'utf8')) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function getPathValue(value, dottedPath) {
  return dottedPath.split('.').reduce((cursor, segment) => {
    if (cursor && typeof cursor === 'object' && segment in cursor) return cursor[segment];
    return undefined;
  }, value);
}

function evaluateAnalyzerCheck(report, check) {
  const actual = getPathValue(report, check.path);
  if ('equals' in check) {
    return {
      path: check.path,
      expected: check.equals,
      actual,
      passed: actual === check.equals,
    };
  }
  if ('min' in check) {
    const numeric = typeof actual === 'number' ? actual : Number(actual);
    return {
      path: check.path,
      expected: `>= ${check.min}`,
      actual,
      passed: Number.isFinite(numeric) && numeric >= check.min,
    };
  }
  return {
    path: check.path,
    expected: 'configured check',
    actual,
    passed: false,
  };
}

function extractFieldValues(text, label) {
  const pattern = new RegExp(`\\|\\s*${escapeRegExp(label)}\\s*\\|\\s*([^|]+)\\|`, 'gi');
  return [...text.matchAll(pattern)].map((match) => match[1].trim());
}

function extractColumnValues(text, columnLabel) {
  const values = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length - 2; index += 1) {
    const line = lines[index];
    const separator = lines[index + 1];
    if (!line.trim().startsWith('|') || !separator.trim().startsWith('|')) continue;
    if (!/^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(separator.trim())) continue;
    const headers = splitMarkdownTableRow(line);
    const columnIndex = headers.findIndex((header) => header.toLowerCase() === columnLabel.toLowerCase());
    if (columnIndex === -1) continue;
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const row = lines[rowIndex];
      if (!row.trim().startsWith('|')) break;
      const cells = splitMarkdownTableRow(row);
      if (cells[columnIndex] !== undefined) values.push(cells[columnIndex]);
    }
  }
  return values;
}

function evaluateArtifactRequirement(requirement, text, evidenceFile) {
  const values = [
    ...(requirement.fieldLabels ?? []).flatMap((label) => extractFieldValues(text, label)),
    ...(requirement.columnLabels ?? []).flatMap((label) => extractColumnValues(text, label)),
  ];
  const usableValues = values.filter((value) => isUsableArtifactReference(value, evidenceFile));
  const requiredCount = requirement.minCount ?? 1;
  return {
    label: requirement.label,
    required_count: requiredCount,
    value_count: values.length,
    usable_count: usableValues.length,
    passed: usableValues.length >= requiredCount,
    usable_values: usableValues.map(normalizeArtifactReference),
  };
}

function evaluateAnalyzerReportRequirement(requirement, text, evidenceFile) {
  const values = [
    ...(requirement.fieldLabels ?? []).flatMap((label) => extractFieldValues(text, label)),
    ...(requirement.columnLabels ?? []).flatMap((label) => extractColumnValues(text, label)),
  ];
  const reports = values.map((value) => {
    const resolved = resolveLocalArtifactReference(value, evidenceFile);
    if (resolved.kind !== 'local_file') {
      return {
        reference: resolved.normalized,
        resolved_kind: resolved.kind,
        resolved_path: resolved.absolute_path,
        passed: false,
        checks: [],
      };
    }

    const parsed = readJsonFile(resolved.absolute_path);
    if (!parsed.ok) {
      return {
        reference: resolved.normalized,
        resolved_kind: resolved.kind,
        resolved_path: resolved.absolute_path,
        passed: false,
        parse_error: parsed.error,
        checks: [],
      };
    }

    const checks = requirement.checks.map((check) => evaluateAnalyzerCheck(parsed.value, check));
    return {
      reference: resolved.normalized,
      resolved_kind: resolved.kind,
      resolved_path: resolved.absolute_path,
      passed: checks.every((check) => check.passed),
      checks,
    };
  });
  const requiredCount = requirement.minCount ?? 1;
  const passedReports = reports.filter((report) => report.passed).length;
  return {
    label: requirement.label,
    required_count: requiredCount,
    value_count: values.length,
    passed_report_count: passedReports,
    passed: passedReports >= requiredCount,
    reports,
  };
}

const gates = [
  {
    id: 'G-HW-1',
    label: '5 working AI Pen prototypes',
    file: `${evidenceRoot}/hardware-prototype-run-log.md`,
    requiredEvidence: [
      'five unit rows with Pass or Conditional pass',
      '30-minute raw hardware logs',
      'replay/export links',
      'prototype video links',
      'real hardware decision marked Pass or Conditional pass',
    ],
    blockingPatterns: [
      /\bTBD\b/g,
      /\bNot run\b/g,
      /\|\s*PEN-\d+\s*\|[^|\n]*\|[^|\n]*\|[^|\n]*\|[^|\n]*\|\s*0\s*\|\s*0\s*\|/g,
    ],
    positivePatterns: [
      /Did all 5 units complete 30 minutes\?\s*\|\s*(Yes|Pass|Conditional pass)/i,
      /Is this evidence real hardware, not simulator\?\s*\|\s*(Yes|Pass|Conditional pass)/i,
      /Can this be used in Kickstarter page\/video claims\?\s*\|\s*(Yes|Pass|Conditional pass)/i,
    ],
    artifactRequirements: [
      { label: 'raw hardware log', fieldLabels: ['Raw log path'] },
      { label: 'AI Pen analyzer report', fieldLabels: ['Analyzer report path'] },
      { label: 'session replay/export', fieldLabels: ['Replay/export path'] },
      { label: 'prototype video', fieldLabels: ['Video path'] },
    ],
    analyzerReportRequirements: [
      {
        label: 'AI Pen analyzer gate checks',
        fieldLabels: ['Analyzer report path'],
        checks: [
          { path: 'ok', equals: true },
          { path: 'gate_checks.schema_pass_rate', min: 0.95 },
          { path: 'gate_checks.has_down_and_up', equals: true },
          { path: 'gate_checks.has_complete_stroke', equals: true },
          { path: 'gate_checks.host_latency_p50_le_150', equals: true },
          { path: 'gate_checks.host_latency_p95_le_300', equals: true },
        ],
      },
    ],
  },
  {
    id: 'G-SURF-1',
    label: 'Capture Surface calibration',
    file: `${evidenceRoot}/capture-surface-calibration-report.md`,
    requiredEvidence: [
      'real A2/A3 calibration raw traces',
      'analyzer report path',
      'P95 error <= 5 mm',
      'stability >= 95%',
      'conditions and limitations documented',
    ],
    blockingPatterns: [/\bTBD\b/g, /\bNot run\b/g],
    positivePatterns: [
      /Target met: >= 95% stable\s*\|\s*(Yes|Pass|true)/i,
      /Target met: <= 5 mm error\s*\|\s*(Yes|Pass|true)/i,
      /Can the page claim A2 error <= 5 mm\?\s*\|\s*(Yes|Pass|Conditional pass)/i,
    ],
    artifactRequirements: [
      { label: 'raw calibration trace', fieldLabels: ['Raw trace path'] },
      { label: 'measurement sheet', fieldLabels: ['Measurement sheet path'] },
      { label: 'calibration analyzer report', fieldLabels: ['Analyzer report path'] },
      { label: 'calibration photo/video', fieldLabels: ['Photo/video path'] },
    ],
    analyzerReportRequirements: [
      {
        label: 'Capture Surface analyzer gate checks',
        fieldLabels: ['Analyzer report path'],
        checks: [
          { path: 'ok', equals: true },
          { path: 'gate_checks.schema_pass_rate', min: 0.95 },
          { path: 'gate_checks.p95_error_le_5mm', equals: true },
          { path: 'gate_checks.stability_rate_ge_95', equals: true },
          { path: 'gate_checks.has_edge_or_corner_points', equals: true },
          { path: 'gate_checks.has_a2_or_a3_surface', equals: true },
        ],
      },
    ],
  },
  {
    id: 'G-LIVE-1',
    label: 'Live Board real latency',
    file: `${evidenceRoot}/live-board-latency-report.md`,
    requiredEvidence: [
      'real BLE or wired timing log',
      'P50 <= 150 ms',
      'P95 <= 300 ms',
      'drop rate evidence',
      'Kickstarter claim decision',
    ],
    blockingPatterns: [/\bTBD\b/g, /\bNot run\b/g, /\|\s*LAT-\d+\s*\|[^|\n]*\|\s*0\s*\|\s*0\s*\|\s*0\s*\|/g],
    positivePatterns: [
      /Is this real transport, not simulator\?\s*\|\s*(Yes|Pass|Conditional pass)/i,
      /Does P50 meet <= 150 ms\?\s*\|\s*(Yes|Pass|true)/i,
      /Does P95 meet <= 300 ms\?\s*\|\s*(Yes|Pass|true)/i,
      /Can this evidence support Kickstarter demo claims\?\s*\|\s*(Yes|Pass|Conditional pass)/i,
    ],
    artifactRequirements: [
      { label: 'raw event log', fieldLabels: ['Raw event log path'] },
      { label: 'render timing log', fieldLabels: ['Render timing log path'] },
      { label: 'latency analyzer report', fieldLabels: ['Analyzer report path'] },
      { label: 'latency replay', fieldLabels: ['Replay path'] },
    ],
    analyzerReportRequirements: [
      {
        label: 'Live Board latency analyzer gate checks',
        fieldLabels: ['Analyzer report path'],
        checks: [
          { path: 'ok', equals: true },
          { path: 'gate_checks.schema_pass_rate', min: 0.95 },
          { path: 'gate_checks.has_rendered_events', equals: true },
          { path: 'gate_checks.end_to_end_p50_le_150', equals: true },
          { path: 'gate_checks.end_to_end_p95_le_300', equals: true },
          { path: 'gate_checks.drop_rate_le_1_percent', equals: true },
          { path: 'gate_checks.has_education_session', equals: true },
          { path: 'gate_checks.has_meeting_session', equals: true },
        ],
      },
    ],
  },
  {
    id: 'G-EDU-1',
    label: 'Real education demo review',
    file: `${evidenceRoot}/education-demo-review.md`,
    requiredEvidence: [
      'real 5-8 minute teacher session',
      'raw session and video links',
      'reviewer CSV',
      'analyzer report with education_campaign_demo_ready=true',
      'human decision for public demo use',
    ],
    blockingPatterns: [/\bTBD\b/g, /"TBD"/g, /\bNot run\b/g],
    positivePatterns: [
      /"education_campaign_demo_ready":\s*(true|"true")/i,
      /Is the session real hardware\?\s*\|\s*(Yes|Pass|true)/i,
      /Can this be used as one of the campaign education demos\?\s*\|\s*(Yes|Pass|Conditional pass)/i,
    ],
    artifactRequirements: [
      { label: 'education raw session', fieldLabels: ['Raw session path'] },
      { label: 'education replay', fieldLabels: ['Replay path'] },
      { label: 'education video', fieldLabels: ['Video path'] },
      { label: 'exported lesson note', fieldLabels: ['Exported lesson note path'] },
      { label: 'education analyzer input', fieldLabels: ['Analyzer input path'] },
      { label: 'education analyzer report', fieldLabels: ['Analyzer report path'] },
    ],
    analyzerReportRequirements: [
      {
        label: 'Education demo analyzer gate checks',
        fieldLabels: ['Analyzer report path'],
        checks: [
          { path: 'ok', equals: true },
          { path: 'gate_checks.schema_pass_rate', min: 0.95 },
          { path: 'gate_checks.has_education_session', equals: true },
          { path: 'gate_checks.all_sessions_duration_5_to_8_min', equals: true },
          { path: 'gate_checks.all_promoted_items_have_valid_source_refs', equals: true },
          { path: 'gate_checks.no_severe_hallucinations', equals: true },
          { path: 'gate_checks.education_campaign_demo_ready', equals: true },
        ],
      },
    ],
  },
  {
    id: 'G-MTG-1',
    label: 'Real business meeting demo review',
    file: `${evidenceRoot}/business-meeting-demo-review.md`,
    requiredEvidence: [
      'real 5-8 minute business whiteboard session',
      'raw session and video links',
      'reviewer CSV',
      'analyzer report with meeting_campaign_demo_ready=true',
      'board marks prove promoted outputs',
    ],
    blockingPatterns: [/\bTBD\b/g, /"TBD"/g, /\bNot run\b/g],
    positivePatterns: [
      /"meeting_campaign_demo_ready":\s*(true|"true")/i,
      /Is the session real hardware\?\s*\|\s*(Yes|Pass|true)/i,
      /Did board marks drive the promoted outputs\?\s*\|\s*(Yes|Pass|true)/i,
      /Can this be used as one campaign meeting demo\?\s*\|\s*(Yes|Pass|Conditional pass)/i,
    ],
    artifactRequirements: [
      { label: 'meeting raw session', fieldLabels: ['Raw session path'] },
      { label: 'meeting replay', fieldLabels: ['Replay path'] },
      { label: 'meeting video', fieldLabels: ['Video path'] },
      { label: 'exported meeting output', fieldLabels: ['Exported meeting output path'] },
      { label: 'meeting analyzer input', fieldLabels: ['Analyzer input path'] },
      { label: 'meeting analyzer report', fieldLabels: ['Analyzer report path'] },
      { label: 'board mark evidence', columnLabels: ['Artifact Link'] },
    ],
    analyzerReportRequirements: [
      {
        label: 'Business meeting demo analyzer gate checks',
        fieldLabels: ['Analyzer report path'],
        checks: [
          { path: 'ok', equals: true },
          { path: 'gate_checks.schema_pass_rate', min: 0.95 },
          { path: 'gate_checks.has_meeting_session', equals: true },
          { path: 'gate_checks.all_sessions_duration_5_to_8_min', equals: true },
          { path: 'gate_checks.all_promoted_items_have_valid_source_refs', equals: true },
          { path: 'gate_checks.no_severe_hallucinations', equals: true },
          { path: 'gate_checks.meeting_campaign_demo_ready', equals: true },
        ],
      },
    ],
  },
  {
    id: 'G-SUPPLY-1',
    label: 'BOM and supplier readiness',
    file: `${evidenceRoot}/bom-supplier-tracker.md`,
    requiredEvidence: [
      'BOM v0.2 or later',
      '>= 80% required BOM completeness',
      'primary and backup supplier options',
      'quote links for core rows',
      'supplier-backed pricing decision',
    ],
    blockingPatterns: [/\bTBD\b/g, /\|\s*[^|\n]+\|\s*[^|\n]+\|\s*TBD\s*\|/g, /\|\s*[^|\n]+\|\s*0\s*\|/g, /\bOpen\b/g],
    positivePatterns: [
      /Is BOM >= 80% complete\?\s*\|\s*(Yes|Pass|true)/i,
      /Does each core line have primary and backup options\?\s*\|\s*(Yes|Pass|true)/i,
      /Are quotes current and attached\?\s*\|\s*(Yes|Pass|true)/i,
      /Is reward pricing supported by actual cost data\?\s*\|\s*(Yes|Pass|Conditional pass)/i,
    ],
    artifactRequirements: [
      { label: 'pricing sheet', fieldLabels: ['Pricing sheet path'] },
      { label: 'pricing analyzer report', fieldLabels: ['Pricing analyzer report path'] },
      { label: 'supplier quote evidence', fieldLabels: ['Supplier quote folder'], columnLabels: ['Quote Link'] },
    ],
    analyzerReportRequirements: [
      {
        label: 'Reward pricing analyzer gate checks',
        fieldLabels: ['Pricing analyzer report path'],
        checks: [
          { path: 'ok', equals: true },
          { path: 'gate_checks.schema_pass_rate', min: 0.95 },
          { path: 'gate_checks.bom_completeness_ge_80', equals: true },
          { path: 'gate_checks.confirmed_quote_coverage_ge_80', equals: true },
          { path: 'gate_checks.backup_coverage_ge_80', equals: true },
          { path: 'gate_checks.all_rewards_have_positive_price', equals: true },
          { path: 'gate_checks.pricing_model_has_required_inputs', equals: true },
          { path: 'gate_checks.supplier_backed_for_public_page', equals: true },
        ],
      },
    ],
  },
  {
    id: 'G-GTM-1',
    label: 'GTM demand readiness',
    file: `${evidenceRoot}/gtm-metrics-tracker.md`,
    requiredEvidence: [
      'email list >= 1,000',
      'Kickstarter followers >= 300',
      'public testimonials >= 8',
      'first-day likely backers >= 50',
      'source export links',
    ],
    blockingPatterns: [/\bTBD\b/g, /\|\s*TBD\s*\|\s*0\s*\|\s*0\s*\|\s*0\s*\|\s*0\s*\|/g, /\bNot ready\b/g],
    positivePatterns: [
      /Are final launch targets on track\?\s*\|\s*(Yes|Pass|true)/i,
      /Is there enough evidence to film the campaign video\?\s*\|\s*(Yes|Pass|Conditional pass)/i,
    ],
    artifactRequirements: [
      { label: 'GTM analyzer report', fieldLabels: ['GTM analyzer report path'] },
      { label: 'CRM or Kickstarter source export', columnLabels: ['Source Export Link'] },
      { label: 'public testimonial asset', columnLabels: ['Quote / Clip Link'] },
    ],
    analyzerReportRequirements: [
      {
        label: 'GTM metrics analyzer gate checks',
        fieldLabels: ['GTM analyzer report path'],
        checks: [
          { path: 'ok', equals: true },
          { path: 'gate_checks.schema_pass_rate', min: 0.95 },
          { path: 'gate_checks.gtm_model_has_required_inputs', equals: true },
          { path: 'gate_checks.launch_email_ge_1000', equals: true },
          { path: 'gate_checks.launch_ks_followers_ge_300', equals: true },
          { path: 'gate_checks.testimonials_ge_8', equals: true },
          { path: 'gate_checks.first_day_likely_backers_ge_50', equals: true },
          { path: 'gate_checks.has_education_and_business_leads', equals: true },
          { path: 'gate_checks.launch_demand_ready', equals: true },
        ],
      },
    ],
  },
  {
    id: 'G-PAGE-1',
    label: 'Kickstarter page publish readiness',
    file: `${evidenceRoot}/kickstarter-page-risk-checklist.md`,
    requiredEvidence: [
      'page >= 90% complete',
      'all public claims evidence-linked',
      'unsupported claims removed or downgraded',
      'risk disclosures reviewed',
      'outside legal/privacy review',
    ],
    blockingPatterns: [/\bTBD\b/g, /0% publish evidence/g, /Not ready for publish/g, /Needs review/g, /Needs evidence review/g],
    positivePatterns: [
      /Is the page >= 90% complete\?\s*\|\s*(Yes|Pass|true)/i,
      /Are all public claims evidence-linked\?\s*\|\s*(Yes|Pass|true)/i,
      /Are unsupported claims removed or downgraded\?\s*\|\s*(Yes|Pass|true)/i,
      /Are risk disclosures clear enough for Kickstarter\?\s*\|\s*(Yes|Pass|true)/i,
      /Is the page ready for outside review\?\s*\|\s*(Yes|Pass|Conditional pass)/i,
    ],
    artifactRequirements: [
      { label: 'Kickstarter preview page', fieldLabels: ['Kickstarter preview link'] },
      { label: 'legal/privacy review', fieldLabels: ['Legal/privacy review link'] },
      { label: 'campaign page draft', fieldLabels: ['Page draft link'] },
      { label: 'video script', fieldLabels: ['Video script link'] },
    ],
  },
];

function evaluateGate(gate) {
  if (!existsSync(absolute(gate.file))) {
    return {
      ...gate,
      status: 'missing_record',
      placeholder_count: null,
      positive_checks_passed: 0,
      positive_checks_total: gate.positivePatterns.length,
      artifact_checks_passed: 0,
      artifact_checks_total: gate.artifactRequirements?.length ?? 0,
      artifact_checks: [],
      analyzer_checks_passed: 0,
      analyzer_checks_total: gate.analyzerReportRequirements?.length ?? 0,
      analyzer_checks: [],
      blockers: [`missing evidence record: ${gate.file}`],
    };
  }

  const text = readText(gate.file);
  const placeholderCount = gate.blockingPatterns.reduce((sum, pattern) => sum + countMatches(text, pattern), 0);
  const positiveChecksPassed = gate.positivePatterns.filter((pattern) => pattern.test(text)).length;
  const artifactChecks = (gate.artifactRequirements ?? []).map((requirement) => evaluateArtifactRequirement(requirement, text, gate.file));
  const artifactChecksPassed = artifactChecks.filter((check) => check.passed).length;
  const analyzerChecks = (gate.analyzerReportRequirements ?? []).map((requirement) =>
    evaluateAnalyzerReportRequirement(requirement, text, gate.file),
  );
  const analyzerChecksPassed = analyzerChecks.filter((check) => check.passed).length;
  const blockers = [];
  if (placeholderCount > 0) blockers.push(`${placeholderCount} placeholder/blocking markers remain`);
  if (positiveChecksPassed < gate.positivePatterns.length) {
    blockers.push(`${gate.positivePatterns.length - positiveChecksPassed} required launch-positive decisions are absent`);
  }
  if (artifactChecksPassed < artifactChecks.length) {
    blockers.push(`${artifactChecks.length - artifactChecksPassed} required raw artifact link groups are absent or unresolved`);
  }
  if (analyzerChecksPassed < analyzerChecks.length) {
    blockers.push(`${analyzerChecks.length - analyzerChecksPassed} required analyzer reports are absent, unreadable, or failing gate checks`);
  }

  return {
    id: gate.id,
    label: gate.label,
    file: gate.file,
    status: blockers.length === 0 ? 'launch_ready_evidence_present' : 'not_launch_ready',
    placeholder_count: placeholderCount,
    positive_checks_passed: positiveChecksPassed,
    positive_checks_total: gate.positivePatterns.length,
    artifact_checks_passed: artifactChecksPassed,
    artifact_checks_total: artifactChecks.length,
    artifact_checks: artifactChecks,
    analyzer_checks_passed: analyzerChecksPassed,
    analyzer_checks_total: analyzerChecks.length,
    analyzer_checks: analyzerChecks,
    required_evidence: gate.requiredEvidence,
    blockers,
  };
}

const results = gates.map(evaluateGate);
const notReady = results.filter((result) => result.status !== 'launch_ready_evidence_present');
const report = {
  schema: 'inkloop.launch_evidence_audit.v1',
  generated_at: new Date().toISOString(),
  status: notReady.length === 0 ? 'launch_ready_evidence_present' : 'not_launch_ready',
  strict,
  summary: {
    gate_count: results.length,
    ready_gate_count: results.length - notReady.length,
    not_ready_gate_count: notReady.length,
  },
  non_claims: [
    'Passing this audit only means the required launch evidence records look complete enough for review.',
    'It does not replace legal, privacy, supplier, manufacturing, Kickstarter, or human campaign review.',
    'A not_launch_ready result is expected while evidence files still contain TBD, Not run, demo-only, or missing external proof markers.',
  ],
  gates: results,
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outPath), `${JSON.stringify(report, null, 2)}\n`);

const rows = results
  .map((result) => `| ${result.id} | ${result.label} | ${result.status} | ${result.placeholder_count ?? 'n/a'} | ${result.positive_checks_passed}/${result.positive_checks_total} | ${result.artifact_checks_passed}/${result.artifact_checks_total} | ${result.analyzer_checks_passed}/${result.analyzer_checks_total} | \`${result.file}\` |`)
  .join('\n');

writeFileSync(absolute(readmePath), `# InkLoop AI Pen Launch Evidence Audit

Generated at: ${report.generated_at}

Status: ${report.status}

This audit separates local demo readiness from real Kickstarter launch readiness. It reads the evidence records under \`${evidenceRoot}/\` and flags gates that still contain placeholders, missing positive launch decisions, incomplete external proof, or local analyzer reports that fail required gate checks.

## Gate Summary

| Gate | Label | Status | Placeholder Markers | Positive Checks | Artifact Checks | Analyzer Checks | Record |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
${rows}

## Non-Claims

${report.non_claims.map((item) => `- ${item}`).join('\n')}

Detailed JSON: [report.json](./report.json)
`);

console.log(`Launch evidence audit status: ${report.status}`);
console.log(`Report: ${outPath}`);
for (const result of results) {
  console.log(`- ${result.id} ${result.label}: ${result.status} (${result.positive_checks_passed}/${result.positive_checks_total} positive checks, ${result.artifact_checks_passed}/${result.artifact_checks_total} artifact checks, ${result.analyzer_checks_passed}/${result.analyzer_checks_total} analyzer checks, placeholders=${result.placeholder_count ?? 'n/a'})`);
}

if (strict && report.status !== 'launch_ready_evidence_present') {
  console.error('Strict launch evidence audit failed: real Kickstarter launch evidence is incomplete.');
  process.exit(1);
}
