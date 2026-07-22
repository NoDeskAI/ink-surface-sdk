export type ClassroomGestureIntent =
  | { type: 'write_start' | 'write_move' | 'write_end'; event: PointerEvent }
  | { type: 'write_cancel'; pointer_id: number }
  | { type: 'pan'; dx: number; dy: number; final: boolean }
  | { type: 'zoom'; anchor_x: number; anchor_y: number; factor: number; final: boolean };

export interface GestureControllerOptions {
  allowWriting: boolean;
  emit: (intent: ClassroomGestureIntent) => void;
}

interface ActivePointer { x: number; y: number; type: string }

export function normalizedWheelDelta(event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>, pageHeight = 800): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * pageHeight;
  return event.deltaY;
}

export function pinchDelta(previous: [ActivePointer, ActivePointer], next: [ActivePointer, ActivePointer]): { dx: number; dy: number; factor: number; anchor_x: number; anchor_y: number } {
  const center = (items: [ActivePointer, ActivePointer]): [number, number] => [(items[0].x + items[1].x) / 2, (items[0].y + items[1].y) / 2];
  const distance = (items: [ActivePointer, ActivePointer]): number => Math.hypot(items[1].x - items[0].x, items[1].y - items[0].y);
  const before = center(previous); const after = center(next);
  return { dx: after[0] - before[0], dy: after[1] - before[1], factor: distance(next) / Math.max(1, distance(previous)), anchor_x: after[0], anchor_y: after[1] };
}

export class ClassroomGestureController {
  private readonly pointers = new Map<number, ActivePointer>();
  private space = false;
  private writingPointer?: number;
  private panningPointer?: number;

  constructor(private readonly target: HTMLElement, private readonly options: GestureControllerOptions) {
    target.addEventListener('pointerdown', this.pointerDown);
    target.addEventListener('pointermove', this.pointerMove);
    target.addEventListener('pointerup', this.pointerUp);
    target.addEventListener('pointercancel', this.pointerCancel);
    target.addEventListener('lostpointercapture', this.pointerCancel);
    target.addEventListener('wheel', this.wheel, { passive: false });
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.cancelAll);
  }

  private pointerDown = (event: PointerEvent): void => {
    const rect = this.target.getBoundingClientRect();
    this.pointers.set(event.pointerId, { x: event.clientX - rect.left, y: event.clientY - rect.top, type: event.pointerType });
    try { this.target.setPointerCapture(event.pointerId); } catch { /* synthetic/browser compatibility */ }
    if (event.pointerType === 'touch') return;
    if (event.pointerType === 'mouse' && (this.space || event.button === 1)) { this.panningPointer = event.pointerId; event.preventDefault(); return; }
    if (this.options.allowWriting && (event.pointerType === 'pen' || (event.pointerType === 'mouse' && event.button === 0))) {
      this.writingPointer = event.pointerId; this.options.emit({ type: 'write_start', event }); event.preventDefault();
    }
  };

  private pointerMove = (event: PointerEvent): void => {
    const previous = this.pointers.get(event.pointerId); if (!previous) return;
    const rect = this.target.getBoundingClientRect();
    const next = { x: event.clientX - rect.left, y: event.clientY - rect.top, type: event.pointerType };
    const touchPointers = [...this.pointers.entries()].filter(([, pointer]) => pointer.type === 'touch');
    if (event.pointerType === 'touch' && touchPointers.length === 2 && this.writingPointer === undefined) {
      const before = touchPointers.map(([, pointer]) => pointer) as [ActivePointer, ActivePointer]; this.pointers.set(event.pointerId, next);
      const after = [...this.pointers.values()].filter((pointer) => pointer.type === 'touch') as [ActivePointer, ActivePointer]; const gesture = pinchDelta(before, after);
      this.options.emit({ type: 'pan', dx: gesture.dx, dy: gesture.dy, final: false });
      this.options.emit({ type: 'zoom', anchor_x: gesture.anchor_x, anchor_y: gesture.anchor_y, factor: gesture.factor, final: false }); event.preventDefault(); return;
    }
    this.pointers.set(event.pointerId, next);
    if (this.panningPointer === event.pointerId || (event.pointerType === 'touch' && touchPointers.length === 1 && this.writingPointer === undefined)) {
      this.options.emit({ type: 'pan', dx: next.x - previous.x, dy: next.y - previous.y, final: false }); event.preventDefault(); return;
    }
    if (this.writingPointer === event.pointerId) { this.options.emit({ type: 'write_move', event }); event.preventDefault(); }
  };

  private pointerUp = (event: PointerEvent): void => {
    if (this.writingPointer === event.pointerId) this.options.emit({ type: 'write_end', event });
    if (this.panningPointer === event.pointerId || event.pointerType === 'touch') this.options.emit({ type: 'pan', dx: 0, dy: 0, final: true });
    this.pointers.delete(event.pointerId); if (this.writingPointer === event.pointerId) this.writingPointer = undefined; if (this.panningPointer === event.pointerId) this.panningPointer = undefined;
  };

  private pointerCancel = (event: PointerEvent): void => {
    // Safari/iPadOS can end a valid pen stroke with pointercancel or
    // lostpointercapture instead of pointerup. The host commits sampled ink.
    if (this.writingPointer === event.pointerId) this.options.emit({ type: 'write_cancel', pointer_id: event.pointerId });
    this.pointers.delete(event.pointerId); if (this.writingPointer === event.pointerId) this.writingPointer = undefined; if (this.panningPointer === event.pointerId) this.panningPointer = undefined;
  };

  private wheel = (event: WheelEvent): void => {
    const rect = this.target.getBoundingClientRect(); const delta = normalizedWheelDelta(event, rect.height);
    this.options.emit({ type: 'zoom', anchor_x: event.clientX - rect.left, anchor_y: event.clientY - rect.top, factor: Math.exp(-delta * 0.0015), final: true }); event.preventDefault();
  };

  private keyDown = (event: KeyboardEvent): void => { if (event.code === 'Space' && !this.isEditable(event.target)) this.space = true; };
  private keyUp = (event: KeyboardEvent): void => { if (event.code === 'Space') { this.space = false; if (this.panningPointer !== undefined) this.options.emit({ type: 'pan', dx: 0, dy: 0, final: true }); } };
  private isEditable(target: EventTarget | null): boolean { return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(target.tagName)); }
  private cancelAll = (): void => { if (this.writingPointer !== undefined) this.options.emit({ type: 'write_cancel', pointer_id: this.writingPointer }); this.pointers.clear(); this.writingPointer = undefined; this.panningPointer = undefined; this.space = false; };

  destroy(): void {
    this.cancelAll(); this.target.removeEventListener('pointerdown', this.pointerDown); this.target.removeEventListener('pointermove', this.pointerMove); this.target.removeEventListener('pointerup', this.pointerUp); this.target.removeEventListener('pointercancel', this.pointerCancel); this.target.removeEventListener('lostpointercapture', this.pointerCancel); this.target.removeEventListener('wheel', this.wheel); window.removeEventListener('keydown', this.keyDown); window.removeEventListener('keyup', this.keyUp); window.removeEventListener('blur', this.cancelAll);
  }
}
