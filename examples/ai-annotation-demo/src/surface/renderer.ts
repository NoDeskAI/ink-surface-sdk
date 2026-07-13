// legacy build：电纸屏 WebView=Chrome 109，modern worker 用了未 polyfill 的 Promise.withResolvers
// （主线程被别的依赖 polyfill 了、但 worker 是独立 realm 没有）→ worker 一调即抛 → 79 页 PDF 只解出 2 页 + 整页空白。
// legacy build 把 core-js 的 Promise.withResolvers 等 polyfill 打进 worker realm，Chrome 109 上可正常解析渲染。
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { strFromU8, unzipSync } from 'fflate';
import type { NormBBox, OcrTextBlock } from '../core/contracts';
import { SCHEMA_VERSION } from '../core/contracts';
import { sha256Hex, pageIdFor } from '../core/ids';
import { setPageRegions, setPageSize } from '../core/transform';
import { blankSurfaceIndex } from '../core/surface-index';
import { trace } from '../core/trace';
import { optionalPdfAdaptationPageCap, readingExperienceForSource, type ReadingExperience } from '../core/reading-experience';
import { LOCAL_REFLOW_ENGINE, reflowLocal } from './reflow';
import { wrapSurfaceIndex } from '../evidence/target';
import { ensureScannedPageLayer } from '../evidence/page-ocr';
import { bus, getActiveContext, settings, state } from '../app/state';
import type { SyntheticSurfaceDocument, SyntheticTextBlockSource } from '../app/surface-context';
import { getReflow, hasDocumentReflow, openDoc, putDocumentReflowCandidate, putReflowCandidate, storePdfBlob, loadPdfBlob, lastReadPage, activeDoc, setActiveDoc } from '../local/store';
import { apiUrl } from '../core/api';
import { authHeaders } from '../core/auth';
import { pdfScaleForBox, pdfSpreadOrientation, type PdfSpreadOrientation } from './page-layout';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// public/ 资产的运行期 URL：基于 Vite BASE_URL 相对解析。
// dev（页面在根）→ /cmaps/；安卓 WebView（页面在 /assets/index.html）→ /assets/cmaps/。绝对 '/cmaps/' 在后者会错。
const publicAssetUrl = (path: string): string =>
  new URL(`${import.meta.env.BASE_URL || './'}${path}`, window.location.href).toString();

// ── PDF 加载防 hang（P0）：转换服务/网络/pdfjs worker 任一不响应都不让上层永久卡住 ──
const PDF_FETCH_TIMEOUT_MS = 45_000;   // 下载/导入 PDF 字节（含 convert-service 转换）
const PDF_DECODE_TIMEOUT_MS = 45_000;  // pdfjs 解码（worker 加载/坏 PDF 可能永不结算）
const PDF_META_TIMEOUT_MS = 8_000;     // 元信息/目录（非关键，超时即退空）
/** 给 promise 加超时：到点 reject + 可选清理（abort/destroy）。底层不一定真停，但上层不再卡。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = window.setTimeout(() => { if (!done) { done = true; try { onTimeout?.(); } catch { /* noop */ } reject(new Error(`${label}超时`)); } }, ms);
    p.then(
      (v) => { if (!done) { done = true; window.clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; window.clearTimeout(timer); reject(e); } },
    );
  });
}
/** 阶段E：只有走 /api/convert/* 才需要设备 session（票据机制在这条路径上生效）——其它目标（如已经是
 *  PDF 的 feishu-svc 直链）不带这个头，维持原样。用解析后的绝对 URL 判断，避免相对/绝对写法误判。 */
function shouldSendConvertAuth(raw: string): boolean {
  try {
    const u = new URL(apiUrl(raw), window.location.href);
    const b = new URL(apiUrl('/api/convert/'), window.location.href);
    const p = b.pathname.replace(/\/+$/, '');
    return u.origin === b.origin && (u.pathname === p || u.pathname.startsWith(p + '/'));
  } catch { return /^\/api\/convert(?:\/|$)/.test(raw); }
}

/** 带超时 + AbortController 的 PDF 字节下载：转换服务挂起时主动 abort，不泄漏连接。 */
async function fetchPdfBytes(url: string, label: string): Promise<ArrayBuffer> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), PDF_FETCH_TIMEOUT_MS);
  try {
    // codex 扫描出的真 bug：调用方传相对路径(/api/feishu-svc/... 或 /api/convert/...)时，安卓静态包(WebView appassets 源)
    // 下裸 fetch 不会走 VITE_API_BASE_URL；apiUrl() 对已是绝对 URL 的入参是空操作，这里包一层不影响其它调用方。
    // 阶段E：/api/convert/* 现在可能要求设备 session（docx 私有资源走票据）——精准只给这条路径带认证头。
    const headers = shouldSendConvertAuth(url) ? authHeaders() : undefined;
    const r = await fetch(apiUrl(url), { signal: ctrl.signal, headers });
    if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
    return await r.arrayBuffer();
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw new Error(`${label}超时`);
    throw e;
  } finally {
    window.clearTimeout(timer);
  }
}

// pdf（当前 PDFDocumentProxy）已迁入 SurfaceContext（方案 B Stage 1）：读写走 getActiveContext().pdf，
// 切回主阅读/已开会议资料免重新 fetch/decode。renderTask 是单 DOM 渲染锁，留模块级（单激活不双渲）。
let renderTask: { cancel(): void; promise: Promise<void> } | null = null;
let spreadRenderTask: { cancel(): void; promise: Promise<void> } | null = null;

/** 取消当前未完成的 PDF 渲染任务（切白板/切实例/载入新文档前调，防旧页像素继续写共享 pageCv 污染下一画面）。 */
export function cancelActiveRender(): void {
  if (renderTask) {
    try { renderTask.cancel(); } catch { /* noop */ }
    renderTask = null;
  }
  if (spreadRenderTask) {
    try { spreadRenderTask.cancel(); } catch { /* noop */ }
    spreadRenderTask = null;
  }
}

let pageCv: HTMLCanvasElement;
let inkCv: HTMLCanvasElement;
let secondaryPageCv: HTMLCanvasElement | null = null;
let stage: HTMLElement;
let stageWrap: HTMLElement;

export function initRenderer(els: {
  pageLayer: HTMLCanvasElement; inkLayer: HTMLCanvasElement; stage: HTMLElement; stageWrap: HTMLElement;
}): void {
  pageCv = els.pageLayer;
  inkCv = els.inkLayer;
  stage = els.stage;
  stageWrap = els.stageWrap;
}

export function hasDocument(): boolean {
  const ctx = getActiveContext();
  return ctx.pdf !== null || ctx.syntheticDoc !== null;
}

// ── 原页图像区域抽取（扫 PDF 操作流找 paintImage* 算子，用累计变换矩阵求图在页面的 bbox）──
type Mat = [number, number, number, number, number, number];
const matMul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const matApply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function overlapFrac(a: NormBBox, b: NormBBox): number {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return (ix * iy) / (Math.min(a[2] * a[3], b[2] * b[3]) || 1);
}

function isEpubFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type === 'application/epub+zip' || file.name.toLowerCase().endsWith('.epub');
}

function isMarkdownFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type === 'text/markdown' || /\.(md|markdown)$/i.test(file.name);
}

function firstByLocalName(root: ParentNode, localName: string): Element | null {
  const all = root instanceof Document ? root.getElementsByTagName('*') : (root as Element).getElementsByTagName('*');
  for (const el of Array.from(all)) if (el.localName === localName || el.nodeName === localName) return el;
  return null;
}

function allByLocalName(root: ParentNode, localName: string): Element[] {
  const all = root instanceof Document ? root.getElementsByTagName('*') : (root as Element).getElementsByTagName('*');
  return Array.from(all).filter((el) => el.localName === localName || el.nodeName === localName);
}

function normalizeZipPath(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/^\/+/, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function joinZipPath(baseDir: string, href: string): string {
  const cleanHref = decodeURIComponent(href.split('#')[0] || '');
  if (!cleanHref) return '';
  return normalizeZipPath(`${baseDir ? `${baseDir}/` : ''}${cleanHref}`);
}

function zipDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

function textOf(el: Element | null): string {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

function normalizeContentText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/[ \t\r\f]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function normalizeInlineText(text: string): string {
  return normalizeContentText(text).replace(/\s+/g, ' ').trim();
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, 'application/xml');
}

function parseHtml(text: string): Document {
  return new DOMParser().parseFromString(text, 'text/html');
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  if (typeof btoa === 'function') return btoa(binary);
  const nodeBuffer = (globalThis as unknown as {
    Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } };
  }).Buffer;
  if (nodeBuffer) return nodeBuffer.from(binary, 'binary').toString('base64');
  throw new Error('base64 encoder unavailable');
}

function epubTitle(opf: Document, fallback: string): string {
  const title =
    textOf(opf.getElementsByTagName('dc:title')[0]) ||
    textOf(firstByLocalName(opf, 'title')) ||
    fallback.replace(/\.epub$/i, '');
  return title || fallback;
}

function splitLongSyntheticBlock(block: SyntheticTextBlockSource, maxChars: number): SyntheticTextBlockSource[] {
  if (block.role !== 'paragraph' || block.text.length <= maxChars) return [block];
  const chunks: SyntheticTextBlockSource[] = [];
  for (let i = 0; i < block.text.length; i += maxChars) {
    const text = block.text.slice(i, i + maxChars).trim();
    if (text) chunks.push({ ...block, text });
  }
  return chunks.length ? chunks : [block];
}

function splitSyntheticPages(blocks: SyntheticTextBlockSource[], maxChars = 1200): SyntheticTextBlockSource[][] {
  const pages: SyntheticTextBlockSource[][] = [];
  let page: SyntheticTextBlockSource[] = [];
  let chars = 0;
  for (const rawBlock of blocks) {
    for (const block of splitLongSyntheticBlock(rawBlock, maxChars)) {
      const nextChars = chars + block.text.length;
      if (page.length && nextChars > maxChars && block.role !== 'title') {
        pages.push(page);
        page = [];
        chars = 0;
      }
      page.push(block);
      chars += block.text.length;
    }
  }
  if (page.length) pages.push(page);
  return pages;
}

const EPUB_HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const EPUB_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'body', 'caption', 'dd', 'div', 'dt', 'figcaption', 'figure', 'footer',
  'header', 'li', 'main', 'p', 'pre', 'section', 'td', 'th', 'tr',
]);
const EPUB_SKIP_TAGS = new Set(['audio', 'canvas', 'head', 'metadata', 'nav', 'noscript', 'script', 'style', 'svg', 'video']);
const EPUB_COVER_IMAGE_MAX_BYTES = 2_500_000;

function tagName(el: Element): string {
  return el.tagName.toLowerCase();
}

function isEpubBlockElement(el: Element): boolean {
  const tag = tagName(el);
  return EPUB_HEADING_TAGS.has(tag) || EPUB_BLOCK_TAGS.has(tag);
}

function hasBlockDescendant(el: Element): boolean {
  for (const child of Array.from(el.children)) {
    const tag = tagName(child);
    if (EPUB_SKIP_TAGS.has(tag)) continue;
    if (isEpubBlockElement(child) || hasBlockDescendant(child)) return true;
  }
  return false;
}

function collectInlineText(node: Node): string {
  const parts: string[] = [];
  const walk = (cur: Node, root: Node): void => {
    if (cur.nodeType === Node.TEXT_NODE) {
      parts.push(cur.textContent || '');
      return;
    }
    if (!(cur instanceof Element)) return;
    const tag = tagName(cur);
    if (EPUB_SKIP_TAGS.has(tag)) return;
    if (tag === 'br') {
      parts.push('\n');
      return;
    }
    if (tag === 'img') return;
    if (cur !== root && isEpubBlockElement(cur)) return;
    for (const child of Array.from(cur.childNodes)) walk(child, root);
  };
  walk(node, node);
  return normalizeContentText(parts.join(' '));
}

function appendSyntheticTextBlock(
  out: SyntheticTextBlockSource[],
  role: SyntheticTextBlockSource['role'],
  rawText: string,
  sourceHref?: string,
): void {
  const text = normalizeContentText(rawText);
  if (!text) return;
  const pieces = role === 'paragraph' ? text.split(/\n+/).map(normalizeInlineText).filter(Boolean) : [normalizeInlineText(text)];
  for (const piece of pieces) out.push({ role, text: piece, sourceHref });
}

function extractEpubTextBlocks(doc: Document, sourceHref: string): SyntheticTextBlockSource[] {
  doc.querySelectorAll(Array.from(EPUB_SKIP_TAGS).join(',')).forEach((el) => el.remove());
  const out: SyntheticTextBlockSource[] = [];
  const visit = (el: Element): void => {
    const tag = tagName(el);
    if (EPUB_SKIP_TAGS.has(tag)) return;
    const block = isEpubBlockElement(el);
    if (block) {
      const role: SyntheticTextBlockSource['role'] = EPUB_HEADING_TAGS.has(tag) ? 'heading' : 'paragraph';
      appendSyntheticTextBlock(out, role, collectInlineText(el), sourceHref);
      for (const child of Array.from(el.children)) {
        if (isEpubBlockElement(child) || hasBlockDescendant(child)) visit(child);
      }
      return;
    }
    for (const child of Array.from(el.children)) visit(child);
  };

  if (doc.body) visit(doc.body);
  if (!out.length && doc.body) appendSyntheticTextBlock(out, 'paragraph', normalizeInlineText(doc.body.textContent || ''), sourceHref);
  return out;
}

type EpubManifestItem = { id: string; href: string; mediaType: string; properties: string };

function isEpubImageItem(item: EpubManifestItem | undefined): item is EpubManifestItem {
  return !!item && /^image\//i.test(item.mediaType);
}

function epubCoverId(opf: Document): string {
  const metas = allByLocalName(opf, 'meta');
  const legacy = metas.find((el) => (el.getAttribute('name') || '').toLowerCase() === 'cover')?.getAttribute('content');
  return (legacy || '').trim();
}

function epubCoverDataUrl(opf: Document, manifest: Map<string, EpubManifestItem>, zip: Record<string, Uint8Array>): string | undefined {
  const candidates: EpubManifestItem[] = [];
  const byLegacyId = manifest.get(epubCoverId(opf));
  if (isEpubImageItem(byLegacyId)) candidates.push(byLegacyId);
  for (const item of manifest.values()) {
    if (isEpubImageItem(item) && /\bcover-image\b/i.test(item.properties)) candidates.push(item);
  }
  for (const item of manifest.values()) {
    if (isEpubImageItem(item) && /(^|[/_-])cover([._/-]|$)/i.test(`${item.id}/${item.href}`)) candidates.push(item);
  }
  for (const item of manifest.values()) {
    if (isEpubImageItem(item)) candidates.push(item);
  }

  const seen = new Set<string>();
  for (const item of candidates) {
    if (seen.has(item.href)) continue;
    seen.add(item.href);
    const bytes = zip[item.href];
    if (!bytes || bytes.length > EPUB_COVER_IMAGE_MAX_BYTES) continue;
    return `data:${item.mediaType || 'image/jpeg'};base64,${base64FromBytes(bytes)}`;
  }
  return undefined;
}

export function extractEpubCoverImageDataUrl(buf: ArrayBuffer): string | undefined {
  const zip = unzipSync(new Uint8Array(buf));
  const readText = (path: string): string => {
    const bytes = zip[normalizeZipPath(path)];
    if (!bytes) throw new Error(`EPUB 缺少文件：${path}`);
    return strFromU8(bytes);
  };

  const container = parseXml(readText('META-INF/container.xml'));
  const rootfile = firstByLocalName(container, 'rootfile');
  const opfPath = normalizeZipPath(rootfile?.getAttribute('full-path') || '');
  if (!opfPath) return undefined;
  const opf = parseXml(readText(opfPath));
  const opfBase = zipDir(opfPath);
  const manifest = new Map<string, EpubManifestItem>();
  for (const item of allByLocalName(opf, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      href: joinZipPath(opfBase, href),
      mediaType: item.getAttribute('media-type') || '',
      properties: item.getAttribute('properties') || '',
    });
  }
  return epubCoverDataUrl(opf, manifest, zip);
}

export async function extractDocumentCoverImageDataUrl(buf: ArrayBuffer, filename: string, mimeType = ''): Promise<string | undefined> {
  if (isEpubFile({ name: filename, type: mimeType })) return extractEpubCoverImageDataUrl(buf);
  if (isMarkdownFile({ name: filename, type: mimeType })) return undefined;
  const loadingTask = pdfjsLib.getDocument({
    data: buf.slice(0),
    cMapUrl: publicAssetUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: publicAssetUrl('standard_fonts/'),
  });
  const pdf = await withTimeout(loadingTask.promise, PDF_DECODE_TIMEOUT_MS, `解析 PDF ${filename}`, () => { void loadingTask.destroy(); });
  try {
    return await pdfCoverImageDataUrl(pdf);
  } finally {
    try { void pdf.destroy(); } catch { /* noop */ }
  }
}

export async function inspectFileForLibraryUpload(file: File): Promise<LoadedDocument> {
  const buf = await file.arrayBuffer();
  const fileHash = await sha256Hex(buf.slice(0));
  const documentId = `doc_${fileHash.slice(0, 12)}`;
  let pageCount = 1;
  let mimeType = file.type || 'application/octet-stream';
  let sourceKind: LoadedDocument['sourceKind'] = 'pdf';
  let coverImageDataUrl: string | undefined;
  let textLayer: LoadedDocumentTextLayer | undefined;

  if (isEpubFile(file)) {
    const parsed = parseEpubDocument(buf, file.name);
    pageCount = Math.max(1, parsed.pages.length);
    mimeType = 'application/epub+zip';
    sourceKind = 'epub';
    coverImageDataUrl = parsed.coverImageDataUrl;
    textLayer = syntheticTextLayerSummary(parsed);
  } else if (isMarkdownFile(file)) {
    const parsed = parseMarkdownDocument(buf, file.name);
    pageCount = Math.max(1, parsed.pages.length);
    mimeType = 'text/markdown';
    sourceKind = 'markdown';
    textLayer = syntheticTextLayerSummary(parsed);
  } else {
    const loadingTask = pdfjsLib.getDocument({
      data: buf.slice(0),
      cMapUrl: publicAssetUrl('cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: publicAssetUrl('standard_fonts/'),
    });
    const pdf = await withTimeout(loadingTask.promise, PDF_DECODE_TIMEOUT_MS, `解析 PDF ${file.name}`, () => { void loadingTask.destroy(); });
    try {
      pageCount = pdf.numPages;
      const firstPage = await pdf.getPage(1);
      coverImageDataUrl = await pdfPageCoverImageDataUrl(firstPage);
      const blocks = await extractTextBlocks(firstPage, firstPage.getViewport({ scale: 1 }));
      textLayer = textLayerSummary('pdfjs', pageCount, 1, blocks.length);
    } catch {
      textLayer = textLayerSummary('pdfjs', pageCount, 0, 0);
    } finally {
      try { void pdf.destroy(); } catch { /* noop */ }
    }
    mimeType = 'application/pdf';
  }

  return {
    documentId,
    fileHash,
    filename: file.name,
    pageCount,
    mimeType,
    sourceKind,
    coverImageDataUrl,
    textLayer,
    readingExperience: readingExperienceForSource(sourceKind),
  };
}

function parseEpubDocument(buf: ArrayBuffer, filename: string): SyntheticSurfaceDocument {
  const zip = unzipSync(new Uint8Array(buf));
  const readText = (path: string): string => {
    const bytes = zip[normalizeZipPath(path)];
    if (!bytes) throw new Error(`EPUB 缺少文件：${path}`);
    return strFromU8(bytes);
  };

  const container = parseXml(readText('META-INF/container.xml'));
  const rootfile = firstByLocalName(container, 'rootfile');
  const opfPath = normalizeZipPath(rootfile?.getAttribute('full-path') || '');
  if (!opfPath) throw new Error('EPUB 缺少 OPF rootfile');

  const opf = parseXml(readText(opfPath));
  const opfBase = zipDir(opfPath);
  const title = epubTitle(opf, filename);
  const manifest = new Map<string, EpubManifestItem>();
  for (const item of allByLocalName(opf, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      href: joinZipPath(opfBase, href),
      mediaType: item.getAttribute('media-type') || '',
      properties: item.getAttribute('properties') || '',
    });
  }

  const coverImageDataUrl = epubCoverDataUrl(opf, manifest, zip);
  const blocks: SyntheticTextBlockSource[] = [{ role: 'title', text: title }];
  const pages: SyntheticTextBlockSource[][] = [];
  let firstSpineItem = true;
  for (const itemref of allByLocalName(opf, 'itemref')) {
    const idref = itemref.getAttribute('idref');
    const item = idref ? manifest.get(idref) : null;
    if (!item || !/x?html/i.test(item.mediaType) || !zip[item.href]) continue;
    const doc = parseHtml(strFromU8(zip[item.href]));
    const pageBlocks: SyntheticTextBlockSource[] = firstSpineItem ? [{ role: 'title', text: title }] : [];
    for (const block of extractEpubTextBlocks(doc, item.href)) {
      blocks.push(block);
      pageBlocks.push(block);
    }
    if (pageBlocks.length > (firstSpineItem ? 1 : 0)) pages.push(...splitSyntheticPages(pageBlocks));
    firstSpineItem = false;
  }

  if (blocks.length <= 1 || !pages.length) throw new Error('EPUB 未提取到可渲染正文');
  return { kind: 'epub', title, coverImageDataUrl, blocks, pages };
}

function stripMarkdownInline(text: string): string {
  return normalizeInlineText(text)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function parseMarkdownDocument(buf: ArrayBuffer, filename: string): SyntheticSurfaceDocument {
  const text = new TextDecoder('utf-8').decode(buf).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const title = stripMarkdownInline(lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, '') || filename.replace(/\.(md|markdown)$/i, '')) || filename;
  const blocks: SyntheticTextBlockSource[] = [{ role: 'title', text: title }];
  let para: string[] = [];
  let code: string[] = [];
  let inCode = false;

  const flushPara = (): void => {
    if (!para.length) return;
    const textBlock = stripMarkdownInline(para.join(' '));
    if (textBlock) blocks.push({ role: 'paragraph', text: textBlock });
    para = [];
  };
  const flushCode = (): void => {
    if (!code.length) return;
    const textBlock = normalizeContentText(code.join('\n'));
    if (textBlock) blocks.push({ role: 'paragraph', text: textBlock });
    code = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (/^```|^~~~/.test(line.trim())) {
      if (inCode) { inCode = false; flushCode(); }
      else { flushPara(); inCode = true; code = []; }
      continue;
    }
    if (inCode) { code.push(line); continue; }
    if (!line.trim()) { flushPara(); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushPara();
      const textBlock = stripMarkdownInline(heading[2]);
      if (textBlock && textBlock !== title) blocks.push({ role: 'heading', text: textBlock });
      continue;
    }
    para.push(line.replace(/^>\s?/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, ''));
  }
  flushPara();
  flushCode();

  if (blocks.length <= 1) throw new Error('Markdown 未提取到可渲染正文');
  return { kind: 'markdown', title, blocks, pages: splitSyntheticPages(blocks) };
}

async function extractImageRegions(page: PDFPageProxy, vp: PageViewport): Promise<NormBBox[]> {
  try {
    const ops = await page.getOperatorList();
    const O = pdfjsLib.OPS;
    const IMG = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject].filter((v) => v !== undefined));
    let ctm: Mat = [1, 0, 0, 1, 0, 0];
    const stack: Mat[] = [];
    const out: NormBBox[] = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === O.save) stack.push(ctm);
      else if (fn === O.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === O.transform) ctm = matMul(ctm, ops.argsArray[i] as Mat);
      else if (IMG.has(fn)) {
        const corners = ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).map(([x, y]) => {
          const [ux, uy] = matApply(ctm, x, y);
          return vp.convertToViewportPoint(ux, uy) as [number, number];
        });
        const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
        const x0 = Math.min(...xs) / vp.width, x1 = Math.max(...xs) / vp.width;
        const y0 = Math.min(...ys) / vp.height, y1 = Math.max(...ys) / vp.height;
        const bb: NormBBox = [x0, y0, x1 - x0, y1 - y0];
        if (bb[2] > 0.06 && bb[3] > 0.04 && bb[2] * bb[3] > 0.012) out.push(bb); // 滤掉图标/分隔线/底纹点
      }
    }
    const kept: NormBBox[] = []; // 去重：高度重叠当作同一张图（mask + 本体常各出现一次）
    for (const b of out) if (!kept.some((k) => overlapFrac(k, b) > 0.6)) kept.push(b);
    return kept;
  } catch {
    return [];
  }
}

/**
 * 把一段 PDF 字节装进阅读态（导入与重开共用）。
 *  · persist 非空 → 导入路径：把 PDF 字节落库（重开免重导）。reopen 路径传 null（库里已有）。
 *  · 阅读位置：openDoc 后从 last_read_page 恢复（新书=0）。
 * 注意 getDocument({data}) 可能 detach buf，故 Blob 拷贝在调用前由 loadFile 先建好。
 */
export interface LoadedDocument {
  documentId: string;
  fileHash: string;
  filename: string;
  pageCount: number;
  mimeType: string;
  sourceKind: 'pdf' | 'epub' | 'markdown';
  coverImageDataUrl?: string;
  textLayer?: LoadedDocumentTextLayer;
  readingExperience: ReadingExperience;
}

export interface LoadedDocumentTextLayer {
  status: 'pending' | 'ready';
  source: 'pdfjs' | 'epub' | 'markdown';
  page_count: number;
  sampled_page_count: number;
  text_block_count: number;
  updated_at: string;
}

function textLayerSummary(
  source: LoadedDocumentTextLayer['source'],
  pageCount: number,
  sampledPageCount: number,
  textBlockCount: number,
): LoadedDocumentTextLayer {
  return {
    status: textBlockCount > 0 ? 'ready' : 'pending',
    source,
    page_count: Math.max(1, pageCount),
    sampled_page_count: Math.max(0, sampledPageCount),
    text_block_count: Math.max(0, textBlockCount),
    updated_at: new Date().toISOString(),
  };
}

async function pdfPageCoverImageDataUrl(page: PDFPageProxy): Promise<string | undefined> {
  const canvas = document.createElement('canvas');
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = 320 / Math.max(1, baseViewport.width);
  const viewport = page.getViewport({ scale });
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return undefined;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const url = canvas.toDataURL('image/jpeg', 0.72);
  canvas.width = 1;
  canvas.height = 1;
  return url;
}

async function pdfCoverImageDataUrl(pdf: { getPage(pageNumber: number): Promise<PDFPageProxy> }): Promise<string | undefined> {
  try {
    return await pdfPageCoverImageDataUrl(await pdf.getPage(1));
  } catch {
    return undefined;
  }
}

function syntheticTextLayerSummary(doc: SyntheticSurfaceDocument): LoadedDocumentTextLayer {
  const pageCount = Math.max(1, doc.pages.length);
  const blockCount = doc.pages.reduce((sum, page) => sum + page.filter((block) => block.text.trim()).length, 0);
  return textLayerSummary(doc.kind === 'epub' ? 'epub' : 'markdown', pageCount, pageCount, blockCount);
}

async function loadIntoState(buf: ArrayBuffer, filename: string, persist: Blob | null, docId?: string): Promise<LoadedDocument | null> {
  // 载入归属的实例（会议资料=meetingCtx、主阅读=readerCtx）：所有 doc 字段写 capturedCtx 而非 state proxy /
  // 重读 getActiveContext()——否则载入期间切实例会把本文档灌进切换后的实例（P0-5）。
  const sctx = getActiveContext();
  const loadGen = ++sctx.loadGeneration; // 本实例最新一次载入；被同实例新载入抢占（连开两份资料）则旧的不再写字段（B4 latest-wins）
  const fresh = () => sctx.loadGeneration === loadGen; // 先把异步结果算到局部、校验仍是最新再写字段，避免旧载入覆盖新载入
  cancelActiveRender(); // 切文档先取消在途渲染，防旧页像素继续写 pageCv（B3）
  sctx.syntheticDoc = null;
  clearSyntheticPaginationCache(); // 切文档：释放上一本 synthetic 的分页缓存（EPUB→PDF 后别常驻大 layout）

  const fileHash = await sha256Hex(buf);
  if (!fresh()) return null; // openDoc 之前的早退都安全：模块 current 尚未被本次触碰
  sctx.fileHash = fileHash;
  sctx.documentId = docId ?? ('doc_' + fileHash.slice(0, 12)); // 默认 hash 派生；docId 显式覆盖（会议资料按稳定 id 归档）
  sctx.fileName = filename;
  sctx.surfaceType = 'article';
  // cMapUrl/standardFontDataUrl：救老中文 PDF（非嵌入 CID 字体 + 预定义 CJK CMap），否则中文渲染/取文出空白。资产在 public/。
  const loadingTask = pdfjsLib.getDocument({
    data: buf,
    cMapUrl: publicAssetUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: publicAssetUrl('standard_fonts/'),
  });
  const pdf = await withTimeout(loadingTask.promise, PDF_DECODE_TIMEOUT_MS, `解析 PDF ${filename}`, () => { void loadingTask.destroy(); });
  if (!fresh()) { try { void pdf.destroy(); } catch { /* noop */ } return null; } // 被抢占：销毁这份没人要的 PDF，免泄漏
  sctx.pdf = pdf; // 迁入归属实例（切回免重新 fetch/decode）
  sctx.pageCount = pdf.numPages;
  sctx.strokesByPage.clear();
  // 文档级元信息：Info 字典 + 大纲目录（真书常有，喂阅读优化/AI 上下文）。
  const docMeta = await withTimeout(pdf.getMetadata(), PDF_META_TIMEOUT_MS, '读取 PDF 元信息').then((m) => (m && m.info ? (m.info as Record<string, unknown>) : null)).catch(() => null);
  const outline = await withTimeout(pdf.getOutline(), PDF_META_TIMEOUT_MS, '读取 PDF 目录').catch(() => null);
  if (!fresh()) return null;
  sctx.docMeta = docMeta;
  sctx.outline = outline;
  const coverImageDataUrl = await pdfCoverImageDataUrl(pdf);
  if (!fresh()) return null;
  // 载入本地已存的语义蒸馏（PDF 优化/记忆/图解缓存）；没有则新建。重开同一文档即恢复。
  await openDoc({
    document_id: sctx.documentId,
    file_hash: sctx.fileHash,
    filename,
    page_count: sctx.pageCount,
    cover_image_data_url: coverImageDataUrl,
  });
  if (fresh()) {
    sctx.storeDoc = activeDoc(); // 把载入的文档挂到归属实例，供切回时 store.current 重指向（P0-4）
    sctx.pageIndex = Math.min(Math.max(lastReadPage(), 0), Math.max(0, sctx.pageCount - 1)); // 重开跳回阅读位置
  }
  if (persist) await storePdfBlob(sctx.documentId, persist); // 导入：PDF 字节落库（重开免重导）
  trace('PDFDocument', {
    document_id: sctx.documentId,
    file_hash: sctx.fileHash,
    filename,
    page_count: sctx.pageCount,
    uploaded_at: new Date().toISOString(),
    source_type: persist ? 'upload' : 'reopen',
    local_original_path: '(browser memory ref)',
    version: SCHEMA_VERSION,
  });
  // openDoc 改了模块 current；总是重指向回真正活跃实例的 doc，维持「current=活跃实例文档」不变式（P0-4）。
  setActiveDoc(getActiveContext().storeDoc);
  if (!fresh() || getActiveContext() !== sctx) return null; // 被抢占 或 已切走：不对当前活跃实例触发本文档的重绘/恢复（P0-5/B4）
  bus.emit('document:loaded');
  await renderPage();
  // 稳定阅读优先：默认不生成 PDF 优化缓存；只有 dev/用户显式打开后才后台处理。
  const reflowCap = localReflowPreprocessCap(sctx.pageCount);
  if (reflowCap > 0) void preprocess(reflowCap);
  return {
    documentId: sctx.documentId,
    fileHash: sctx.fileHash,
    filename,
    pageCount: sctx.pageCount,
    mimeType: 'application/pdf',
    sourceKind: 'pdf',
    coverImageDataUrl,
    textLayer: textLayerSummary('pdfjs', sctx.pageCount, 1, sctx.textBlocks.length),
    readingExperience: readingExperienceForSource('pdf'),
  };
}

async function loadSyntheticIntoState(
  buf: ArrayBuffer,
  filename: string,
  syntheticDoc: SyntheticSurfaceDocument,
  persist: Blob | null,
  docId?: string,
): Promise<LoadedDocument | null> {
  const sctx = getActiveContext();
  const loadGen = ++sctx.loadGeneration;
  const fresh = () => sctx.loadGeneration === loadGen;
  cancelActiveRender();

  const fileHash = await sha256Hex(buf);
  if (!fresh()) return null;
  sctx.pdf = null;
  sctx.syntheticDoc = syntheticDoc;
  sctx.fileHash = fileHash;
  sctx.documentId = docId ?? ('doc_' + fileHash.slice(0, 12));
  sctx.fileName = filename;
  sctx.surfaceType = 'article';
  sctx.pageCount = Math.max(1, syntheticDoc.pages.length);
  sctx.pageIndex = 0;
  sctx.strokesByPage.clear();
  sctx.docMeta = { Title: syntheticDoc.title, Format: syntheticDoc.kind.toUpperCase() };
  sctx.outline = null;

  await openDoc({
    document_id: sctx.documentId,
    file_hash: sctx.fileHash,
    filename,
    page_count: sctx.pageCount,
    cover_image_data_url: syntheticDoc.coverImageDataUrl,
  });
  if (fresh()) {
    sctx.storeDoc = activeDoc();
    sctx.pageIndex = Math.min(Math.max(lastReadPage(), 0), Math.max(0, sctx.pageCount - 1));
  }
  if (persist) await storePdfBlob(sctx.documentId, persist);
  trace(syntheticDoc.kind === 'epub' ? 'EPUBDocument' : 'MarkdownDocument', {
    document_id: sctx.documentId,
    file_hash: sctx.fileHash,
    filename,
    page_count: sctx.pageCount,
    uploaded_at: new Date().toISOString(),
    source_type: persist ? 'upload' : 'reopen',
    local_original_path: '(browser memory ref)',
    version: SCHEMA_VERSION,
  });
  setActiveDoc(getActiveContext().storeDoc);
  if (!fresh() || getActiveContext() !== sctx) return null;
  bus.emit('document:loaded');
  renderSyntheticSurface();
  return {
    documentId: sctx.documentId,
    fileHash: sctx.fileHash,
    filename,
    pageCount: sctx.pageCount,
    mimeType: syntheticDoc.kind === 'epub' ? 'application/epub+zip' : 'text/markdown',
    sourceKind: syntheticDoc.kind === 'epub' ? 'epub' : 'markdown',
    coverImageDataUrl: syntheticDoc.coverImageDataUrl,
    textLayer: syntheticTextLayerSummary(syntheticDoc),
    readingExperience: readingExperienceForSource(syntheticDoc.kind === 'epub' ? 'epub' : 'markdown'),
  };
}

async function loadEpubIntoState(buf: ArrayBuffer, filename: string, persist: Blob | null, docId?: string): Promise<LoadedDocument | null> {
  return await loadSyntheticIntoState(buf, filename, parseEpubDocument(buf, filename), persist, docId);
}

async function loadMarkdownIntoState(buf: ArrayBuffer, filename: string, persist: Blob | null, docId?: string): Promise<LoadedDocument | null> {
  return await loadSyntheticIntoState(buf, filename, parseMarkdownDocument(buf, filename), persist, docId);
}

/** 导入新 PDF（文件选择/拖拽）。 */
export async function loadFile(file: File, docId?: string): Promise<LoadedDocument | null> {
  const buf = await file.arrayBuffer();
  if (isEpubFile(file)) {
    const blob = new Blob([buf.slice(0)], { type: 'application/epub+zip' });
    return await loadEpubIntoState(buf, file.name, blob, docId);
  }
  if (isMarkdownFile(file)) {
    const blob = new Blob([buf.slice(0)], { type: 'text/markdown' });
    return await loadMarkdownIntoState(buf, file.name, blob, docId);
  }
  const blob = new Blob([buf], { type: 'application/pdf' }); // 先拷贝：getDocument 可能 detach buf
  return await loadIntoState(buf, file.name, blob, docId);
}

/** 静默导入到本地 Library，不切换当前阅读面。Wi-Fi 收件箱自动入库走这条。 */
export async function importFileToLibrary(file: File, docId?: string): Promise<LoadedDocument | null> {
  const buf = await file.arrayBuffer();
  const fileHash = await sha256Hex(buf.slice(0));
  const documentId = docId ?? `doc_${fileHash.slice(0, 12)}`;
  let pageCount = 1;
  let mimeType = file.type || 'application/octet-stream';
  let sourceKind: LoadedDocument['sourceKind'] = 'pdf';
  let textLayer: LoadedDocumentTextLayer | undefined;
  let coverImageDataUrl: string | undefined;

  if (isEpubFile(file)) {
    const parsed = parseEpubDocument(buf, file.name);
    pageCount = Math.max(1, parsed.pages.length);
    mimeType = 'application/epub+zip';
    sourceKind = 'epub';
    coverImageDataUrl = parsed.coverImageDataUrl;
    textLayer = syntheticTextLayerSummary(parsed);
  } else if (isMarkdownFile(file)) {
    const parsed = parseMarkdownDocument(buf, file.name);
    pageCount = Math.max(1, parsed.pages.length);
    mimeType = 'text/markdown';
    sourceKind = 'markdown';
    textLayer = syntheticTextLayerSummary(parsed);
  } else {
    const loadingTask = pdfjsLib.getDocument({
      data: buf.slice(0),
      cMapUrl: publicAssetUrl('cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: publicAssetUrl('standard_fonts/'),
    });
    const pdf = await withTimeout(loadingTask.promise, PDF_DECODE_TIMEOUT_MS, `解析 PDF ${file.name}`, () => { void loadingTask.destroy(); });
    pageCount = pdf.numPages;
    try {
      const firstPage = await pdf.getPage(1);
      coverImageDataUrl = await pdfPageCoverImageDataUrl(firstPage);
      const blocks = await extractTextBlocks(firstPage, firstPage.getViewport({ scale: 1 }));
      textLayer = textLayerSummary('pdfjs', pageCount, 1, blocks.length);
    } catch {
      textLayer = textLayerSummary('pdfjs', pageCount, 0, 0);
    }
    try { void pdf.destroy(); } catch { /* noop */ }
    mimeType = 'application/pdf';
  }

  const prevDoc = activeDoc();
  await openDoc({
    document_id: documentId,
    file_hash: fileHash,
    filename: file.name,
    page_count: pageCount,
    cover_image_data_url: coverImageDataUrl,
  });
  setActiveDoc(prevDoc);
  await storePdfBlob(documentId, new Blob([buf.slice(0)], { type: mimeType }));
  if (sourceKind === 'pdf') schedulePdfBufferPreprocess(buf, documentId, pageCount);
  return {
    documentId,
    fileHash,
    filename: file.name,
    pageCount,
    mimeType,
    sourceKind,
    coverImageDataUrl,
    textLayer,
    readingExperience: readingExperienceForSource(sourceKind),
  };
}

/** 从持久库重开一本已存的书（免重新选文件）。无字节返回 false。 */
export async function reopenBook(documentId: string, filename: string): Promise<boolean> {
  const blob = await loadPdfBlob(documentId);
  if (!blob) return false;
  const buf = await blob.arrayBuffer();
  if (isEpubFile({ name: filename, type: blob.type })) {
    await loadEpubIntoState(buf, filename, null, documentId);
    return true;
  }
  if (isMarkdownFile({ name: filename, type: blob.type })) {
    await loadMarkdownIntoState(buf, filename, null, documentId);
    return true;
  }
  await loadIntoState(buf, filename, null, documentId); // 按存档 id 重开（不靠 hash 复算，转换文档也稳）
  return true;
}

/**
 * 打开一个「PDF 字节 URL」进阅读器（会议资料经 convert-service 转成的 PDF 走这条）。
 * documentId 显式稳定（按资料派生）→ 这份 PDF 落库 + 标注归它、重开免重转。已存库则直接重开。
 */
export async function openPdfFromUrl(documentId: string, filename: string, pdfUrl: string): Promise<void> {
  if (await reopenBook(documentId, filename)) return; // 之前转过 → 库里有，直接重开（免重转）
  const buf = await fetchPdfBytes(pdfUrl, '下载会议资料');
  const blob = new Blob([buf.slice(0)], { type: 'application/pdf' }); // 拷贝：getDocument 可能 detach
  await loadIntoState(buf, filename, blob, documentId);
}

/**
 * 后台导入一份 PDF（建 PersistedDoc + 落字节）但**不打开阅读器/不切视图**——群文件自动抓取用。
 * 资料据此进 listBooks / 会议 material_doc_ids 列表；点开时走 reopenBook 才真渲染。已存库直接 'cached'。
 * openDoc 会改模块 current（P0-4），故导入后恢复，避免静默串写到当前阅读态。
 */
export async function importPdfFromUrl(documentId: string, filename: string, pdfUrl: string): Promise<'cached' | 'imported'> {
  if (await loadPdfBlob(documentId)) return 'cached'; // 去重：稳定 docId 已导入
  const buf = await fetchPdfBytes(pdfUrl, '导入资料');
  const fileHash = await sha256Hex(buf.slice(0));
  const loadingTask = pdfjsLib.getDocument({
    data: buf.slice(0),
    cMapUrl: publicAssetUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: publicAssetUrl('standard_fonts/'),
  });
  const pdf = await withTimeout(loadingTask.promise, PDF_DECODE_TIMEOUT_MS, `解析 PDF ${filename}`, () => { void loadingTask.destroy(); });
  const pageCount = pdf.numPages;
  try { void pdf.destroy(); } catch { /* noop */ }
  const prevDoc = activeDoc(); // openDoc 改 current → 导入后还原回原活跃文档
  await openDoc({ document_id: documentId, file_hash: fileHash, filename, page_count: pageCount });
  setActiveDoc(prevDoc);
  await storePdfBlob(documentId, new Blob([buf.slice(0)], { type: 'application/pdf' }));
  return 'imported';
}

/**
 * 空白手写 surface —— 会议「进入会议」的那张白纸。
 * app 直接渲染表面 + 原生 emit 一份 SurfaceIndex，墨迹/标注/账本/重绘整条链路全复用 PDF 路径那套。
 * 表面是一整张空白（一个覆盖全页的 blank_region，在哪写都命中 self_content）。documentId 稳定 →
 * marks 账本归它、document:loaded 触发 restoreFromLedger 自动重绘已存的笔，重开免重导、跨 reload 不丢。
 *
 * ⚠️架构决议(2026-06-24)：会议的阅读应是「单独阅读实例」。当前阅读器是深度单例（全局 state + 绑死
 * #stage/#ink DOM + 单例 ink），故现采用 **方案 A**：仍用这一套单引擎，由调用方在进/出会议时存档·恢复
 * context（主阅读的书/态）来达到「独立实例」的体验。**方案 B**=把阅读器重构成可实例化的「可标注 surface
 * 组件」（底座层，阅读+每会议各持独立实例）记为后面做，别在阅读上板前动引擎结构。
 */
export function renderBlankSurface(documentId: string, title = '空白页', opts: { ruledLines?: boolean; width?: number; height?: number } = {}): void {
  cancelActiveRender(); // 先取消在途 PDF 渲染：否则旧页像素会继续写进下面要画白纸的同一 pageCv（B3）
  hideSecondaryPageCanvas();
  getActiveContext().pdf = null; // 脱离上一份 PDF（防 zoom/翻页误渲旧页）
  getActiveContext().syntheticDoc = null;
  clearSyntheticPaginationCache(); // 白板：同上，释放上一本 synthetic 的分页缓存
  getActiveContext().storeDoc = null; setActiveDoc(null); // 白板无持久化文档：store.current 置空，页缓存/阅读位置写操作变 no-op（P0-4）
  state.fileHash = documentId;
  state.documentId = documentId;
  state.fileName = title;
  state.surfaceType = 'whiteboard';
  state.pageCount = 1;
  state.pageIndex = 0;
  state.strokesByPage.clear();
  state.docMeta = null;
  state.outline = null;

  const dpr = window.devicePixelRatio || 1;
  const pm = pageMetrics();
  const W = opts.width ?? pm.fit;                 // 移动版日记传可写区实宽（满铺到边）；否则按页面 fit
  const H = opts.height ?? Math.round(W * 1.32); // 移动版传可写区实高（填满）；否则一张竖向「纸」
  for (const cv of [pageCv, inkCv]) {
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
  }
  stage.style.width = W + 'px';
  stage.style.height = H + 'px';
  stage.style.setProperty('--page-w', W + 'px');
  setPageSize(W, H);

  const ctx = pageCv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  if (opts.ruledLines !== false) { // 极淡稿纸线（纯装饰，不进 SurfaceIndex）；移动版日记把线格交给可开关的 CSS 叠层、故传 false
    ctx.strokeStyle = 'rgba(0,0,0,0.05)'; ctx.lineWidth = 1;
    for (let y = 36; y < H; y += 30) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
  }

  const pageId = pageIdFor(documentId, 0); // 全 id 哈希，与 PDF 页一致、免会议白板 id 碰撞（B5）
  state.pageId = pageId;
  setPageRegions([{ pageId, pageIndex: 0, x: 0, y: 0, w: W, h: H }]);
  state.pageRecord = { page_id: pageId, document_id: documentId, page_index: 0, width: W, height: H, unit: 'pt', rotation: 0, render_dpi: 96, version: SCHEMA_VERSION };
  state.overlays = [];
  state.textBlocks = [];
  state.imageRegions = [];
  state.surfaceIndex = blankSurfaceIndex(pageId);

  bus.emit('document:loaded'); // → restoreFromLedger() 自动重绘本白板已存的笔
  bus.emit('page:rendered');
  bus.emit('surface:indexed', state.surfaceIndex);
}

/**
 * 空白文档内翻到某页（日记多页）：换 pageId/surfaceIndex、按现画布尺寸重画白底，**不清其它页内存笔迹**。
 * 翻页后调用方应调 redrawInk() 把该页笔迹画回 #ink-layer。同步执行、无 await，无账本竞态。
 */
export function renderBlankPage(pageIndex: number, opts: { ruledLines?: boolean } = {}): void {
  if (!state.documentId) return;
  cancelActiveRender(); // 取消在途 PDF 渲染（防旧像素写进白底）
  state.pageIndex = pageIndex;
  const pageId = pageIdFor(state.documentId, pageIndex);
  state.pageId = pageId;
  const dpr = window.devicePixelRatio || 1;
  const W = pageCv.width / dpr, H = pageCv.height / dpr; // 复用当前画布尺寸（满铺写区）
  setPageRegions([{ pageId, pageIndex, x: 0, y: 0, w: W, h: H }]);
  if (state.pageRecord) state.pageRecord = { ...state.pageRecord, page_id: pageId, page_index: pageIndex };
  state.overlays = [];
  state.surfaceIndex = blankSurfaceIndex(pageId);
  const ctx = pageCv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  if (opts.ruledLines !== false) {
    ctx.strokeStyle = 'rgba(0,0,0,0.05)'; ctx.lineWidth = 1;
    for (let y = 36; y < H; y += 30) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
  }
  bus.emit('page:rendered');
  bus.emit('surface:indexed', state.surfaceIndex);
}

/**
 * 白板同一页重设尺寸（旋转/容器 resize）：不切文档、不清 strokesByPage，只重建白纸画布与页坐标区域。
 * 笔迹是页归一化坐标，随后 page:rendered 会按新尺寸重绘，避免横竖屏切换后旧横屏画布被居中裁切。
 */
export function resizeBlankSurface(width: number, height: number, opts: { ruledLines?: boolean } = {}): boolean {
  if (!state.documentId || !state.pageId || state.surfaceType !== 'whiteboard') return false;
  const W = Math.max(1, Math.round(width));
  const H = Math.max(1, Math.round(height));
  if (!W || !H) return false;
  const dpr = window.devicePixelRatio || 1;
  if (
    Math.abs((pageCv.width / dpr) - W) < 1
    && Math.abs((pageCv.height / dpr) - H) < 1
    && Math.abs((inkCv.width / dpr) - W) < 1
    && Math.abs((inkCv.height / dpr) - H) < 1
  ) return false;
  cancelActiveRender();
  for (const cv of [pageCv, inkCv]) {
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
  }
  stage.style.width = W + 'px';
  stage.style.height = H + 'px';
  stage.style.setProperty('--page-w', W + 'px');
  setPageSize(W, H);
  setPageRegions([{ pageId: state.pageId, pageIndex: state.pageIndex, x: 0, y: 0, w: W, h: H }]);
  if (state.pageRecord) state.pageRecord = { ...state.pageRecord, width: W, height: H, page_id: state.pageId, page_index: state.pageIndex };
  state.surfaceIndex = blankSurfaceIndex(state.pageId);

  const ctx = pageCv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  if (opts.ruledLines !== false) {
    ctx.strokeStyle = 'rgba(0,0,0,0.05)';
    ctx.lineWidth = 1;
    for (let y = 36; y < H; y += 30) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
  }
  bus.emit('page:rendered');
  bus.emit('surface:indexed', state.surfaceIndex);
  return true;
}

/** 抽取一页的文本块（归一化 bbox，zoom/rotation 无关）。渲染与 PDF 优化缓存共用。 */
async function extractTextBlocks(page: PDFPageProxy, vp: PageViewport): Promise<OcrTextBlock[]> {
  try {
    const tc = await page.getTextContent();
    return tc.items
      .filter((it): it is TextItem => 'str' in it && typeof it.str === 'string' && it.str.trim().length > 0)
      .map((it, i) => {
        const [, b, , d, e, f] = it.transform;
        const fontH = Math.hypot(b, d) || Math.abs(d) || 10;
        const [vx1, vy1] = vp.convertToViewportPoint(e, f) as [number, number];
        const [vx2, vy2] = vp.convertToViewportPoint(e + it.width, f + fontH) as [number, number];
        const x0 = Math.min(vx1, vx2) / vp.width;
        const x1 = Math.max(vx1, vx2) / vp.width;
        const y0 = Math.min(vy1, vy2) / vp.height;
        const y1 = Math.max(vy1, vy2) / vp.height;
        return { id: 'tl_' + i, text: it.str, bbox: [x0, y0, x1 - x0, y1 - y0] as NormBBox, confidence: 1, language: 'auto' };
      });
  } catch {
    return [];
  }
}

/** 取任意页的文本块（只读文本层、不渲染画布）——供按需阅读优化/锚定校验使用，墨水屏友好。 */
export async function extractPageBlocks(pageIndex: number): Promise<OcrTextBlock[]> {
  const pdf = getActiveContext().pdf;
  if (!pdf || pageIndex < 0 || pageIndex >= pdf.numPages) return [];
  try {
    const page = await pdf.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: 1 });
    return await extractTextBlocks(page, vp);
  } catch {
    return [];
  }
}

const preprocessingDocs = new Set<string>();

function localReflowPreprocessCap(pageCount: number): number {
  return optionalPdfAdaptationPageCap(pageCount, {
    enabled: settings.preprocess.reflowEnabled,
    pages: settings.preprocess.reflowPages,
  });
}

async function preprocessPdfInstance(
  pdf: { numPages: number; getPage(pageNumber: number): Promise<PDFPageProxy> },
  documentId: string,
  reflowCap: number,
  hasReflow: (pageIndex: number) => boolean | Promise<boolean>,
  writeReflow: (pageIndex: number, sourceBlocks: OcrTextBlock[], blocks: ReturnType<typeof reflowLocal>) => unknown,
): Promise<void> {
  if (!documentId || preprocessingDocs.has(documentId)) return;
  const cap = Math.min(pdf.numPages, Math.max(0, reflowCap));
  if (cap <= 0) return;
  preprocessingDocs.add(documentId);
  try {
    for (let i = 0; i < cap; i++) {
      try {
        if (await hasReflow(i)) {
          bus.emit('preprocess:progress', i + 1, cap, documentId);
          continue;
        }
        const page = await pdf.getPage(i + 1);
        const vp = page.getViewport({ scale: 1 });
        const blocks = await extractTextBlocks(page, vp);
        if (blocks.length) {
          const rb = reflowLocal(blocks);
          if (rb.length || blocks.length) await writeReflow(i, blocks, rb);
        }
      } catch { /* 跳过该页 */ }
      bus.emit('preprocess:progress', i + 1, cap, documentId);
    }
  } finally {
    preprocessingDocs.delete(documentId);
    bus.emit('preprocess:done', documentId);
  }
}

/**
 * 可选 PDF 阅读优化流水线（后台、顺序、可中断）：只在用户/dev 明确开启时，
 * 对封顶若干页生成 local 规则版面缓存。默认不跑，避免导入即消耗 CPU 并改变阅读预期。
 * 只取文本层、不渲染画布，省性能（墨水屏友好）；已缓存的页跳过。
 */
export async function preprocess(reflowCap: number): Promise<void> {
  const pdf = getActiveContext().pdf;
  const docId = state.documentId;
  if (!pdf || !docId) return;
  await preprocessPdfInstance(
    pdf,
    docId,
    reflowCap,
    (pageIndex) => state.documentId === docId && !!getReflow(pageIndex, LOCAL_REFLOW_ENGINE),
    (pageIndex, sourceBlocks, blocks) => {
      if (state.documentId === docId) putReflowCandidate(pageIndex, LOCAL_REFLOW_ENGINE, sourceBlocks, blocks);
    },
  );
}

export function preprocessCapForCurrentSettings(pageCount: number): number {
  return localReflowPreprocessCap(pageCount);
}

export function schedulePdfBufferPreprocess(buf: ArrayBuffer, documentId: string, pageCount: number, reflowCap = localReflowPreprocessCap(pageCount)): void {
  if (!documentId || reflowCap <= 0) return;
  const copy = buf.slice(0);
  void preprocessPdfBufferForDocument(copy, documentId, pageCount, reflowCap);
}

export async function preprocessPdfBufferForDocument(buf: ArrayBuffer, documentId: string, pageCount: number, reflowCap = localReflowPreprocessCap(pageCount)): Promise<void> {
  if (!documentId || reflowCap <= 0) return;
  const loadingTask = pdfjsLib.getDocument({
    data: buf.slice(0),
    cMapUrl: publicAssetUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: publicAssetUrl('standard_fonts/'),
  });
  try {
    const pdf = await withTimeout(loadingTask.promise, PDF_DECODE_TIMEOUT_MS, '后台生成 PDF 优化缓存', () => { void loadingTask.destroy(); });
    await preprocessPdfInstance(
      pdf,
      documentId,
      Math.min(pageCount || pdf.numPages, reflowCap),
      (pageIndex) => hasDocumentReflow(documentId, pageIndex, LOCAL_REFLOW_ENGINE),
      (pageIndex, sourceBlocks, blocks) => putDocumentReflowCandidate(documentId, pageIndex, LOCAL_REFLOW_ENGINE, sourceBlocks, blocks),
    );
  } finally {
    try { void loadingTask.destroy(); } catch { /* noop */ }
  }
}

/**
 * 页面渲染预算。横屏=页宽自适应，右侧 AI 边注从页面右缘向外溢出；紧凑屏(电纸屏竖向 / 手机 / 窄窗口，≤900px)=
 * 铺满可用宽、下限降到 300，让正文页填满竖向面板（消除 480 桌面下限造成的横向溢出）。
 */
function pageMetrics(): { fit: number } {
  // 紧凑屏=满铺。移动版/电纸屏壳（body.eink-shell）恒走紧凑屏：设备 WebView 视口可能 >640（如 684），
  // 不靠 media query 否则被当桌面渲成「窄页+300 留白」溢出视口。
  const einkShell = document.body.classList.contains('eink-shell');
  const compact = window.matchMedia('(max-width: 900px)').matches || einkShell;
  if (compact) {
    const avail = stageWrap.clientWidth - (einkShell ? 24 : 32); // 电纸屏横屏不再按手机窄页截断，保留少量安全边距。
    const maxFit = einkShell ? 1120 : 900;
    return { fit: Math.min(maxFit, Math.max(300, avail)) };
  }
  const avail = stageWrap.clientWidth - 56;
  return { fit: Math.min(1040, Math.max(480, avail)) };
}

function visibleStageHeight(): number {
  const css = window.getComputedStyle(stageWrap);
  const paddingY = (Number.parseFloat(css.paddingTop) || 0) + (Number.parseFloat(css.paddingBottom) || 0);
  const visible = Math.floor(stageWrap.clientHeight - paddingY);
  return Number.isFinite(visible) && visible > 0 ? visible : 720;
}

const SPREAD_GAP = 22;

function spreadEnabled(): boolean {
  return settings.viewMode === 'page' && settings.pageLayout === 'spread';
}

function spreadOrientation(): PdfSpreadOrientation {
  return pdfSpreadOrientation(availableStageBox());
}

function availableStageBox(): { width: number; height: number } {
  const css = window.getComputedStyle(stageWrap);
  const paddingX = (Number.parseFloat(css.paddingLeft) || 0) + (Number.parseFloat(css.paddingRight) || 0);
  const paddingY = (Number.parseFloat(css.paddingTop) || 0) + (Number.parseFloat(css.paddingBottom) || 0);
  const fallbackWidth = pageMetrics().fit;
  const width = Math.max(300, Math.floor(stageWrap.clientWidth - paddingX));
  const height = Math.max(300, Math.floor(stageWrap.clientHeight - paddingY));
  return {
    width: Number.isFinite(width) && width > 0 ? width : fallbackWidth,
    height: Number.isFinite(height) && height > 0 ? height : visibleStageHeight(),
  };
}

function pdfScale(vp1: PageViewport, opts: { spread: boolean; orientation: 'horizontal' | 'vertical' }): number {
  const box = availableStageBox();
  return pdfScaleForBox({
    page: { width: vp1.width, height: vp1.height },
    viewport: box,
    spread: opts.spread,
    orientation: opts.orientation,
    zoomMode: settings.zoomMode,
    zoomPercent: settings.zoomPercent,
    gap: SPREAD_GAP,
  });
}

function effectiveSpreadSecondPage(): number | null {
  if (!spreadEnabled()) return null;
  const next = state.pageIndex + 1;
  return next < state.pageCount ? next : null;
}

function ensureSecondaryPageCanvas(): HTMLCanvasElement {
  if (!secondaryPageCv) {
    secondaryPageCv = document.createElement('canvas');
    secondaryPageCv.id = 'page-layer-secondary';
    stage.insertBefore(secondaryPageCv, inkCv);
  }
  return secondaryPageCv;
}

function hideSecondaryPageCanvas(): void {
  if (spreadRenderTask) {
    try { spreadRenderTask.cancel(); } catch { /* noop */ }
    spreadRenderTask = null;
  }
  if (!secondaryPageCv) return;
  secondaryPageCv.hidden = true;
  secondaryPageCv.width = 1;
  secondaryPageCv.height = 1;
  secondaryPageCv.style.width = '1px';
  secondaryPageCv.style.height = '1px';
}

async function renderSecondaryPdfPage(pageIndex: number, scale: number, offset: { x: number; y: number }): Promise<{ width: number; height: number } | null> {
  const pdf = getActiveContext().pdf;
  if (!pdf || pageIndex < 0 || pageIndex >= pdf.numPages) return null;
  const canvas = ensureSecondaryPageCanvas();
  const page = await pdf.getPage(pageIndex + 1);
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale });
  canvas.hidden = false;
  canvas.width = vp.width * dpr;
  canvas.height = vp.height * dpr;
  canvas.style.width = vp.width + 'px';
  canvas.style.height = vp.height + 'px';
  canvas.style.transform = `translate(${offset.x}px, ${offset.y}px)`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vp.width, vp.height);
  if (spreadRenderTask) {
    try { spreadRenderTask.cancel(); } catch { /* noop */ }
    spreadRenderTask = null;
  }
  const task = page.render({ canvasContext: ctx, viewport: vp, intent: 'print' });
  spreadRenderTask = task;
  try {
    await task.promise;
  } catch (e) {
    if ((e as { name?: string })?.name !== 'RenderingCancelledException') throw e;
    return null;
  } finally {
    if (spreadRenderTask === task) spreadRenderTask = null;
  }
  return { width: vp.width, height: vp.height };
}

type SyntheticLine = {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  font: string;
  fill: string;
  source: SyntheticTextBlockSource;
};
type SyntheticPageLayout = { lines: SyntheticLine[]; height: number };
type SyntheticSlot = { pageIndex: number; x: number; y: number; w: number; h: number; layout: SyntheticPageLayout };

function syntheticStyle(role: SyntheticTextBlockSource['role']): {
  font: string; lineHeight: number; fill: string; before: number; after: number;
} {
  if (role === 'title') return { font: '700 30px ui-serif, Georgia, serif', lineHeight: 40, fill: '#1f211f', before: 0, after: 24 };
  if (role === 'heading') return { font: '700 22px ui-serif, Georgia, serif', lineHeight: 32, fill: '#222', before: 20, after: 10 };
  return { font: '400 17px ui-serif, Georgia, serif', lineHeight: 29, fill: '#25231f', before: 0, after: 14 };
}

function wrapCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const chars = [...text];
  const lines: string[] = [];
  let line = '';
  for (const ch of chars) {
    const next = line + ch;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line.trimEnd());
      line = ch.trimStart();
    } else {
      line = next;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.length ? lines : [''];
}

function syntheticMargins(width: number): { x: number; top: number; bottom: number } {
  return {
    x: width < 620 ? 34 : 58,
    top: width < 620 ? 34 : 48,
    bottom: width < 620 ? 42 : 56,
  };
}

function flattenSyntheticSourceBlocks(doc: SyntheticSurfaceDocument): SyntheticTextBlockSource[] {
  return doc.blocks.length ? doc.blocks : doc.pages.flat();
}

function paginateSyntheticBlocks(doc: SyntheticSurfaceDocument, width: number, pageHeight: number): SyntheticPageLayout[] {
  const scratch = document.createElement('canvas').getContext('2d')!;
  const margin = syntheticMargins(width);
  const maxTextWidth = Math.max(260, width - margin.x * 2);
  const minPageHeight = Math.max(420, Math.floor(pageHeight));
  const bottomLimit = Math.max(margin.top + 80, minPageHeight - margin.bottom);
  const pages: SyntheticPageLayout[] = [];
  let current: SyntheticPageLayout = { lines: [], height: minPageHeight };
  let y = margin.top;

  const pushPage = (): void => {
    current.height = minPageHeight;
    pages.push(current);
    current = { lines: [], height: minPageHeight };
    y = margin.top;
  };

  const ensureSpace = (needed: number): void => {
    if (current.lines.length && y + needed > bottomLimit) pushPage();
  };

  flattenSyntheticSourceBlocks(doc).forEach((source, index) => {
    const style = syntheticStyle(source.role);
    scratch.font = style.font;
    const before = index === 0 || !current.lines.length ? 0 : style.before;
    ensureSpace(before + style.lineHeight);
    y += before;
    const lines = wrapCanvasText(scratch, source.text, maxTextWidth);
    lines.forEach((line, lineIndex) => {
      ensureSpace(style.lineHeight);
      const w = Math.min(maxTextWidth, Math.ceil(scratch.measureText(line).width));
      current.lines.push({ text: line, x: margin.x, y, w, h: style.lineHeight, font: style.font, fill: style.fill, source });
      y += style.lineHeight;
      if (lineIndex === lines.length - 1) y += style.after;
    });
  });

  if (current.lines.length || !pages.length) pushPage();
  return pages;
}

// synthetic(EPUB/Markdown) 分页缓存：paginateSyntheticBlocks 只依赖 (doc, width, height)——
// 字体写死不随 zoom 变。renderSyntheticSurface 是翻页/切视图热路径，早先每次翻页都全量重排整本
// （大 EPUB 1336 页 → 每翻一页几万次 measureText 折行 = 秒级卡顿·真机实测根因）。同书同视口下
// 分页结果不变，缓存后翻页 O(整本)→O(1)；换书(doc 引用变)/改视口(width|height 变)自动失效重算。
let syntheticPaginationCache: {
  doc: SyntheticSurfaceDocument;
  width: number;
  height: number;
  paged: SyntheticPageLayout[];
} | null = null;

function getPaginatedSyntheticPages(doc: SyntheticSurfaceDocument, width: number, height: number): SyntheticPageLayout[] {
  const c = syntheticPaginationCache;
  if (c && c.doc === doc && c.width === width && c.height === height) return c.paged;
  const paged = paginateSyntheticBlocks(doc, width, height);
  syntheticPaginationCache = { doc, width, height, paged };
  return paged;
}

/** 清 synthetic 分页缓存。离开 synthetic 渲染（切 PDF / 白板 / 销毁文档）时调用：换新 synthetic 文档时
 *  getPaginatedSyntheticPages 靠 doc 引用变本会自然重算，但 EPUB→PDF 后没有新 synthetic 文档来替换，
 *  缓存会继续强引用上一整本 EPUB 的全部页 layout（大对象常驻内存）——这里提前释放。 */
function clearSyntheticPaginationCache(): void {
  syntheticPaginationCache = null;
}

function syntheticSpreadOrientation(): PdfSpreadOrientation {
  return pdfSpreadOrientation(availableStageBox());
}

function syntheticPageSlotSize(): { width: number; height: number; orientation: PdfSpreadOrientation; spread: boolean } {
  const box = availableStageBox();
  const spread = spreadEnabled();
  const orientation = syntheticSpreadOrientation();
  const gap = spread ? SPREAD_GAP : 0;
  const width = spread && orientation === 'horizontal'
    ? Math.floor((box.width - gap) / 2)
    : box.width;
  const height = spread && orientation === 'vertical'
    ? Math.floor((box.height - gap) / 2)
    : box.height;
  return {
    width: Math.max(320, Math.min(860, width)),
    height: Math.max(420, height),
    orientation,
    spread,
  };
}

function visibleSyntheticPageIndices(pageIndex: number, pageCount: number, spread: boolean): number[] {
  const first = Math.min(Math.max(0, pageIndex), Math.max(0, pageCount - 1));
  if (!spread || first + 1 >= pageCount) return [first];
  return [first, first + 1];
}

function drawSyntheticPage(
  ctx: CanvasRenderingContext2D,
  layout: SyntheticPageLayout,
  slot: { x: number; y: number; w: number; h: number },
): void {
  ctx.save();
  ctx.fillStyle = '#fffdf8';
  ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
  ctx.beginPath();
  ctx.rect(slot.x, slot.y, slot.w, slot.h);
  ctx.clip();
  for (const line of layout.lines) {
    ctx.font = line.font;
    ctx.fillStyle = line.fill;
    ctx.textBaseline = 'top';
    ctx.fillText(line.text, slot.x + line.x, slot.y + line.y);
  }
  ctx.restore();
}

export function renderSyntheticSurface(): void {
  const sctx = getActiveContext();
  const doc = sctx.syntheticDoc;
  if (!doc || !state.documentId) return;
  cancelActiveRender();
  hideSecondaryPageCanvas();
  const slotSize = syntheticPageSlotSize();
  const paged = getPaginatedSyntheticPages(doc, slotSize.width, slotSize.height);
  state.pageCount = Math.max(1, paged.length);
  state.pageIndex = Math.min(Math.max(0, state.pageIndex), state.pageCount - 1);
  if (slotSize.spread && state.pageIndex % 2 === 1) state.pageIndex -= 1;

  const dpr = window.devicePixelRatio || 1;
  const pageIndices = visibleSyntheticPageIndices(state.pageIndex, state.pageCount, slotSize.spread);
  const spread = pageIndices.length > 1;
  const W = spread && slotSize.orientation === 'horizontal'
    ? slotSize.width * 2 + SPREAD_GAP
    : slotSize.width;
  const H = spread && slotSize.orientation === 'vertical'
    ? slotSize.height * 2 + SPREAD_GAP
    : slotSize.height;
  setPageSize(W, H);

  for (const cv of [pageCv, inkCv]) {
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
  }
  stage.style.width = W + 'px';
  stage.style.height = H + 'px';
  stage.style.setProperty('--page-w', W + 'px');

  const ctx = pageCv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#f8f6ef';
  ctx.fillRect(0, 0, W, H);
  const slots: SyntheticSlot[] = pageIndices.map((pageIndex, visibleIndex) => {
    const x = spread && slotSize.orientation === 'horizontal' && visibleIndex === 1 ? slotSize.width + SPREAD_GAP : 0;
    const y = spread && slotSize.orientation === 'vertical' && visibleIndex === 1 ? slotSize.height + SPREAD_GAP : 0;
    const layout = paged[pageIndex] ?? { lines: [], height: slotSize.height };
    drawSyntheticPage(ctx, layout, { x, y, w: slotSize.width, h: slotSize.height });
    return { pageIndex, x, y, w: slotSize.width, h: slotSize.height, layout };
  });

  const pageId = pageIdFor(state.documentId, state.pageIndex);
  state.pageId = pageId;
  setPageRegions(slots.map((slot) => ({
    pageId: pageIdFor(state.documentId!, slot.pageIndex),
    pageIndex: slot.pageIndex,
    x: slot.x,
    y: slot.y,
    w: slot.w,
    h: slot.h,
  })));
  state.pageRecord = {
    page_id: pageId,
    document_id: state.documentId,
    page_index: state.pageIndex,
    width: W,
    height: H,
    unit: 'pt',
    rotation: 0,
    render_dpi: Math.round(96 * state.zoom),
    version: SCHEMA_VERSION,
  };
  state.textBlocks = slots.flatMap((slot) => slot.layout.lines.map((line, j) => ({
    id: `epub_${slot.pageIndex}_${j}`,
    text: line.text,
    bbox: [
      (slot.x + line.x) / W,
      (slot.y + line.y) / H,
      Math.min(1, line.w / W),
      Math.min(1, line.h / H),
    ] as NormBBox,
    confidence: 1,
    language: 'auto',
  })));
  state.imageRegions = [];
  state.surfaceIndex = wrapSurfaceIndex(pageId, state.pageIndex, state.textBlocks, state.imageRegions);
  trace('SyntheticPage', state.pageRecord as unknown as Record<string, unknown>);
  bus.emit('surface:indexed', state.surfaceIndex);
  bus.emit('page:rendered');
}

export async function renderPage(): Promise<void> {
  const sctx = getActiveContext();
  const pdf = sctx.pdf;
  if (!pdf || !state.documentId) { renderSyntheticSurface(); return; }
  const gen = ++sctx.renderGeneration; // 本次渲染代号（P0-5 竞态守卫）
  // await 后校验：未被同实例的新渲染抢占、且仍是激活实例——否则丢弃迟到结果不写 state
  const alive = () => sctx.renderGeneration === gen && getActiveContext() === sctx;
  const page = await pdf.getPage(state.pageIndex + 1);
  if (!alive()) return;
  const dpr = window.devicePixelRatio || 1;
  const vp1 = page.getViewport({ scale: 1 });
  const secondPageIndex = effectiveSpreadSecondPage();
  const spread = secondPageIndex !== null;
  const orientation = spreadOrientation();
  const scale = pdfScale(vp1, { spread, orientation });
  state.zoom = scale;
  const vp = page.getViewport({ scale });
  setPageSize(vp.width, vp.height);
  const stageW = spread && orientation === 'horizontal' ? vp.width * 2 + SPREAD_GAP : vp.width;
  const stageH = spread && orientation === 'vertical' ? vp.height * 2 + SPREAD_GAP : vp.height;

  pageCv.width = vp.width * dpr;
  pageCv.height = vp.height * dpr;
  pageCv.style.width = vp.width + 'px';
  pageCv.style.height = vp.height + 'px';
  inkCv.width = stageW * dpr;
  inkCv.height = stageH * dpr;
  inkCv.style.width = stageW + 'px';
  inkCv.style.height = stageH + 'px';
  stage.style.width = stageW + 'px';
  stage.style.height = stageH + 'px';
  stage.style.setProperty('--page-w', vp.width + 'px');
  if (!spread) hideSecondaryPageCanvas();

  // 同一 canvas 不允许并发 render（快速连点缩放/翻页）：先取消未完成任务
  cancelActiveRender();
  const ctx = pageCv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // intent:'print' 走 setTimeout 而非 requestAnimationFrame —— 页面处于后台
  // （沙箱预览/设备 WebView 退后台）时 rAF 被冻结会导致渲染 promise 永不结算
  const task = page.render({ canvasContext: ctx, viewport: vp, intent: 'print' });
  renderTask = task;
  try {
    await task.promise;
  } catch (e) {
    if ((e as { name?: string })?.name === 'RenderingCancelledException') return; // 被更新的渲染取代
    throw e;
  } finally {
    if (renderTask === task) renderTask = null; // 仅当仍是自己时才清，避免取消后已被后继任务覆盖的 handle 被误清成 null
  }
  if (!alive()) return; // 画布渲染期间切走/被抢占：不再写 state（防把本页数据写进切换后的实例）

  // text layer：数字版 PDF 的真实文本 + 精确位置（归一化，zoom/rotation 无关）
  const textBlocks = await extractTextBlocks(page, vp);
  if (!alive()) return;
  state.textBlocks = textBlocks;

  // 原页图像区域（文本阅读/优化视图中保留，不丢图）
  const imageRegions = await extractImageRegions(page, vp);
  if (!alive()) return;
  state.imageRegions = imageRegions;

  state.pageId = pageIdFor(state.documentId, state.pageIndex); // 全 id 哈希，免会议资料截断碰撞（B5）
  setPageRegions([
    { pageId: state.pageId, pageIndex: state.pageIndex, x: 0, y: 0, w: vp.width, h: vp.height },
    ...(spread && secondPageIndex !== null
      ? [{
          pageId: pageIdFor(state.documentId, secondPageIndex),
          pageIndex: secondPageIndex,
          x: orientation === 'horizontal' ? vp.width + SPREAD_GAP : 0,
          y: orientation === 'vertical' ? vp.height + SPREAD_GAP : 0,
          w: vp.width,
          h: vp.height,
        }]
      : []),
  ]);
  state.pageRecord = {
    page_id: state.pageId,
    document_id: state.documentId,
    page_index: state.pageIndex,
    width: vp1.width,
    height: vp1.height,
    unit: 'pt',
    rotation: page.rotate,
    render_dpi: Math.round(96 * scale),
    version: SCHEMA_VERSION,
  };
  trace('PDFPage', state.pageRecord as unknown as Record<string, unknown>);

  // 徐智强 step①：把本页结构（文本层 + 图像区）包成显式 SurfaceIndex（复用 reflowLocal 分 title/text_block）。
  state.surfaceIndex = wrapSurfaceIndex(state.pageId!, state.pageIndex, state.textBlocks, state.imageRegions);
  bus.emit('surface:indexed', state.surfaceIndex);

  // 图片版/扫描页（无文字层、只有图）→ 后台建 OCR 文本层：Phase 2 位置文本层（带 bbox·主路），
  // 失败退 Phase 1 纯文本上下文。让 AI 在图片版 PDF 上不再"看不见字"。
  void ensureScannedPageLayer(state.pageId);

  // 急算开关只允许规则 PDF 优化缓存。V1 不允许 AI/VLM 改写原文。
  if (settings.reflowEager) {
    const ekey = LOCAL_REFLOW_ENGINE;
    if (state.textBlocks.length > 1 && !getReflow(state.pageIndex, ekey)) {
      const pi = state.pageIndex, blocks = state.textBlocks;
      void Promise.resolve(reflowLocal(blocks)).then((r) => { if ((r.length || blocks.length) && !getReflow(pi, ekey)) putReflowCandidate(pi, ekey, blocks, r); }).catch(() => { /* 急算失败不影响阅读 */ });
    }
  }

  if (spread && secondPageIndex !== null) {
    const offset = orientation === 'horizontal'
      ? { x: vp.width + SPREAD_GAP, y: 0 }
      : { x: 0, y: vp.height + SPREAD_GAP };
    void renderSecondaryPdfPage(secondPageIndex, scale, offset).then((size) => {
      if (!size || !alive()) return;
      const w = orientation === 'horizontal' ? vp.width + SPREAD_GAP + size.width : Math.max(vp.width, size.width);
      const h = orientation === 'vertical' ? vp.height + SPREAD_GAP + size.height : Math.max(vp.height, size.height);
      stage.style.width = w + 'px';
      stage.style.height = h + 'px';
      setPageRegions([
        { pageId: state.pageId!, pageIndex: state.pageIndex, x: 0, y: 0, w: vp.width, h: vp.height },
        {
          pageId: pageIdFor(state.documentId!, secondPageIndex),
          pageIndex: secondPageIndex,
          x: orientation === 'horizontal' ? vp.width + SPREAD_GAP : 0,
          y: orientation === 'vertical' ? vp.height + SPREAD_GAP : 0,
          w: size.width,
          h: size.height,
        },
      ]);
    }).catch(() => hideSecondaryPageCanvas());
  }

  bus.emit('page:rendered');
}

function releaseOriginalPageCanvas(): void {
  cancelActiveRender();
  hideSecondaryPageCanvas();
  setPageRegions([]);
  for (const cv of [pageCv, inkCv]) {
    cv.width = 1;
    cv.height = 1;
    cv.style.width = '1px';
    cv.style.height = '1px';
  }
  stage.style.width = '1px';
  stage.style.height = '1px';
  stage.style.setProperty('--page-w', '1px');
}

export async function renderPageTextLayerOnly(): Promise<void> {
  const sctx = getActiveContext();
  const pdf = sctx.pdf;
  if (!pdf || !state.documentId) { renderSyntheticSurface(); return; }
  const gen = ++sctx.renderGeneration;
  const alive = () => sctx.renderGeneration === gen && getActiveContext() === sctx;
  releaseOriginalPageCanvas();
  const page = await pdf.getPage(state.pageIndex + 1);
  if (!alive()) return;
  const vp1 = page.getViewport({ scale: 1 });
  setPageSize(vp1.width, vp1.height);

  const textBlocks = await extractTextBlocks(page, vp1);
  if (!alive()) return;
  state.textBlocks = textBlocks;

  const imageRegions = await extractImageRegions(page, vp1);
  if (!alive()) return;
  state.imageRegions = imageRegions;

  state.pageId = pageIdFor(state.documentId, state.pageIndex);
  state.pageRecord = {
    page_id: state.pageId,
    document_id: state.documentId,
    page_index: state.pageIndex,
    width: vp1.width,
    height: vp1.height,
    unit: 'pt',
    rotation: page.rotate,
    render_dpi: 96,
    version: SCHEMA_VERSION,
  };
  trace('PDFPageTextLayer', state.pageRecord as unknown as Record<string, unknown>);
  state.surfaceIndex = wrapSurfaceIndex(state.pageId!, state.pageIndex, state.textBlocks, state.imageRegions);
  bus.emit('surface:indexed', state.surfaceIndex);

  if (settings.reflowEager) {
    const ekey = LOCAL_REFLOW_ENGINE;
    if (state.textBlocks.length > 1 && !getReflow(state.pageIndex, ekey)) {
      const pi = state.pageIndex, blocks = state.textBlocks;
      void Promise.resolve(reflowLocal(blocks)).then((r) => { if ((r.length || blocks.length) && !getReflow(pi, ekey)) putReflowCandidate(pi, ekey, blocks, r); }).catch(() => { /* eager reflow is best-effort */ });
    }
  }

  bus.emit('page:rendered');
}

export function gotoPage(delta: number): void {
  const ctx = getActiveContext();
  if (!ctx.pdf && !ctx.syntheticDoc) return;
  const stride = spreadEnabled() ? 2 : 1;
  const signed = Math.sign(delta || 0);
  const steps = Math.max(1, Math.abs(Math.trunc(delta || 0)));
  const next = state.pageIndex + signed * steps * stride;
  if (next < 0 || next >= state.pageCount) return;
  state.pageIndex = next;
  if (ctx.pdf) void renderPage();
  else renderSyntheticSurface();
}

export function gotoPageTextLayerOnly(delta: number): void {
  const ctx = getActiveContext();
  if (!ctx.pdf && !ctx.syntheticDoc) return;
  const stride = spreadEnabled() ? 2 : 1;
  const signed = Math.sign(delta || 0);
  const steps = Math.max(1, Math.abs(Math.trunc(delta || 0)));
  const next = state.pageIndex + signed * steps * stride;
  if (next < 0 || next >= state.pageCount) return;
  state.pageIndex = next;
  if (ctx.pdf) void renderPageTextLayerOnly();
  else renderSyntheticSurface();
}

export function setZoom(z: number): void {
  const next = Math.min(3, Math.max(0.25, z));
  settings.zoomMode = 'percent';
  settings.zoomPercent = Math.round(next * 100);
  state.zoom = next;
  if (getActiveContext().pdf) void renderPage();
  else if (getActiveContext().syntheticDoc) renderSyntheticSurface();
}
