import { describe, expect, it } from 'vitest';
import { buildOnyxPenAreaPayload, shouldArmOnyxPenArea } from './onyx-pen-area';

describe('ONYX pen area eligibility', () => {
  it('arms a meeting whiteboard even when data-read still says books', () => {
    expect(shouldArmOnyxPenArea({
      writable: true,
      mode: 'meet',
      read: 'books',
      meetingNoteOpen: true,
      tool: 'pen',
      blocked: false,
    })).toBe(true);
  });

  it('keeps a meeting material surface disarmed', () => {
    expect(shouldArmOnyxPenArea({
      writable: true,
      mode: 'meet',
      read: 'books',
      meetingNoteOpen: false,
      tool: 'pen',
      blocked: false,
    })).toBe(false);
  });

  it('keeps the actual reading bookshelf disarmed', () => {
    expect(shouldArmOnyxPenArea({
      writable: true,
      mode: 'read',
      read: 'books',
      tool: 'pen',
      blocked: false,
    })).toBe(false);
  });

  it.each([
    { writable: false, mode: 'meet', read: 'books', meetingNoteOpen: true, tool: 'pen', blocked: false },
    { writable: true, mode: 'meet', read: 'books', meetingNoteOpen: true, tool: 'eraser', blocked: false },
    { writable: true, mode: 'meet', read: 'books', meetingNoteOpen: true, tool: 'aipen', blocked: true },
  ])('disarms for non-writable, non-pen, and blocked states: %o', (input) => {
    expect(shouldArmOnyxPenArea(input)).toBe(false);
  });
});

describe('ONYX pen native region geometry', () => {
  it('reports the floating pen toolbar overlap as a physical-pixel exclude rect', () => {
    expect(buildOnyxPenAreaPayload(
      { left: 0, top: 90, width: 900, height: 1110 },
      [{ left: 20, top: 128, width: 48, height: 238 }],
      2,
    )).toEqual({
      x: 0, y: 180, w: 1800, h: 2220, dpr: 2,
      exclude: [{ x: 40, y: 256, w: 96, h: 476 }],
    });
  });

  it('clips excludes to the writing area and omits non-overlapping chrome', () => {
    expect(buildOnyxPenAreaPayload(
      { left: 10, top: 100, width: 300, height: 400 },
      [
        { left: 0, top: 80, width: 40, height: 50 },
        { left: 500, top: 100, width: 40, height: 40 },
      ],
      1,
    )).toEqual({
      x: 10, y: 100, w: 300, h: 400, dpr: 1,
      exclude: [{ x: 10, y: 100, w: 30, h: 30 }],
    });
  });
});
