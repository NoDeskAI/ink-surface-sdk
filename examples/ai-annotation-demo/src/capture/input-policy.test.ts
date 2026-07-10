import { describe, expect, it } from 'vitest';
import { isLikelyStylusPointer, shouldPersistNativeStrokeFromDrain, shouldStartBookPointerSwipe, shouldStartBookTouchSwipe } from './input-policy';

describe('book swipe input policy', () => {
  it('blocks native stylus contacts even when WebView reports touch', () => {
    expect(shouldStartBookPointerSwipe({ nativeKind: 'pen', pointerType: 'touch' })).toBe(false);
    expect(shouldStartBookPointerSwipe({ nativeKind: 'eraser', pointerType: 'touch' })).toBe(false);
    expect(shouldStartBookTouchSwipe('pen')).toBe(false);
    expect(shouldStartBookTouchSwipe('eraser')).toBe(false);
  });

  it('allows confirmed finger contacts to drive book swipes', () => {
    expect(shouldStartBookPointerSwipe({ nativeKind: 'touch', pointerType: 'pen' })).toBe(true);
    expect(shouldStartBookTouchSwipe('touch')).toBe(true);
  });

  it('falls back to browser pointer type when native classification is absent', () => {
    expect(shouldStartBookPointerSwipe({ nativeKind: null, pointerType: 'touch' })).toBe(true);
    expect(shouldStartBookPointerSwipe({ nativeKind: null, pointerType: 'pen' })).toBe(false);
    expect(shouldStartBookPointerSwipe({ nativeKind: null, pointerType: 'mouse' })).toBe(false);
    expect(shouldStartBookTouchSwipe(null)).toBe(true);
  });

  it('does not persist native drain strokes while the eraser tool is active', () => {
    expect(shouldPersistNativeStrokeFromDrain({ activeTool: 'pen', nativeIsEraser: false })).toBe(true);
    expect(shouldPersistNativeStrokeFromDrain({ activeTool: 'eraser', nativeIsEraser: false })).toBe(false);
    expect(shouldPersistNativeStrokeFromDrain({ activeTool: 'pen', nativeIsEraser: true })).toBe(false);
  });

  it('treats compact pressure-bearing touch contacts as stylus fallback for T10 WebView misreports', () => {
    expect(isLikelyStylusPointer({ pointerType: 'touch', pressure: 0.12, width: 3, height: 3 })).toBe(true);
    expect(isLikelyStylusPointer({ pointerType: 'touch', pressure: 0.5, width: 24, height: 24 })).toBe(false);
    expect(isLikelyStylusPointer({ pointerType: 'mouse', pressure: 0.12, width: 3, height: 3 })).toBe(false);
  });
});
