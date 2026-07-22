import { describe, expect, it, vi } from 'vitest';
import { BOARD_OCR_MAX_IMAGE_BYTES, processBoardOcrPayload } from './board-ocr';

function jpeg(width = 1200, height = 1600, trailingBytes = 0): string {
  const header = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  return Buffer.concat([header, Buffer.alloc(trailingBytes)]).toString('base64');
}

const regions = [
  { mark_id: 'mark_a', bbox: [0.1, 0.2, 0.3, 0.1] },
  { mark_id: 'mark_b', bbox: [0.5, 0.6, 0.2, 0.1] },
];

describe('POST /api/ink/board-ocr', () => {
  it('returns normal flat JSON model output', async () => {
    const infer = vi.fn(async () => '{"mark_a":"项目计划","mark_b":"API v2"}');
    const result = await processBoardOcrPayload({ image: jpeg(), regions }, infer);
    expect(result).toEqual({ texts: { mark_a: '项目计划', mark_b: 'API v2' } });
    expect(infer).toHaveBeenCalledOnce();
  });

  it('strips markdown fences and surrounding model chatter', async () => {
    const result = await processBoardOcrPayload(
      { image: jpeg(), regions },
      async () => '识别结果如下 {"note":"ignore"}\n```json\n{"mark_a":"结论","mark_b":"next step"}\n```\n完成',
    );
    expect(result.texts).toEqual({ mark_a: '结论', mark_b: 'next step' });
  });

  it('omits a missing requested region and ignores unknown keys', async () => {
    const result = await processBoardOcrPayload(
      { image: jpeg(), regions },
      async () => 'prefix {"mark_a":"待办","other":"ignore"} suffix',
    );
    expect(result.texts).toEqual({ mark_a: '待办' });
  });

  it('accepts an explicit empty string but rejects output without any known string key', async () => {
    const explicitEmpty = await processBoardOcrPayload(
      { image: jpeg(), regions },
      async () => '{"mark_a":"","mark_b":42}',
    );
    expect(explicitEmpty.texts).toEqual({ mark_a: '' });
    await expect(processBoardOcrPayload(
      { image: jpeg(), regions },
      async () => '{"other":"ignore","mark_a":42}',
    )).rejects.toMatchObject({ status: 502, message: 'invalid_model_response' });
  });

  it('rejects byte and dimension limits with 413 before inference', async () => {
    const infer = vi.fn(async () => '{}');
    const bytes = processBoardOcrPayload({ image: jpeg(1200, 1600, BOARD_OCR_MAX_IMAGE_BYTES), regions }, infer);
    const dimensions = processBoardOcrPayload({ image: jpeg(2001, 1200), regions }, infer);
    await expect(bytes).rejects.toMatchObject({ status: 413 });
    await expect(dimensions).rejects.toMatchObject({ status: 413 });
    expect(infer).not.toHaveBeenCalled();
  });
});
