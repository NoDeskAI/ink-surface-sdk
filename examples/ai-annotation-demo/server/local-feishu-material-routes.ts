export type LocalFeishuMaterialRoute =
  | { kind: 'workspace_docx_links'; chatId: string }
  | { kind: 'message_file'; chatId?: string; messageId: string; resourceKey: string }
  | { kind: 'docx_pdf'; documentId: string };

export function matchLocalFeishuMaterialRoute(path: string): LocalFeishuMaterialRoute | null {
  const docxLinks = path.match(/^\/api\/feishu\/workspaces\/([^/]+)\/docx-links$/);
  if (docxLinks) return { kind: 'workspace_docx_links', chatId: decodeURIComponent(docxLinks[1]) };

  const workspaceFile = path.match(/^\/api\/feishu\/workspaces\/([^/]+)\/messages\/([^/]+)\/file\/([^/]+)$/);
  if (workspaceFile) {
    return {
      kind: 'message_file',
      chatId: decodeURIComponent(workspaceFile[1]),
      messageId: decodeURIComponent(workspaceFile[2]),
      resourceKey: decodeURIComponent(workspaceFile[3]),
    };
  }

  const legacyFile = path.match(/^\/api\/feishu\/messages\/([^/]+)\/file\/([^/]+)$/);
  if (legacyFile) {
    return {
      kind: 'message_file',
      messageId: decodeURIComponent(legacyFile[1]),
      resourceKey: decodeURIComponent(legacyFile[2]),
    };
  }

  const docxPdf = path.match(/^\/api\/feishu\/docx\/([^/]+)\/pdf$/);
  if (docxPdf) return { kind: 'docx_pdf', documentId: decodeURIComponent(docxPdf[1]) };
  return null;
}
