import { describe, expect, it } from 'vitest';
import { inkToolFromControlKey } from './ink-tool-controls';

describe('shared ink tool controls', () => {
  it('maps classroom and e-paper reader control keys to canonical tools', () => {
    expect(inkToolFromControlKey('pen')).toBe('pen');
    expect(inkToolFromControlKey('hi')).toBe('highlighter');
    expect(inkToolFromControlKey('highlighter')).toBe('highlighter');
    expect(inkToolFromControlKey('er')).toBe('eraser');
    expect(inkToolFromControlKey('eraser')).toBe('eraser');
  });
});
