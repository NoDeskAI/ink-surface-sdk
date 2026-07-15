import { describe, expect, it } from 'vitest';
import { shouldArmOnyxPenArea } from './onyx-pen-area';

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
