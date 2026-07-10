import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const defaultRunId = new Date().toISOString().slice(0, 10);

function parseArgs(argv) {
  const options = {
    runId: defaultRunId,
    outDir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run-id') {
      options.runId = argv[index + 1];
      index += 1;
    } else if (arg === '--out') {
      options.outDir = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.runId) throw new Error('--run-id requires a value');
  options.outDir ??= `test-results/ai-pen-launch-evidence-intake/${options.runId}`;
  return options;
}

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function write(relativePath, content) {
  const fullPath = absolute(relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${content.trimEnd()}\n`);
}

function command(outDir, folder, input, report, script) {
  return `npm --workspace ./examples/ai-annotation-demo run ${script} -- ${outDir}/${folder}/raw/${input} --out ${outDir}/${folder}/reports/${report}`;
}

const gates = [
  {
    id: 'G-HW-1',
    label: '5 working AI Pen prototypes',
    folder: '01-hardware-prototypes',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/hardware-prototype-run-log.md',
    analyzer: 'AI Pen run analyzer',
    analyzerCommand: (outDir, folder) => command(outDir, folder, 'raw-pen-run.jsonl', 'ai-pen-run-report.json', 'evidence:ai-pen-run'),
    fields: ['Raw log path', 'Analyzer report path', 'Replay/export path', 'Video path'],
    templates: {
      'raw/raw-pen-run.template.jsonl':
        '{"schema_version":"inkloop.ai_pen.v1","pen_id":"PEN-001","session_id":"sess_real_001","surface_id":"surface_a3_001","ts_device_ms":0,"ts_host_ms":15,"tip_state":"down","optical":{"x_raw":120,"y_raw":240,"quality":0.98},"pressure":0.5,"battery":0.91,"firmware_version":"0.1.0"}',
      'raw/prototype-inventory.csv':
        'unit_id,hardware_rev,firmware,battery_start,battery_end,session_minutes,event_count,drop_count,cache_recovery,result',
      'raw/failure-log.csv': 'time,unit_id,symptom,repro_steps,severity,owner,fix_follow_up',
    },
  },
  {
    id: 'G-SURF-1',
    label: 'Capture Surface calibration',
    folder: '02-capture-surface-calibration',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/capture-surface-calibration-report.md',
    analyzer: 'Capture Surface calibration analyzer',
    analyzerCommand: (outDir, folder) =>
      command(outDir, folder, 'capture-surface-calibration.csv', 'capture-surface-report.json', 'evidence:capture-surface'),
    fields: ['Raw trace path', 'Analyzer report path', 'Measurement sheet path', 'Photo/video path'],
    templates: {
      'raw/capture-surface-calibration.template.csv':
        'run_id,surface_id,surface_size,point_id,region,expected_x_mm,expected_y_mm,observed_x_mm,observed_y_mm,lighting,condition',
      'raw/material-notes.csv': 'surface_id,surface_size,material_batch,marker_type,glare_condition,wipe_condition,notes',
    },
  },
  {
    id: 'G-LIVE-1',
    label: 'Live Board real latency',
    folder: '03-live-board-latency',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/live-board-latency-report.md',
    analyzer: 'Live Board latency analyzer',
    analyzerCommand: (outDir, folder) =>
      command(outDir, folder, 'live-board-timing.csv', 'live-board-latency-report.json', 'evidence:live-board-latency'),
    fields: ['Raw event log path', 'Analyzer report path', 'Render timing log path', 'Replay path'],
    templates: {
      'raw/live-board-timing.template.csv':
        'run_id,scenario,event_id,raw_frame_timestamp_ms,host_receive_timestamp_ms,ink_event_timestamp_ms,render_commit_timestamp_ms,dropped,transport,pen_id,session_id',
    },
  },
  {
    id: 'G-EDU-1',
    label: 'Real education demo review',
    folder: '04-education-demo-review',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/education-demo-review.md',
    analyzer: 'Demo review analyzer',
    analyzerCommand: (outDir, folder) =>
      command(outDir, folder, 'education-demo-review.csv', 'education-demo-review-report.json', 'evidence:demo-review'),
    fields: ['Raw session path', 'Replay path', 'Video path', 'Exported lesson note path', 'Analyzer input path', 'Analyzer report path'],
    templates: {
      'raw/education-demo-review.template.csv':
        'session_id,scenario,real_hardware,duration_min,candidate_id,kind,source_ref_valid,source_ref_type,reviewer_action,hallucination_severity,audio_only,diagram_was_drawn,final_use',
      'raw/reviewer-notes.csv': 'timecode,candidate_id,reviewer,action,reason,public_demo_note',
    },
  },
  {
    id: 'G-MTG-1',
    label: 'Real business meeting demo review',
    folder: '05-business-meeting-demo-review',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/business-meeting-demo-review.md',
    analyzer: 'Demo review analyzer',
    analyzerCommand: (outDir, folder) =>
      command(outDir, folder, 'business-meeting-demo-review.csv', 'business-meeting-demo-review-report.json', 'evidence:demo-review'),
    fields: ['Raw session path', 'Replay path', 'Video path', 'Exported meeting output path', 'Analyzer input path', 'Analyzer report path'],
    templates: {
      'raw/business-meeting-demo-review.template.csv':
        'session_id,scenario,real_hardware,duration_min,candidate_id,kind,source_ref_valid,source_ref_type,reviewer_action,hallucination_severity,audio_only,diagram_was_drawn,final_use',
      'raw/meeting-context-artifacts.csv': 'artifact_type,path_or_url,role,used_as_evidence,notes',
    },
  },
  {
    id: 'G-SUPPLY-1',
    label: 'BOM and supplier readiness',
    folder: '06-bom-supplier-readiness',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/bom-supplier-tracker.md',
    analyzer: 'Reward pricing analyzer',
    analyzerCommand: (outDir, folder) => command(outDir, folder, 'bom.csv', 'reward-pricing-report.json', 'evidence:reward-pricing'),
    fields: ['Pricing sheet path', 'Pricing analyzer report path', 'Supplier quote folder'],
    templates: {
      'raw/bom.template.csv':
        'reward_sku,category,component,required,quantity_per_reward,unit_cost_usd,primary_supplier,backup_supplier,quote_status,confidence,lead_time_days,moq,risk',
      'raw/supplier-quotes-index.csv': 'component,supplier,quote_status,quote_path_or_url,valid_until,owner,notes',
    },
  },
  {
    id: 'G-GTM-1',
    label: 'GTM demand readiness',
    folder: '07-gtm-demand-readiness',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/gtm-metrics-tracker.md',
    analyzer: 'GTM metrics analyzer',
    analyzerCommand: (outDir, folder) => command(outDir, folder, 'gtm-snapshots.csv', 'gtm-report.json', 'evidence:gtm-metrics'),
    fields: ['GTM analyzer report path', 'CRM export folder', 'Kickstarter dashboard export link'],
    templates: {
      'raw/gtm-snapshots.template.csv':
        'week_ending,email_list,ks_followers,testimonials,first_day_likely_backers,education_leads,business_leads,source_export_link,decision',
      'raw/testimonials-index.csv': 'id,segment,consent_status,quote_or_clip_link,asset_type,page_use,notes',
    },
  },
  {
    id: 'G-PAGE-1',
    label: 'Kickstarter page publish readiness',
    folder: '08-kickstarter-page-review',
    record: 'docs/project/inkloop-ai-pen-kickstarter/evidence/kickstarter-page-risk-checklist.md',
    analyzer: 'No analyzer; outside review required',
    analyzerCommand: null,
    fields: ['Kickstarter preview link', 'Legal/privacy review link', 'Page draft link', 'Video script link'],
    templates: {
      'raw/page-review-notes.csv': 'reviewer,review_type,artifact_link,decision,blocking_issue,next_action',
      'raw/claim-review-index.csv': 'claim_id,page_location,evidence_link,decision,downgraded_copy',
    },
  },
];

function gateReadme(gate, outDir) {
  const analyzerBlock = gate.analyzerCommand
    ? `Run analyzer after replacing the template with real rows:\n\n\`\`\`bash\n${gate.analyzerCommand(outDir, gate.folder)}\n\`\`\``
    : 'No local analyzer closes this gate. Attach the Kickstarter preview link and outside legal/privacy review before launch audit strict mode can pass.';
  const fieldRows = gate.fields.map((field) => `| ${field} | Paste the resolved local path or external review URL into \`${gate.record}\` |`).join('\n');
  return `# ${gate.id} ${gate.label}

Record: \`${gate.record}\`

Analyzer: ${gate.analyzer}

${analyzerBlock}

## Evidence Fields To Update

| Field | Destination |
| --- | --- |
${fieldRows}

## Rules

- Do not mark this gate pass from fixture data.
- Keep raw files under \`${outDir}/${gate.folder}/raw/\` or link the external source URL.
- Keep analyzer JSON under \`${outDir}/${gate.folder}/reports/\`.
- Keep videos, screenshots, quote PDFs, or review exports under \`${outDir}/${gate.folder}/artifacts/\`.
- After updating the evidence record, run \`npm run launch:evidence:audit\`.
`;
}

function rootReadme(outDir, generatedAt) {
  const rows = gates
    .map((gate) => `| ${gate.id} | ${gate.label} | \`${gate.folder}/README.md\` | \`${gate.record}\` |`)
    .join('\n');
  const commands = gates
    .filter((gate) => gate.analyzerCommand)
    .map((gate) => `# ${gate.id} ${gate.label}\n${gate.analyzerCommand(outDir, gate.folder)}`)
    .join('\n\n');
  return `# InkLoop AI Pen Launch Evidence Intake

Schema: \`inkloop.launch_evidence_intake.v1\`

Generated at: ${generatedAt}

This package is a staging area for real Kickstarter launch evidence. It does not prove launch readiness by itself. It exists to keep raw artifacts, analyzer outputs, videos, quotes, CRM exports, and review notes in one predictable structure before the evidence records are updated.

## Gate Folders

| Gate | Label | Intake Folder | Evidence Record |
| --- | --- | --- | --- |
${rows}

## Analyzer Commands

Replace each \`.template.*\` input with real rows first.

\`\`\`bash
${commands}
\`\`\`

## Closeout Steps

1. Put raw evidence and external artifact exports into the matching gate folder.
2. Run the analyzer command for gates that have one.
3. Paste raw artifact paths, analyzer report paths, and review links into the matching Markdown evidence record.
4. Run \`npm run launch:evidence:audit\` and keep \`npm run launch:evidence:audit:strict\` failing until every external gate is genuinely ready.
5. If a gate cannot pass, downgrade the public Kickstarter claim instead of hiding the missing evidence.
`;
}

function manifest(outDir, generatedAt) {
  return {
    schema: 'inkloop.launch_evidence_intake.v1',
    generated_at: generatedAt,
    out_dir: outDir,
    non_claims: [
      'This intake package is not launch evidence by itself.',
      'Fixture or template rows must not be used as Kickstarter proof.',
      'Strict launch audit may pass only after real raw artifacts, analyzer reports, and human decisions are linked from evidence records.',
    ],
    gates: gates.map((gate) => ({
      id: gate.id,
      label: gate.label,
      folder: `${outDir}/${gate.folder}`,
      record: gate.record,
      analyzer: gate.analyzer,
      analyzer_command: gate.analyzerCommand ? gate.analyzerCommand(outDir, gate.folder) : null,
      evidence_fields: gate.fields,
      template_files: Object.keys(gate.templates).map((file) => `${outDir}/${gate.folder}/${file}`),
    })),
  };
}

const { outDir } = parseArgs(process.argv.slice(2));
const generatedAt = new Date().toISOString();

for (const gate of gates) {
  for (const dir of ['raw', 'reports', 'artifacts']) {
    mkdirSync(absolute(`${outDir}/${gate.folder}/${dir}`), { recursive: true });
  }
  for (const [file, content] of Object.entries(gate.templates)) {
    write(`${outDir}/${gate.folder}/${file}`, content);
  }
  write(`${outDir}/${gate.folder}/README.md`, gateReadme(gate, outDir));
}

write(`${outDir}/README.md`, rootReadme(outDir, generatedAt));
write(`${outDir}/manifest.json`, JSON.stringify(manifest(outDir, generatedAt), null, 2));

console.log(`Launch evidence intake package created: ${outDir}`);
console.log(`README: ${outDir}/README.md`);
