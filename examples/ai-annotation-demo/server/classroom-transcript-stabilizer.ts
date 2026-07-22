import type { ClassroomRecognitionRevision, ClassroomSnapshot } from 'ink-surface-sdk/runtime-schema';
import type { ClassroomLessonOutput } from './classroom-lesson';

export type TranscriptStabilizationReason = 'context_term' | 'explicit_self_correction' | 'terminal_punctuation';

export interface TranscriptStabilizationResult {
  text: string;
  changed: boolean;
  reasons: TranscriptStabilizationReason[];
}

function signature(value: string): string {
  return (value.match(/[A-Za-z]+|\d+(?:\.\d+)?|[+\-*/=<>^]/g) ?? []).map((item) => item.toLowerCase()).join('|');
}

function boundedTerms(terms: readonly string[]): string[] {
  return [...new Set(terms.map((term) => term.normalize('NFKC').trim()).filter((term) => term.length >= 2 && term.length <= 48))]
    .sort((a, b) => b.length - a.length).slice(0, 128);
}

function oneCharacterAway(source: string, term: string): boolean {
  if (source.length !== term.length || source === term) return false;
  let differences = 0;
  for (let index = 0; index < source.length; index += 1) if (source[index] !== term[index] && ++differences > 1) return false;
  return differences === 1;
}

function repairContextTerm(text: string, term: string): string {
  if (text.includes(term)) return text;
  const termSignature = signature(term);
  for (let start = 0; start + term.length <= text.length; start += 1) {
    const candidate = text.slice(start, start + term.length);
    if (!oneCharacterAway(candidate, term)) continue;
    if (signature(candidate) !== termSignature) continue;
    return `${text.slice(0, start)}${term}${text.slice(start + term.length)}`;
  }
  return text;
}

export function stabilizeClassroomTranscriptText(source: string, contextTerms: readonly string[]): TranscriptStabilizationResult {
  const reasons: TranscriptStabilizationReason[] = [];
  let text = source.normalize('NFC').replace(/\s+/g, ' ').trim();
  const correction = text.match(/^(.{1,160}?)(?:不对|说错了|更正一下)[，,\s]*(?:应该是|是)(.{1,160})$/u);
  if (correction?.[1]?.trim() && correction[2]?.trim()) {
    text = `${correction[1].trim()}——更正为${correction[2].trim()}`;
    reasons.push('explicit_self_correction');
  }
  for (const term of boundedTerms(contextTerms)) {
    const repaired = repairContextTerm(text, term);
    if (repaired !== text) { text = repaired; if (!reasons.includes('context_term')) reasons.push('context_term'); }
  }
  if (text && !/[。！？.!?]$/u.test(text)) { text += /[\u3400-\u9fff]/u.test(text) ? '。' : '.'; reasons.push('terminal_punctuation'); }
  return { text, changed: text !== source, reasons };
}

function latestTrustedRecognitions(revisions: readonly ClassroomRecognitionRevision[]): ClassroomRecognitionRevision[] {
  const latest = new Map<string, ClassroomRecognitionRevision>();
  for (const revision of revisions) {
    const current = latest.get(revision.recognition_id);
    if (!current || revision.revision > current.revision) latest.set(revision.recognition_id, revision);
  }
  return [...latest.values()].filter((item) => item.status === 'confirmed' || item.status === 'corrected');
}

export function classroomTranscriptContextTerms(snapshot: ClassroomSnapshot, lesson?: ClassroomLessonOutput | null): string[] {
  const terms: string[] = [];
  for (const material of snapshot.materials ?? []) terms.push(material.title);
  for (const recognition of latestTrustedRecognitions(snapshot.recognitions ?? [])) terms.push(recognition.text, recognition.latex ?? '');
  for (const candidate of lesson?.candidates ?? []) if (candidate.review_status === 'accepted' || candidate.review_status === 'edited') terms.push(candidate.content, candidate.latex ?? '');
  for (const concept of lesson?.reviewed_lesson_graph?.concepts ?? []) terms.push(concept.name);
  return boundedTerms(terms);
}
