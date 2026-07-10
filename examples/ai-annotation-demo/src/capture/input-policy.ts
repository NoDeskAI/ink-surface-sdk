export type NativePointerKind = 'pen' | 'eraser' | 'touch' | null;

export function isLikelyStylusPointer(input: {
  pointerType: string;
  pressure?: number;
  width?: number;
  height?: number;
}): boolean {
  if (input.pointerType === 'pen') return true;
  const pressure = typeof input.pressure === 'number' ? input.pressure : 0;
  const width = typeof input.width === 'number' ? input.width : Number.POSITIVE_INFINITY;
  const height = typeof input.height === 'number' ? input.height : Number.POSITIVE_INFINITY;
  const contact = Math.max(width || Number.POSITIVE_INFINITY, height || Number.POSITIVE_INFINITY);
  return input.pointerType === 'touch' && pressure > 0.02 && pressure < 0.35 && contact <= 12;
}

export function shouldStartBookPointerSwipe(input: {
  nativeKind: NativePointerKind;
  pointerType: string;
}): boolean {
  if (input.nativeKind === 'pen' || input.nativeKind === 'eraser') return false;
  if (input.nativeKind === 'touch') return true;
  return input.pointerType === 'touch';
}

export function shouldStartBookTouchSwipe(nativeKind: NativePointerKind): boolean {
  return nativeKind === null || nativeKind === 'touch';
}

export function shouldPersistNativeStrokeFromDrain(input: {
  activeTool: string;
  nativeIsEraser: boolean;
}): boolean {
  if (input.nativeIsEraser) return false;
  return input.activeTool !== 'eraser';
}
