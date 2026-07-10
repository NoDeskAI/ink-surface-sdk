export const MEETING_NOTE_PAGE_ASPECT = 0.805;

export interface MeetingNotePageSize {
  width: number;
  height: number;
}

export function fitMeetingNotePage(
  containerWidth: number,
  containerHeight: number,
  aspect = MEETING_NOTE_PAGE_ASPECT,
): MeetingNotePageSize {
  const cw = Math.max(1, Math.round(containerWidth));
  const ch = Math.max(1, Math.round(containerHeight));
  const pageAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : MEETING_NOTE_PAGE_ASPECT;

  let width = cw;
  let height = Math.round(width / pageAspect);
  if (height > ch) {
    height = ch;
    width = Math.round(height * pageAspect);
  }

  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}
