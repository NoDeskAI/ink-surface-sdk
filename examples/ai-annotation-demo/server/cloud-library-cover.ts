import { strFromU8, unzipSync } from 'fflate';

const EPUB_COVER_IMAGE_MAX_BYTES = 2_500_000;

interface EpubManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
}

function normalizeZipPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\\/g, '/');
}

function zipDir(path: string): string {
  const normalized = normalizeZipPath(path);
  const idx = normalized.lastIndexOf('/');
  return idx < 0 ? '' : normalized.slice(0, idx);
}

function joinZipPath(base: string, href: string): string {
  const raw = normalizeZipPath(href);
  if (!base || raw.startsWith(base + '/')) return raw;
  const parts: string[] = [];
  for (const part of `${base}/${raw}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function decodeXmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = tag.match(pattern);
  return decodeXmlAttr(match?.[1] ?? match?.[2] ?? '').trim();
}

function mimeTypeForPath(path: string): string {
  if (/\.png$/i.test(path)) return 'image/png';
  if (/\.gif$/i.test(path)) return 'image/gif';
  if (/\.webp$/i.test(path)) return 'image/webp';
  if (/\.svg$/i.test(path)) return 'image/svg+xml';
  return 'image/jpeg';
}

function rootfilePath(containerXml: string): string {
  const tag = containerXml.match(/<[^>]*rootfile\b[^>]*>/i)?.[0] || '';
  return normalizeZipPath(attr(tag, 'full-path'));
}

function legacyCoverId(opfXml: string): string {
  for (const match of opfXml.matchAll(/<[^>]*meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (attr(tag, 'name').toLowerCase() === 'cover') return attr(tag, 'content');
  }
  return '';
}

function manifestItems(opfXml: string, opfPath: string): EpubManifestItem[] {
  const base = zipDir(opfPath);
  const items: EpubManifestItem[] = [];
  for (const match of opfXml.matchAll(/<[^>]*item\b[^>]*>/gi)) {
    const tag = match[0];
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    if (!id || !href) continue;
    items.push({
      id,
      href: joinZipPath(base, href),
      mediaType: attr(tag, 'media-type'),
      properties: attr(tag, 'properties'),
    });
  }
  return items;
}

function isImage(item: EpubManifestItem | undefined): item is EpubManifestItem {
  return !!item && /^image\//i.test(item.mediaType || mimeTypeForPath(item.href));
}

function candidateCoverItems(items: EpubManifestItem[], coverId: string): EpubManifestItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const candidates: EpubManifestItem[] = [];
  const legacy = byId.get(coverId);
  if (isImage(legacy)) candidates.push(legacy);
  candidates.push(...items.filter((item) => isImage(item) && /\bcover-image\b/i.test(item.properties)));
  candidates.push(...items.filter((item) => isImage(item) && /(^|[/_-])cover([._/-]|$)/i.test(`${item.id}/${item.href}`)));
  candidates.push(...items.filter(isImage));
  return candidates;
}

export function extractCloudLibraryCoverImageDataUrl(bytes: Buffer, filename: string, mimeType = ''): string | undefined {
  if (!/\.epub$/i.test(filename) && mimeType !== 'application/epub+zip') return undefined;
  const zip = unzipSync(bytes);
  const readText = (path: string): string | undefined => {
    const content = zip[normalizeZipPath(path)];
    return content ? strFromU8(content) : undefined;
  };
  const containerXml = readText('META-INF/container.xml');
  const opfPath = containerXml ? rootfilePath(containerXml) : Object.keys(zip).find((path) => /\.opf$/i.test(path));
  if (!opfPath) return undefined;
  const opfXml = readText(opfPath);
  if (!opfXml) return undefined;

  const seen = new Set<string>();
  for (const item of candidateCoverItems(manifestItems(opfXml, opfPath), legacyCoverId(opfXml))) {
    if (seen.has(item.href)) continue;
    seen.add(item.href);
    const imageBytes = zip[item.href];
    if (!imageBytes || imageBytes.length > EPUB_COVER_IMAGE_MAX_BYTES) continue;
    const mediaType = item.mediaType || mimeTypeForPath(item.href);
    return `data:${mediaType};base64,${Buffer.from(imageBytes).toString('base64')}`;
  }
  return undefined;
}
