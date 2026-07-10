import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const defaultBaseDir = 'test-results/ai-pen-launch-evidence-intake';
const outDir = 'test-results/ai-pen-launch-evidence-intake-audit';
const outJsonPath = `${outDir}/report.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

function parseArgs(argv) {
  const options = { intake: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--strict') continue;
    if (arg === '--intake') {
      options.intake = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(absolute(relativePath), 'utf8'));
}

function latestIntakeDir() {
  const basePath = absolute(defaultBaseDir);
  if (!existsSync(basePath)) return null;
  const dirs = readdirSync(basePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = `${defaultBaseDir}/${entry.name}`;
      const manifestPath = `${dir}/manifest.json`;
      if (!existsSync(absolute(manifestPath))) return null;
      const manifest = readJson(manifestPath);
      const generatedAt = Date.parse(manifest.generated_at ?? '');
      return {
        dir,
        generatedAt: Number.isNaN(generatedAt) ? 0 : generatedAt,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.generatedAt - b.generatedAt || a.dir.localeCompare(b.dir));
  return dirs.at(-1)?.dir ?? null;
}

function listFiles(relativeDir) {
  const fullDir = absolute(relativeDir);
  if (!existsSync(fullDir)) return [];
  const results = [];
  function walk(currentDir) {
    for (const entry of readdirSync(absolute(currentDir), { withFileTypes: true })) {
      const relativePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(relativePath);
      } else if (entry.isFile()) {
        results.push(relativePath);
      }
    }
  }
  walk(relativeDir);
  return results;
}

function isTemplateFile(relativePath, templateFiles = new Set()) {
  return templateFiles.has(relativePath) || /\.template\./.test(path.basename(relativePath));
}

function isNonEmptyFile(relativePath) {
  return existsSync(absolute(relativePath)) && statSync(absolute(relativePath)).size > 0;
}

function parseAnalyzerCommand(command) {
  if (!command) return null;
  const inputMatch = command.match(/\s--\s+(.+?)\s+--out\s+(.+)$/);
  if (!inputMatch) return null;
  return {
    input: inputMatch[1].trim(),
    report: inputMatch[2].trim(),
  };
}

function readAnalyzerReport(relativePath) {
  if (!relativePath || !existsSync(absolute(relativePath))) {
    return {
      present: false,
      parse_ok: false,
      ok_flag: false,
      gate_checks_passed: false,
      failing_gate_checks: [],
    };
  }

  try {
    const report = readJson(relativePath);
    const gateChecks = report.gate_checks && typeof report.gate_checks === 'object' ? report.gate_checks : {};
    const failingGateChecks = Object.entries(gateChecks)
      .filter(([, value]) => value !== true && value !== 1)
      .map(([key]) => key);
    return {
      present: true,
      parse_ok: true,
      ok_flag: report.ok === true,
      gate_checks_passed: failingGateChecks.length === 0 && Object.keys(gateChecks).length > 0,
      failing_gate_checks: failingGateChecks,
    };
  } catch (error) {
    return {
      present: true,
      parse_ok: false,
      ok_flag: false,
      gate_checks_passed: false,
      failing_gate_checks: [],
      parse_error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeGateDir(gate, intakeDir) {
  return gate.folder.startsWith(intakeDir) ? gate.folder : path.join(intakeDir, path.basename(gate.folder));
}

function evaluateGate(gate, intakeDir) {
  const gateDir = normalizeGateDir(gate, intakeDir);
  const rawDir = `${gateDir}/raw`;
  const reportsDir = `${gateDir}/reports`;
  const artifactsDir = `${gateDir}/artifacts`;
  const analyzerPaths = parseAnalyzerCommand(gate.analyzer_command);
  const templateFiles = new Set((gate.template_files ?? []).map((file) => (file.startsWith(intakeDir) ? file : path.join(intakeDir, path.basename(file)))));
  const rawFiles = listFiles(rawDir);
  const reportFiles = listFiles(reportsDir);
  const artifactFiles = listFiles(artifactsDir);
  const nonTemplateRawFiles = rawFiles.filter((file) => !isTemplateFile(file, templateFiles));
  const nonTemplateArtifactFiles = artifactFiles.filter((file) => !isTemplateFile(file, templateFiles));
  const expectedInput = analyzerPaths?.input ?? null;
  const expectedReport = analyzerPaths?.report ?? null;
  const expectedInputPresent = expectedInput ? isNonEmptyFile(expectedInput) && !isTemplateFile(expectedInput, templateFiles) : true;
  const analyzerReport = expectedReport ? readAnalyzerReport(expectedReport) : null;
  const supportingFileCount =
    nonTemplateArtifactFiles.length + nonTemplateRawFiles.filter((file) => file !== expectedInput).length + reportFiles.length;

  const checks = [];
  checks.push({
    label: 'gate folders exist',
    passed: [rawDir, reportsDir, artifactsDir].every((dir) => existsSync(absolute(dir))),
  });
  checks.push({
    label: 'non-template raw evidence exists',
    passed: nonTemplateRawFiles.length > 0,
  });
  if (expectedInput) {
    checks.push({
      label: 'expected analyzer input exists',
      passed: expectedInputPresent,
      detail: expectedInput,
    });
    checks.push({
      label: 'expected analyzer report exists and parses',
      passed: analyzerReport.present && analyzerReport.parse_ok,
      detail: expectedReport,
    });
    checks.push({
      label: 'expected analyzer report ok=true',
      passed: analyzerReport.ok_flag,
      detail: expectedReport,
    });
    checks.push({
      label: 'expected analyzer gate_checks all pass',
      passed: analyzerReport.gate_checks_passed,
      detail: analyzerReport.failing_gate_checks.join(', ') || expectedReport,
    });
  } else {
    checks.push({
      label: 'manual review artifacts exist',
      passed: nonTemplateRawFiles.length > 0 || nonTemplateArtifactFiles.length > 0,
    });
  }
  checks.push({
    label: 'supporting artifacts or review files exist',
    passed: supportingFileCount > 0,
  });

  const blockers = checks.filter((check) => !check.passed).map((check) => check.label);
  return {
    id: gate.id,
    label: gate.label,
    status: blockers.length === 0 ? 'ready_for_evidence_record_update' : 'intake_not_ready',
    folder: gateDir,
    record: gate.record,
    analyzer: gate.analyzer,
    analyzer_command: gate.analyzer_command,
    expected_input: expectedInput,
    expected_report: expectedReport,
    raw_files: rawFiles,
    non_template_raw_files: nonTemplateRawFiles,
    report_files: reportFiles,
    artifact_files: artifactFiles,
    non_template_artifact_files: nonTemplateArtifactFiles,
    raw_file_count: rawFiles.length,
    non_template_raw_file_count: nonTemplateRawFiles.length,
    report_file_count: reportFiles.length,
    artifact_file_count: artifactFiles.length,
    non_template_artifact_file_count: nonTemplateArtifactFiles.length,
    analyzer_report: analyzerReport,
    checks,
    blockers,
  };
}

function readme(report) {
  const rows = report.gates
    .map(
      (gate) =>
        `| ${gate.id} | ${gate.label} | ${gate.status} | ${gate.non_template_raw_file_count}/${gate.raw_file_count} | ${gate.report_file_count} | ${gate.non_template_artifact_file_count}/${gate.artifact_file_count} | \`${gate.folder}\` |`,
    )
    .join('\n');
  const blockers = report.gates
    .filter((gate) => gate.blockers.length)
    .map((gate) => `## ${gate.id} ${gate.label}\n\n${gate.blockers.map((blocker) => `- ${blocker}`).join('\n')}`)
    .join('\n\n');
  return `# InkLoop AI Pen Launch Evidence Intake Audit

Schema: \`inkloop.launch_evidence_intake_audit.v1\`

Generated at: ${report.generated_at}

Status: ${report.status}

Intake: \`${report.intake_dir}\`

This audit checks whether the latest launch evidence intake package has enough non-template raw files, analyzer reports, and supporting artifacts to update the Markdown evidence records. It does not make any launch claim and does not replace \`npm run launch:evidence:audit\`.

## Gate Summary

| Gate | Label | Status | Non-Template Raw | Reports | Non-Template Artifacts | Folder |
| --- | --- | --- | ---: | ---: | ---: | --- |
${rows}

## Blockers

${blockers || '- None'}

## Non-Claims

${report.non_claims.map((item) => `- ${item}`).join('\n')}

Detailed JSON: [report.json](./report.json)
`;
}

const options = parseArgs(process.argv.slice(2));
const intakeDir = options.intake ?? latestIntakeDir();
if (!intakeDir) throw new Error(`no launch evidence intake directory found under ${defaultBaseDir}`);
const manifestPath = `${intakeDir}/manifest.json`;
if (!existsSync(absolute(manifestPath))) throw new Error(`missing launch evidence intake manifest: ${manifestPath}`);

const manifest = readJson(manifestPath);
const gates = (manifest.gates ?? []).map((gate) => evaluateGate(gate, intakeDir));
const notReady = gates.filter((gate) => gate.status !== 'ready_for_evidence_record_update');
const report = {
  schema: 'inkloop.launch_evidence_intake_audit.v1',
  generated_at: new Date().toISOString(),
  strict,
  intake_dir: intakeDir,
  status: notReady.length === 0 ? 'ready_for_evidence_record_update' : 'intake_not_ready',
  summary: {
    gate_count: gates.length,
    ready_gate_count: gates.length - notReady.length,
    not_ready_gate_count: notReady.length,
    blocker_count: gates.reduce((sum, gate) => sum + gate.blockers.length, 0),
  },
  non_claims: [
    'Passing this intake audit only means staging files look ready to paste into evidence records.',
    'It does not replace the launch evidence audit, strict launch gate, legal/privacy review, supplier review, or Kickstarter preview review.',
    'Template files and fixture rows are intentionally ignored as launch proof.',
  ],
  gates,
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Launch evidence intake audit status: ${report.status}`);
console.log(`Gates: ${report.summary.ready_gate_count}/${report.summary.gate_count} ready for evidence-record update`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status !== 'ready_for_evidence_record_update') {
  console.error('Strict launch evidence intake audit failed: staged launch evidence is incomplete.');
  process.exit(1);
}
