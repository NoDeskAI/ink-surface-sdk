import { describe, expect, it } from 'vitest';
import { matchLocalFeishuMaterialRoute } from './local-feishu-material-routes';

describe('local Feishu material routes', () => {
  it('matches workspace message downloads', () => {
    expect(matchLocalFeishuMaterialRoute('/api/feishu/workspaces/oc_1/messages/om_1/file/file%2Fkey')).toEqual({
      kind: 'message_file',
      chatId: 'oc_1',
      messageId: 'om_1',
      resourceKey: 'file/key',
    });
  });

  it('matches workspace docx link extraction', () => {
    expect(matchLocalFeishuMaterialRoute('/api/feishu/workspaces/oc_1/docx-links')).toEqual({
      kind: 'workspace_docx_links',
      chatId: 'oc_1',
    });
  });

  it('matches docx PDF exports', () => {
    expect(matchLocalFeishuMaterialRoute('/api/feishu/docx/Docx_123456/pdf')).toEqual({
      kind: 'docx_pdf',
      documentId: 'Docx_123456',
    });
  });
});
