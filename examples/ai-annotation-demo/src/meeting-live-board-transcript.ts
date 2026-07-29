export type LiveBoardTranscriptTrack = 'mic' | 'remote';

export interface LiveBoardTranscriptUtterance {
  utterance_id: string;
  track: LiveBoardTranscriptTrack;
  start_ms: number;
  end_ms?: number;
  text: string;
  revision: number;
  confidence?: number;
}

const MIN_LIVE_CONFIDENCE = 0.55;
const MIN_SHORT_TEXT_CONFIDENCE = 0.78;
const REPEAT_WINDOW_MS = 90_000;
const COMMON_ASR_HALLUCINATION = /(?:请不吝|点赞|订阅|转发|打赏|明镜与点点栏|字幕(?:由|组|志愿者)|中文字幕|感谢观看|谢谢观看)/u;

function normalizedText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function isDisplayCandidate(utterance: LiveBoardTranscriptUtterance): boolean {
  const text = utterance.text.trim();
  const normalized = normalizedText(text);
  if (!normalized || COMMON_ASR_HALLUCINATION.test(text)) return false;
  if (Number.isFinite(utterance.confidence) && Number(utterance.confidence) < MIN_LIVE_CONFIDENCE) return false;

  // Very short fragments are useful when the recognizer is sure ("明白",
  // "可以"), but low-confidence ones are usually room noise decoded as a
  // character or two. Raw ASR remains persisted; this only gates the live UI.
  if (normalized.length <= 3
    && Number.isFinite(utterance.confidence)
    && Number(utterance.confidence) < MIN_SHORT_TEXT_CONFIDENCE) return false;

  return true;
}

export function selectLiveTranscriptUtterances(
  utterances: LiveBoardTranscriptUtterance[],
  limit = 7,
): LiveBoardTranscriptUtterance[] {
  const selected: LiveBoardTranscriptUtterance[] = [];
  const lastSeen = new Map<string, number>();
  const ordered = [...utterances].sort((left, right) => left.start_ms - right.start_ms);

  for (const utterance of ordered) {
    if (!isDisplayCandidate(utterance)) continue;
    const normalized = normalizedText(utterance.text);
    const repeatKey = `${utterance.track}\u0000${normalized}`;
    const previousStart = lastSeen.get(repeatKey);
    lastSeen.set(repeatKey, utterance.start_ms);
    if (previousStart !== undefined && utterance.start_ms - previousStart <= REPEAT_WINDOW_MS) continue;
    selected.push(utterance);
  }

  return selected.slice(-Math.max(0, limit));
}
