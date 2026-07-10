export type FeishuTranscriptSpeakerSource = 'identified' | 'device_diarization';

export interface FeishuTranscriptSpeakerMarker {
  speaker: string;
  startMs: number;
  source: FeishuTranscriptSpeakerSource;
  deviceOwner?: string;
}

const CLOCK = '(\\d{1,2}:\\d{2}(?::\\d{2})?)';
const DEVICE_MARKER = new RegExp(`^@?(.+?)\\s+用\\s+@(.+?)\\s*的设备\\s+${CLOCK}$`, 'u');
const NAMED_MARKER = new RegExp(`^@(.+?)\\s+${CLOCK}$`, 'u');
const ANONYMOUS_SPEAKER = /^(?:说话人|Speaker)\s*\d+$/iu;

function clockToMs(value: string): number {
  const parts = value.split(':').map((part) => Number(part));
  if (parts.length === 2 && parts.every(Number.isFinite)) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3 && parts.every(Number.isFinite)) return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000;
  return 0;
}

export function parseFeishuTranscriptSpeakerMarker(line: string): FeishuTranscriptSpeakerMarker | null {
  const normalized = String(line || '').trim();
  const device = normalized.match(DEVICE_MARKER);
  if (device) {
    const speaker = device[1].replace(/\s+/g, ' ').trim();
    return {
      speaker,
      startMs: clockToMs(device[3]),
      source: ANONYMOUS_SPEAKER.test(speaker) ? 'device_diarization' : 'identified',
      deviceOwner: device[2].trim(),
    };
  }

  const named = normalized.match(NAMED_MARKER);
  if (!named) return null;
  return {
    speaker: named[1].trim(),
    startMs: clockToMs(named[2]),
    source: 'identified',
  };
}
