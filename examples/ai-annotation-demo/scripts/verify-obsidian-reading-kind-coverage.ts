import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildInkloopDocUri,
  canonicalJson,
  computeDocumentProjectionBodyHash,
  computeDocumentProjectionHash,
  DOCUMENT_PROJECTION_SCHEMA_VERSION,
  KO_SCHEMA_VERSION,
  sha256ContentHash,
  type DocumentProjection,
  type KnowledgeKind,
  type KnowledgeObject,
  type MarkdownCallout,
} from 'ink-surface-sdk/knowledge-schema';
import {
  OBSIDIAN_CONTROLLED_FIELDS_MARKER,
  parseObsidianControlledKnowledgeEdit,
  renderVaultMarkdown,
  type RenderedFile,
} from 'ink-surface-sdk/adapters/obsidian';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const VAULT_ROOT = resolve(process.env.INKLOOP_READING_KIND_VAULT || join(REPO_ROOT, 'test-results/obsidian-reading-kind-coverage-vault'));
const ACTIVE_OBSIDIAN_VAULT_ROOT = resolve(process.env.INKLOOP_ACTIVE_OBSIDIAN_VAULT || join(process.env.HOME || '', 'Desktop/InkLoop-Obsidian-Test-Vault'));
const MIRROR_ACTIVE_VAULT = process.env.INKLOOP_MIRROR_READING_KIND_COVERAGE_TO_ACTIVE === '1';

function fail(message: string): never {
  throw new Error(message);
}

function nowIso(): string {
  return new Date().toISOString();
}

function targetInVault(vaultAbs: string, relPath: string): string {
  const target = resolve(vaultAbs, relPath);
  const rel = relative(vaultAbs, target);
  if (isAbsolute(rel) || rel.split(/[\\/]/)[0] !== 'InkLoop') throw new Error(`refusing to write outside InkLoop/: ${relPath}`);
  return target;
}

async function writeRenderedFiles(vaultRoot: string, files: RenderedFile[], clean = false): Promise<string[]> {
  if (clean) await rm(join(vaultRoot, 'InkLoop'), { recursive: true, force: true });
  const written: string[] = [];
  for (const file of files) {
    const target = targetInVault(vaultRoot, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.markdown, 'utf8');
    written.push(target);
  }
  return written;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const target = join(dir, entry);
    const info = await stat(target).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) files.push(...await listMarkdownFiles(target));
    else if (entry.endsWith('.md')) files.push(target);
  }
  return files;
}

async function assertActiveVaultReadingClean(vaultRoot: string): Promise<{ checked_files: number }> {
  const readingRoot = join(vaultRoot, 'InkLoop', 'Reading');
  const files = await listMarkdownFiles(readingRoot);
  const forbidden = [
    /^##\s*(Task|Decision|Risk)\s*$/m,
    /^##\s*(任务|决策|风险)\s*$/m,
    /^##\s*(Reading Note|Highlight)\s*$/m,
  ];
  for (const file of files) {
    const markdown = await readFile(file, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(markdown)) fail(`active vault Reading file still contains meeting/legacy section ${pattern}: ${file}`);
    }
  }
  return { checked_files: files.length };
}

function docRef(input: { docId: string; markId: string; pageIndex: number; quote: string }) {
  return {
    ref_type: 'document' as const,
    document_id: input.docId,
    page_id: `pg_${input.docId}_${input.pageIndex + 1}`,
    page_index: input.pageIndex,
    event_id: input.markId,
    bbox: [0.18, 0.22, 0.42, 0.08] as [number, number, number, number],
    object_refs: [`blk_${input.markId}`],
    quote: input.quote,
    confidence: 0.98,
  };
}

async function knowledgeObject(input: {
  docId: string;
  docTitle: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  markId: string;
  callout?: MarkdownCallout;
}): Promise<KnowledgeObject> {
  const createdAt = nowIso();
  const sourceRef = docRef({ docId: input.docId, markId: input.markId, pageIndex: 0, quote: input.title });
  const uri = `${buildInkloopDocUri(input.docId)}?page=0&anchor=${encodeURIComponent(input.markId)}`;
  const draft = {
    schema_version: KO_SCHEMA_VERSION,
    ko_id: `ko_${input.kind}_${input.markId}`,
    kind: input.kind,
    title: input.title,
    body_md: `${input.body}\n\nBacklink: ${uri}`,
    source: {
      document_id: input.docId,
      document_title: input.docTitle,
      page_id: sourceRef.page_id,
      page_index: sourceRef.page_index,
      object_refs: sourceRef.object_refs,
      anchor_bbox: sourceRef.bbox,
      quote: sourceRef.quote,
      inkloop_uri: uri,
    },
    provenance: {
      created_from: 'mark' as const,
      mark_ids: [input.markId],
      ai_turn_ids: [`turn_${input.markId}`],
    },
    source_refs: [sourceRef],
    tags: ['inkloop', `inkloop/${input.kind}`, 'inkloop/reading'],
    status: 'inbox' as const,
    controlled_fields: {
      ...(input.kind === 'task' ? { task_done: false } : {}),
      ...(input.kind === 'risk' ? { risk_status: 'open' as const, risk_note: 'Owner review pending.' } : {}),
      ...(input.kind === 'highlight' ? { comment_md: 'Worth reviewing in the next planning pass.' } : {}),
    },
    privacy: 'export_allowed' as const,
    render_hints: input.callout ? { markdown_callout: input.callout } : undefined,
    content_hash: 'sha256:pending' as const,
    created_at: createdAt,
    updated_at: createdAt,
  };
  return {
    ...draft,
    content_hash: await sha256ContentHash(canonicalJson({
      kind: draft.kind,
      title: draft.title,
      body_md: draft.body_md,
      source: draft.source,
      source_refs: draft.source_refs,
      controlled_fields: draft.controlled_fields,
      status: draft.status,
    })),
  };
}

async function projection(input: { docId: string; docTitle: string; kos: KnowledgeObject[] }): Promise<DocumentProjection> {
  const createdAt = nowIso();
  const blocks = input.kos.map((ko, index) => ({
    block_id: `blk_projection_${ko.ko_id}`,
    kind: index === 0 ? 'heading' : 'paragraph',
    heading_level: index === 0 ? 2 : undefined,
    text_md: `${ko.title}: ${ko.source.quote ?? ko.title}`,
    region: 'generated',
    source: {
      page_id: `pg_${input.docId}_1`,
      page_index: 0,
      object_refs: ko.source.object_refs,
      anchor_bbox: ko.source.anchor_bbox,
    },
    knowledge_object_ids: [ko.ko_id],
  }));
  const draft = {
    schema_version: DOCUMENT_PROJECTION_SCHEMA_VERSION,
    projection_id: `dp_${input.docId}_reading_kind_coverage`,
    document_id: input.docId,
    document_title: input.docTitle,
    document_uri: buildInkloopDocUri(input.docId),
    revision_id: `rev_${input.docId}`,
    generated_at: createdAt,
    source: { app: 'inkloop', app_version: 'v1-product-smoke' },
    privacy: 'export_allowed' as const,
    export_policy: {
      include_full_text: false,
      include_pdf_asset: false,
      include_raw_strokes: false,
      include_debug_evidence: false,
    },
    blocks,
    body_hash: 'sha256:pending' as const,
    content_hash: 'sha256:pending' as const,
    created_at: createdAt,
    updated_at: createdAt,
  };
  const bodyHash = await computeDocumentProjectionBodyHash(blocks);
  return {
    ...draft,
    body_hash: bodyHash,
    content_hash: await computeDocumentProjectionHash({ ...draft, body_hash: bodyHash }),
  };
}

function fileForKind(files: RenderedFile[], kind: KnowledgeKind): RenderedFile {
  const file = files.find((item) => item.markdown.includes(`inkloop_knowledge_kind: "${kind}"`));
  if (!file) fail(`missing rendered ${kind} note`);
  return file;
}

function expectContains(markdown: string, needle: string, label: string): void {
  if (!markdown.includes(needle)) fail(`${label} missing ${needle}`);
}

async function main(): Promise<void> {
  const started = Date.now();
  const docId = `doc_reading_kind_${Date.now().toString(36)}`;
  const docTitle = `InkLoop Reading Kind Coverage ${new Date().toISOString()}`;
  const kos = await Promise.all([
    knowledgeObject({ docId, docTitle, kind: 'reading_note', title: '阅读摘要', body: '整理后的阅读思考。', markId: 'ann_reading_note', callout: 'summary' }),
    knowledgeObject({ docId, docTitle, kind: 'highlight', title: '关键高亮', body: '关键原文摘录。', markId: 'ann_highlight', callout: 'quote' }),
    knowledgeObject({ docId, docTitle, kind: 'annotation', title: '手写想法', body: '边读边写下的判断和问题。', markId: 'ann_annotation', callout: 'note' }),
    knowledgeObject({ docId, docTitle, kind: 'ai_note', title: 'AI 笔刷回应', body: 'AI 根据原文和手写边注生成的阅读回应。', markId: 'ann_ai_note', callout: 'note' }),
  ]);
  const documentProjection = await projection({ docId, docTitle, kos });
  const renderedFiles = renderVaultMarkdown({
    entities: [{
      documentId: docId,
      documentTitle: docTitle,
      mode: 'reading',
      dates: [nowIso().slice(0, 10)],
      knowledgeObjects: kos,
      documentProjections: [documentProjection],
    }],
  });
  if (renderedFiles.length !== 5) fail(`expected source hub plus 4 reading KO files, got ${renderedFiles.length}`);

  const expectations: Array<[KnowledgeKind, string]> = [
    ['reading_note', '> [!summary] 阅读摘要'],
    ['highlight', '> [!quote] 关键高亮'],
    ['annotation', '> [!note] 手写想法'],
    ['ai_note', '> [!note] AI 笔刷回应'],
  ];
  for (const [kind, callout] of expectations) {
    const file = fileForKind(renderedFiles, kind);
    expectContains(file.markdown, callout, `${kind} callout`);
    expectContains(file.markdown, OBSIDIAN_CONTROLLED_FIELDS_MARKER, `${kind} controlled section`);
    expectContains(file.markdown, `inkloop://doc/${encodeURIComponent(docId)}`, `${kind} backlink`);
    expectContains(file.markdown, 'inkloop_projection_role: "knowledge_projection"', `${kind} frontmatter`);
  }

  const highlightEdit = parseObsidianControlledKnowledgeEdit(fileForKind(renderedFiles, 'highlight').markdown
    .replace('- Comment: Worth reviewing in the next planning pass.', '- Comment: Keep for demo narration.'));
  if (highlightEdit?.patch.comment_md !== 'Keep for demo narration.') fail(`highlight controlled edit did not parse: ${JSON.stringify(highlightEdit)}`);

  const written = await writeRenderedFiles(VAULT_ROOT, renderedFiles, true);
  let activeVaultMirror: { vault_root: string; rendered_file_count: number; files: string[] } | null = null;
  if (MIRROR_ACTIVE_VAULT && ACTIVE_OBSIDIAN_VAULT_ROOT && ACTIVE_OBSIDIAN_VAULT_ROOT !== VAULT_ROOT) {
    const activeFiles = await writeRenderedFiles(ACTIVE_OBSIDIAN_VAULT_ROOT, renderedFiles, false);
    activeVaultMirror = { vault_root: ACTIVE_OBSIDIAN_VAULT_ROOT, rendered_file_count: activeFiles.length, files: activeFiles };
  }
  const activeVaultReadingGuard = await assertActiveVaultReadingClean(ACTIVE_OBSIDIAN_VAULT_ROOT);

  console.log(JSON.stringify({
    ok: true,
    latency_ms: Date.now() - started,
    document_id: docId,
    rendered_kind_count: expectations.length,
    rendered_file_count: renderedFiles.length,
    required_kinds: expectations.map(([kind]) => kind),
    controlled_writeback: {
      highlight_comment: highlightEdit.patch.comment_md,
    },
    vault_projection: {
      vault_root: VAULT_ROOT,
      rendered_file_count: written.length,
      files: written,
      active_vault_mirror: activeVaultMirror,
      active_vault_reading_guard: activeVaultReadingGuard,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
