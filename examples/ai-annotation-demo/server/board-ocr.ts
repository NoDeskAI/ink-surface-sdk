import type { IncomingMessage, ServerResponse } from 'node:http';

export const BOARD_OCR_MAX_IMAGE_BYTES = 1_500_000;
export const BOARD_OCR_MAX_LONG_EDGE = 2_000;
const BOARD_OCR_MAX_BODY_BYTES = 2_150_000;
const BOARD_OCR_MAX_REGIONS = 200;

export interface BoardOcrRegion {
  mark_id: string;
  bbox: [number, number, number, number];
}

export interface BoardOcrPayload {
  image: string;
  regions: BoardOcrRegion[];
  lang_hint?: string;
  model?: string;
}

export type BoardOcrInference = (payload: BoardOcrPayload) => Promise<string>;

export class BoardOcrHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof && length >= 7) {
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function decodeJpeg(image: unknown): Buffer {
  if (typeof image !== 'string' || !image.trim()) throw new BoardOcrHttpError(400, 'image_required');
  const trimmed = image.trim();
  if (/^data:/i.test(trimmed) && !/^data:image\/jpeg;base64,/i.test(trimmed)) {
    throw new BoardOcrHttpError(400, 'jpeg_required');
  }
  const raw = trimmed.replace(/^data:image\/jpeg;base64,/i, '').replace(/\s+/g, '');
  if (!raw || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new BoardOcrHttpError(400, 'invalid_base64');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length > BOARD_OCR_MAX_IMAGE_BYTES) throw new BoardOcrHttpError(413, 'image_too_large');
  const dimensions = jpegDimensions(bytes);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) throw new BoardOcrHttpError(400, 'invalid_jpeg');
  if (Math.max(dimensions.width, dimensions.height) > BOARD_OCR_MAX_LONG_EDGE) {
    throw new BoardOcrHttpError(413, 'image_dimensions_too_large');
  }
  return bytes;
}

function normalizedBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const bbox = value.map(Number) as [number, number, number, number];
  if (!bbox.every(Number.isFinite)) return null;
  const [x, y, width, height] = bbox;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) return null;
  return bbox;
}

export function validateBoardOcrPayload(value: unknown): BoardOcrPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoardOcrHttpError(400, 'invalid_payload');
  const input = value as Record<string, unknown>;
  decodeJpeg(input.image);
  if (!Array.isArray(input.regions) || !input.regions.length || input.regions.length > BOARD_OCR_MAX_REGIONS) {
    throw new BoardOcrHttpError(400, 'invalid_regions');
  }
  const seen = new Set<string>();
  const regions = input.regions.map((value): BoardOcrRegion => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoardOcrHttpError(400, 'invalid_region');
    const region = value as Record<string, unknown>;
    const markId = typeof region.mark_id === 'string' ? region.mark_id.trim() : '';
    const bbox = normalizedBbox(region.bbox);
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(markId) || !bbox || seen.has(markId)) throw new BoardOcrHttpError(400, 'invalid_region');
    seen.add(markId);
    return { mark_id: markId, bbox };
  });
  const langHint = typeof input.lang_hint === 'string' ? input.lang_hint.trim().slice(0, 64) : undefined;
  const model = typeof input.model === 'string' ? input.model.trim().slice(0, 120) : undefined;
  return {
    image: String(input.image).replace(/^data:image\/jpeg;base64,/i, '').replace(/\s+/g, ''),
    regions,
    ...(langHint ? { lang_hint: langHint } : {}),
    ...(model ? { model } : {}),
  };
}

function jsonObjectCandidates(raw: string): string[] {
  const out = [raw.trim()];
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) out.push(match[1].trim());
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) out.push(raw.slice(start, index + 1));
    }
  }
  return [...new Set(out.filter(Boolean))];
}

export function parseBoardOcrModelOutput(raw: string, markIds: readonly string[]): Record<string, string> {
  let parsed: Record<string, unknown> | null = null;
  let bestScore = -1;
  for (const candidate of jsonObjectCandidates(String(raw || ''))) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const object = value as Record<string, unknown>;
        const score = markIds.reduce((count, markId) => count + (typeof object[markId] === 'string' ? 1 : 0), 0);
        if (score > bestScore) { parsed = object; bestScore = score; }
      }
    } catch { /* 继续尝试下一个完整 JSON 对象 */ }
  }
  if (!parsed || bestScore <= 0) throw new BoardOcrHttpError(502, 'invalid_model_response');
  return Object.fromEntries(markIds.flatMap((markId) => {
    const value = parsed?.[markId];
    return typeof value === 'string' ? [[markId, value.trim().slice(0, 2_000)]] : [];
  }));
}

export async function processBoardOcrPayload(value: unknown, infer: BoardOcrInference): Promise<{ texts: Record<string, string> }> {
  const payload = validateBoardOcrPayload(value);
  const raw = await infer(payload);
  return { texts: parseBoardOcrModelOutput(raw, payload.regions.map((region) => region.mark_id)) };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BOARD_OCR_MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new BoardOcrHttpError(413, 'request_too_large'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

export async function handleBoardOcrHttp(
  req: IncomingMessage,
  res: ServerResponse,
  infer: BoardOcrInference,
): Promise<void> {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('POST only');
    return;
  }
  try {
    const result = await processBoardOcrPayload(JSON.parse(await readBody(req)), infer);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(result));
  } catch (error) {
    const status = error instanceof BoardOcrHttpError ? error.status : error instanceof SyntaxError ? 400 : 502;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ error: String((error as Error)?.message || error) }));
  }
}
