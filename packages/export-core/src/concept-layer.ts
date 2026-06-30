import type { KnowledgeObject } from '../../knowledge-schema/src/index.js';

/** Synthetic document id for concept objects (they belong to no real document). */
export const CONCEPT_DOC_ID = 'inkloop_concepts';

/** Extractor: read one KO -> canonical concept names it touches. Real impl (host) does the LLM call + caching. */
export type ConceptExtractFn = (ko: KnowledgeObject) => Promise<readonly string[]>;

export interface ConceptKnowledgeObjectDraft {
  stableKey: `concept:${string}`;
  normalizedName: string;
  displayName: string;
  documentId: typeof CONCEPT_DOC_ID;
  documentTitle: string;
  bodyMarkdown: string;
  memberKoIds: readonly string[];
  sourceDocumentIds: readonly string[];
  createdAt: string;
}

/** Host-injected factory: turn a concept draft into a canonical KnowledgeObject (kind='concept'). SDK never builds KOs itself. */
export type ConceptKnowledgeObjectFactory = (draft: ConceptKnowledgeObjectDraft) => Promise<KnowledgeObject>;

export interface ConceptReg {
  display: string;
  koIds: string[];
  docs: Set<string>;
  earliest: string;
}

export type ConceptMergeFn = (reg: ReadonlyMap<string, ConceptReg>) => ReadonlyMap<string, string>;

export interface ConceptLayer {
  concepts: KnowledgeObject[];
  assignmentsByKo: Record<string, string[]>;
  membersByConcept: Record<string, string[]>;
  localByKo: Record<string, string[]>;
}

export interface ConceptOpts {
  topK?: number;
  minMembers?: number;
  minDocs?: number;
  minLocalMembers?: number;
  merge?: ConceptMergeFn;
}

const PLACEHOLDER = new Set(['（图形标注 / 圈画）', '（未识别手写）', '（无文字转写）', '（无转写）', '（这段）']);

function conceptBody(body: string): string {
  return body.trim().replace(/[\s　]*[（(]约[^)）]*处手写[)）]\s*$/u, '').trim();
}

export function normConcept(input: string): string {
  return input.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function normalizeAliasMap(aliasMap: ReadonlyMap<string, string>): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [alias, canonical] of aliasMap) normalized.set(normConcept(alias), normConcept(canonical));
  return normalized;
}

function resolveMergeTarget(key: string, aliasMap: ReadonlyMap<string, string>, reg: ReadonlyMap<string, ConceptReg>): string | undefined {
  let current = key;
  const seen = new Set<string>();

  for (;;) {
    const next = aliasMap.get(current);
    if (!next || next === current) return reg.has(current) ? current : undefined;
    if (seen.has(current) || seen.has(next)) return undefined;
    seen.add(current);
    current = next;
  }
}

function applyMerge(reg: Map<string, ConceptReg>, rawByKo: Map<string, string[]>, aliasMapInput: ReadonlyMap<string, string>): void {
  const aliasMap = normalizeAliasMap(aliasMapInput);
  const redirects = new Map<string, string>();

  for (const alias of [...aliasMap.keys()].sort(compareText)) {
    const canonical = resolveMergeTarget(alias, aliasMap, reg);
    if (!canonical || alias === canonical || !reg.has(alias)) continue;
    redirects.set(alias, canonical);
  }

  for (const [alias, canonical] of redirects) {
    const aliasEntry = reg.get(alias);
    const canonicalEntry = reg.get(canonical);
    if (!aliasEntry || !canonicalEntry) continue;

    for (const koId of aliasEntry.koIds) {
      if (!canonicalEntry.koIds.includes(koId)) canonicalEntry.koIds.push(koId);
    }
    for (const doc of aliasEntry.docs) canonicalEntry.docs.add(doc);
    if (aliasEntry.earliest < canonicalEntry.earliest) canonicalEntry.earliest = aliasEntry.earliest;
    reg.delete(alias);
  }

  for (const [koId, norms] of rawByKo) {
    const mapped: string[] = [];
    for (const norm of norms) {
      const next = redirects.get(norm) ?? norm;
      if (!mapped.includes(next)) mapped.push(next);
    }
    rawByKo.set(koId, mapped);
  }
}

function conceptDisplays(norms: readonly string[], keys: ReadonlySet<string>, reg: ReadonlyMap<string, ConceptReg>): string[] {
  const displays: string[] = [];
  for (const norm of norms) {
    if (!keys.has(norm)) continue;
    const display = reg.get(norm)?.display;
    if (display) displays.push(display);
  }
  return displays;
}

/**
 * KO[] + extractor + concept KO factory -> concept layer. Pure & deterministic
 * given the injected extractor. Two-tier thresholds: primary (>= minMembers and
 * spanning >= minDocs documents) materialise concept hubs; local (single-doc
 * recurrence >= minLocalMembers) only tag leaves; singletons are dropped.
 */
export async function buildConceptLayer(
  kos: readonly KnowledgeObject[],
  extract: ConceptExtractFn,
  createConceptKo: ConceptKnowledgeObjectFactory,
  opts: ConceptOpts = {},
): Promise<ConceptLayer> {
  const topK = Math.max(0, opts.topK ?? 3);
  const minMembers = Math.max(2, opts.minMembers ?? 2);
  const minDocs = Math.max(2, opts.minDocs ?? 2);
  const minLocalMembers = Math.max(2, opts.minLocalMembers ?? 2);

  const ordered = [...kos].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.ko_id.localeCompare(b.ko_id));
  const koOrder = new Map(ordered.map((ko, index) => [ko.ko_id, index] as const));
  const reg = new Map<string, ConceptReg>();
  const rawByKo = new Map<string, string[]>();

  for (const ko of ordered) {
    if (PLACEHOLDER.has(conceptBody(ko.body_md))) continue;

    const names = (await extract(ko)).map((name) => name.trim()).filter(Boolean).slice(0, topK);
    const koNorms: string[] = [];

    for (const name of names) {
      const key = normConcept(name);
      if (!key) continue;

      if (!koNorms.includes(key)) koNorms.push(key);

      const entry = reg.get(key) ?? { display: name, koIds: [], docs: new Set<string>(), earliest: ko.created_at };
      if (!entry.koIds.includes(ko.ko_id)) entry.koIds.push(ko.ko_id);
      entry.docs.add(ko.source.document_id);
      if (ko.created_at < entry.earliest) entry.earliest = ko.created_at;
      reg.set(key, entry);
    }

    if (koNorms.length) rawByKo.set(ko.ko_id, koNorms);
  }

  if (opts.merge) applyMerge(reg, rawByKo, opts.merge(reg));

  for (const entry of reg.values()) {
    entry.koIds.sort((a, b) => (koOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (koOrder.get(b) ?? Number.MAX_SAFE_INTEGER) || compareText(a, b));
  }

  const primaryKeys = new Set<string>();
  const localKeys = new Set<string>();

  for (const [key, entry] of reg) {
    if (entry.koIds.length >= minMembers && entry.docs.size >= minDocs) primaryKeys.add(key);
    else if (entry.docs.size === 1 && entry.koIds.length >= minLocalMembers) localKeys.add(key);
  }

  const concepts: KnowledgeObject[] = [];
  const membersByConcept = Object.create(null) as Record<string, string[]>;
  const assignmentsByKo = Object.create(null) as Record<string, string[]>;
  const localByKo = Object.create(null) as Record<string, string[]>;

  const orderedPrimaryKeys = [...primaryKeys].sort((a, b) => {
    const left = reg.get(a);
    const right = reg.get(b);
    return compareText(left?.earliest ?? '', right?.earliest ?? '') || compareText(left?.display ?? '', right?.display ?? '') || compareText(a, b);
  });

  for (const key of orderedPrimaryKeys) {
    const entry = reg.get(key);
    if (!entry) continue;

    const stableKey: `concept:${string}` = `concept:${key}`;
    const sourceDocumentIds = [...entry.docs].sort(compareText);

    concepts.push(
      await createConceptKo({
        stableKey,
        normalizedName: key,
        displayName: entry.display,
        documentId: CONCEPT_DOC_ID,
        documentTitle: entry.display,
        bodyMarkdown: entry.display,
        memberKoIds: [...entry.koIds],
        sourceDocumentIds,
        createdAt: entry.earliest,
      }),
    );
    membersByConcept[entry.display] = [...entry.koIds];
  }

  for (const [koId, norms] of rawByKo) {
    const primary = conceptDisplays(norms, primaryKeys, reg);
    const local = conceptDisplays(norms, localKeys, reg);
    if (primary.length) assignmentsByKo[koId] = primary;
    if (local.length) localByKo[koId] = local;
  }

  return { concepts, assignmentsByKo, membersByConcept, localByKo };
}
