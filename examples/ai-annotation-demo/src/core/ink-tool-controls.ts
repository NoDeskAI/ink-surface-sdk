export type InkToolControl = 'pen' | 'aipen' | 'highlighter' | 'underline' | 'eraser' | 'hand';

const CONTROL_TOOL_MAP: Record<string, InkToolControl> = {
  pen: 'pen', ai: 'aipen', aipen: 'aipen', hi: 'highlighter', highlighter: 'highlighter',
  ul: 'underline', underline: 'underline', er: 'eraser', eraser: 'eraser', hand: 'hand',
};

export function inkToolFromControlKey(value: string | undefined): InkToolControl | undefined {
  return value ? CONTROL_TOOL_MAP[value] : undefined;
}

export function syncInkToolControls(buttons: readonly HTMLElement[], active: InkToolControl): void {
  for (const button of buttons) {
    const on = inkToolFromControlKey(button.dataset.tool) === active;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }
}
