import { describe, expect, it } from 'vitest';
import { ObsidianFsManifest } from '../obsidian-fs/manifest';
import { checkExternalEditPullCapability } from './document-sync';

describe('adapter contract hardening', () => {
  it('requires bidirectional readable adapters for external edit pull', () => {
    expect(checkExternalEditPullCapability(ObsidianFsManifest)).toEqual({ ok: true });
    expect(
      checkExternalEditPullCapability({
        direction: 'push',
        capabilities: { ...ObsidianFsManifest.capabilities, read: true },
      }),
    ).toMatchObject({
      ok: false,
      code: 'ADAPTER_PULL_UNSUPPORTED',
    });
  });
});
