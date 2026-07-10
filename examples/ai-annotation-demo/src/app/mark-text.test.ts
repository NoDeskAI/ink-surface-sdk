import { describe, expect, it } from 'vitest';
import type { OcrTextBlock } from '../core/contracts';
import { markedTextForPenMarkupBboxFromBlocks } from './mark-text';

function block(id: string, text: string, bbox: [number, number, number, number]): OcrTextBlock {
  return { id, text, bbox, confidence: 1, language: 'zh' };
}

describe('pen mark text anchoring', () => {
  it('anchors a line-like physical pen mark to the nearest text row instead of leaking the previous row', () => {
    const blocks = [
      block('prev', '上一行不应该进入标记抽屉', [0.08, 0.246, 0.84, 0.024]),
      block('target', '这一行才是用户实际标记的句子', [0.08, 0.276, 0.84, 0.024]),
    ];

    expect(markedTextForPenMarkupBboxFromBlocks(blocks, [0.12, 0.286, 0.42, 0.006])).toContain('这一行才是');
    expect(markedTextForPenMarkupBboxFromBlocks(blocks, [0.12, 0.286, 0.42, 0.006])).not.toContain('上一行');
  });

  it('anchors a baseline underline to the text row above it when the stroke center is below the text center', () => {
    const blocks = [
      block('prev', '有关个人效能的智慧，从本杰明·富兰克林到彼得·德鲁克', [0.08, 0.112, 0.84, 0.018]),
      block('target', 'Macintosh和Windows出现后，终于令普通大众体验了小小芯片的威力。', [0.08, 0.132, 0.84, 0.018]),
      block('next', '与此类似，早在几百年前就出现有关个人效能的智慧。', [0.08, 0.162, 0.84, 0.018]),
    ];

    const text = markedTextForPenMarkupBboxFromBlocks(blocks, [0.675, 0.151, 0.252, 0.0055]);

    expect(text).toContain('小小芯片的威力');
    expect(text).not.toContain('本杰明');
    expect(text).not.toContain('与此类似');
  });

  it('keeps broad circle-style pen markup able to collect enclosed multi-line text', () => {
    const blocks = [
      block('line_1', '第一行圈选内容', [0.12, 0.20, 0.54, 0.026]),
      block('line_2', '第二行圈选内容', [0.12, 0.23, 0.54, 0.026]),
    ];

    expect(markedTextForPenMarkupBboxFromBlocks(blocks, [0.10, 0.19, 0.60, 0.08])).toBe('第一行圈选内容第二行圈选内容');
  });
});
