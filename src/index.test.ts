import { describe, expect, it } from 'vitest';
import { parseInkLoopVisualModel, renderInkLoopVisualModel } from './index';

describe('root SDK compatibility entry', () => {
  it('re-exports the surface-web renderer API', () => {
    const model = parseInkLoopVisualModel('# Plain markdown');

    expect(model).toBeNull();
    expect(typeof renderInkLoopVisualModel).toBe('function');
  });
});
