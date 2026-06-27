import type { AdapterManifest } from '../core/types';

export const ObsidianFsManifest: AdapterManifest = {
  provider: 'obsidian_fs',
  display_name: 'Obsidian Vault Folder',
  version: '0.1.0',
  direction: 'bidirectional',
  auth: 'local_fs',
  capabilities: {
    create: true,
    update: true,
    append: true,
    delete: false,
    read: true,
    pull_metadata: true,
    deep_link: true,
    attachments: false,
    controlled_sections: true,
    frontmatter: true,
  },
};
