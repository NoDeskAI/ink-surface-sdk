import { describe, expect, it } from 'vitest';
import { zoomUuidPathSegment } from './zoom-uuid';

describe('zoom UUID path encoding', () => {
  it('double-encodes a UUID that starts with slash and contains a double slash', () => {
    expect(zoomUuidPathSegment('/abc//def==')).toBe('%252Fabc%252F%252Fdef%253D%253D');
  });

  it('single-encodes an ordinary UUID', () => {
    expect(zoomUuidPathSegment('abc-def_123')).toBe('abc-def_123');
  });

  it('single-encodes plus and equals characters when no slash rule applies', () => {
    expect(zoomUuidPathSegment('abc+def==')).toBe('abc%2Bdef%3D%3D');
  });
});
