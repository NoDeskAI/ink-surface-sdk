import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { CLASSROOM_SCHEMA_VERSION, type ClassroomMaterial, type ClassroomPageGeometry } from 'ink-surface-sdk/runtime-schema';
import type { ClassroomService } from './classroom-service';
import type { JsonClassroomStore } from './classroom-store';

export const CLASSROOM_MAX_PDF_BYTES = 20 * 1024 * 1024;
export const CLASSROOM_MAX_PDF_PAGES = 200;
const PDF_PARSE_TIMEOUT_MS = 8_000;

export interface ClassroomMaterialInput {
  bytes: Uint8Array;
  title: string;
  idempotencyKey: string;
  source?: 'builtin' | 'teacher_upload';
}

function safeTitle(value: string): string {
  const title = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
  return title || '课堂讲义';
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function inspectPdfPageGeometries(bytes: Uint8Array): Promise<ClassroomPageGeometry[]> {
  if (bytes.byteLength === 0) throw new Error('pdf_empty');
  if (bytes.byteLength > CLASSROOM_MAX_PDF_BYTES) throw new Error('pdf_too_large');
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('pdf_invalid_magic');
  const loading = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pdf = await Promise.race([
      loading.promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('pdf_parse_timeout')), PDF_PARSE_TIMEOUT_MS); }),
    ]);
    try {
      if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1) throw new Error('pdf_zero_pages');
      if (pdf.numPages > CLASSROOM_MAX_PDF_PAGES) throw new Error('pdf_too_many_pages');
      const geometries: ClassroomPageGeometry[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const rotation = ((page.rotate % 360) + 360) % 360 as ClassroomPageGeometry['rotation'];
        const viewport = page.getViewport({ scale: 1, rotation });
        geometries.push({ page_index: pageNumber - 1, width_world: viewport.width, height_world: viewport.height, rotation });
        page.cleanup();
      }
      return geometries;
    } finally {
      await pdf.destroy();
    }
  } catch (error) {
    const name = String((error as { name?: string }).name || '');
    const message = String((error as Error).message || error);
    if (message.startsWith('pdf_')) throw error;
    if (name === 'PasswordException' || /password/i.test(message)) throw new Error('pdf_encrypted');
    throw new Error('pdf_invalid');
  } finally {
    if (timer) clearTimeout(timer);
    try { await loading.destroy(); } catch { /* already destroyed */ }
  }
}

export class ClassroomMaterialService {
  constructor(private readonly store: JsonClassroomStore, private readonly service: ClassroomService) {}

  async publish(classroomId: string, input: ClassroomMaterialInput): Promise<{ material: ClassroomMaterial; inserted: boolean }> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new Error('idempotency_key_invalid');
    const pageGeometries = await inspectPdfPageGeometries(input.bytes);
    const hash = sha256(input.bytes);
    const material: ClassroomMaterial = {
      schema_version: CLASSROOM_SCHEMA_VERSION,
      classroom_id: classroomId,
      material_id: `material_${hash.slice(0, 24)}`,
      title: safeTitle(input.title),
      mime_type: 'application/pdf',
      byte_size: input.bytes.byteLength,
      content_hash: `sha256:${hash}`,
      page_count: pageGeometries.length,
      page_geometries: pageGeometries,
      source: input.source ?? 'teacher_upload',
      published_at: new Date().toISOString(),
    };
    const existing = await this.store.getMaterial(classroomId, material.material_id);
    const result = await this.store.publishMaterial(classroomId, existing ?? material, input.bytes, input.idempotencyKey);
    if (result.inserted) this.service.publishMaterial(classroomId, result.material);
    return result;
  }

  async publishBuiltin(classroomId: string, path = process.env.INKLOOP_CLASSROOM_TEXTBOOK_PATH
    || new URL('../public/demo/education/completing-square-handout.pdf', import.meta.url).pathname): Promise<{ material: ClassroomMaterial; inserted: boolean }> {
    const externalTextbook = Boolean(process.env.INKLOOP_CLASSROOM_TEXTBOOK_PATH);
    return this.publish(classroomId, {
      bytes: new Uint8Array(await readFile(path)),
      title: externalTextbook ? '本地配置教材' : '配方法课堂讲义',
      idempotencyKey: externalTextbook ? 'builtin_local_textbook_v1' : 'builtin_completing_square_handout_v1',
      source: 'builtin',
    });
  }
}
