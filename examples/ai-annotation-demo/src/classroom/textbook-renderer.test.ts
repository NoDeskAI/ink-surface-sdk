import { describe, expect, it } from 'vitest';
import { normalizedBoxStyle, textbookScale } from './textbook-renderer';

describe('textbook renderer geometry', () => {
  it('keeps a normalized focus aligned across viewport sizes', () => {
    expect(normalizedBoxStyle([0.1, 0.2, 0.4, 0.25])).toEqual({ left: '10%', top: '20%', width: '40%', height: '25%' });
  });

  it('uses the shared PDF page-layout scaling contract', () => {
    expect(textbookScale({ width: 600, height: 800 }, { width: 1200, height: 900 }, 'fit-page', 100)).toBeCloseTo(1.125);
    expect(textbookScale({ width: 600, height: 800 }, { width: 900, height: 700 }, 'percent', 140)).toBe(1.4);
  });
});
