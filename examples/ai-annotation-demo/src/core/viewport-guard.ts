const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_DISTANCE_PX = 28;

interface TapPoint {
  time: number;
  x: number;
  y: number;
}

function editableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]'));
}

function singleFingerTouchEnd(event: TouchEvent): boolean {
  return event.touches.length === 0 && event.changedTouches.length === 1;
}

function nearTap(a: TapPoint, b: TapPoint): boolean {
  return b.time - a.time <= DOUBLE_TAP_MS && Math.hypot(b.x - a.x, b.y - a.y) <= DOUBLE_TAP_DISTANCE_PX;
}

export function installDoubleTapZoomGuard(root: Document = document): () => void {
  let lastTap: TapPoint | null = null;

  const onTouchEnd = (event: TouchEvent): void => {
    if (event.defaultPrevented || !event.cancelable || !singleFingerTouchEnd(event) || editableTarget(event.target)) {
      lastTap = null;
      return;
    }
    const touch = event.changedTouches[0];
    const current = { time: Date.now(), x: touch.clientX, y: touch.clientY };
    if (lastTap && nearTap(lastTap, current)) {
      event.preventDefault();
      lastTap = null;
      return;
    }
    lastTap = current;
  };

  const onDoubleClick = (event: MouseEvent): void => {
    if (!event.cancelable || editableTarget(event.target)) return;
    event.preventDefault();
  };

  root.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
  root.addEventListener('dblclick', onDoubleClick, { capture: true });

  return () => {
    root.removeEventListener('touchend', onTouchEnd, { capture: true });
    root.removeEventListener('dblclick', onDoubleClick, { capture: true });
  };
}
