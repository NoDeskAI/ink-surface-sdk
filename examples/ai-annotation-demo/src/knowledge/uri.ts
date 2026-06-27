export function buildInkloopDocUri(documentId: string): string {
  return `inkloop://doc/${encodeURIComponent(documentId)}`;
}

export function buildInkloopPageUri(input: {
  documentId: string;
  pageIndex: number;
  anchorObjectId?: string;
}): string {
  const base = `inkloop://doc/${encodeURIComponent(input.documentId)}/page/${input.pageIndex}`;
  if (!input.anchorObjectId) return base;
  return `${base}?anchor=${encodeURIComponent(input.anchorObjectId)}`;
}

export function buildInkloopKoUri(koId: string): string {
  return `inkloop://ko/${encodeURIComponent(koId)}`;
}

export function buildInkloopMarkUri(markId: string): string {
  return `inkloop://mark/${encodeURIComponent(markId)}`;
}
