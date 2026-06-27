import type { KnowledgeStatus } from '../../knowledge/knowledge-object';
import type { ExternalBinding, PullMetadataResult } from '../core/types';
import { parseFrontmatter } from '../markdown/frontmatter';
import type { ObsidianFsTarget } from './config';
import { readTextIfExists } from './fs-writer';
import { findNotesByInkloopId } from './scanner';
import { fromVaultRelative } from './target';

const statusSet = new Set<KnowledgeStatus>(['inbox', 'accepted', 'edited', 'dismissed', 'export_ready', 'exported', 'archived']);

export async function pullObsidianMetadata(input: {
  target: ObsidianFsTarget;
  bindings: ExternalBinding[];
}): Promise<PullMetadataResult> {
  const updates: PullMetadataResult['updates'] = [];
  const warnings: PullMetadataResult['warnings'] = [];

  for (const binding of input.bindings) {
    let remotePath = binding.remote_path;
    let markdown = await readTextIfExists(fromVaultRelative(input.target.vault_root, remotePath));

    if (!markdown) {
      const matches = await findNotesByInkloopId(input.target, binding.ko_id);
      if (matches.length === 1) {
        remotePath = matches[0].remotePath;
        markdown = await readTextIfExists(matches[0].absolutePath);
      }
    }

    if (!markdown) {
      warnings.push({ code: 'REMOTE_FILE_MISSING', message: `Remote file missing for ${binding.ko_id}` });
      continue;
    }

    const parsed = parseFrontmatter(markdown);
    if (!parsed) {
      warnings.push({ code: 'FRONTMATTER_PARSE_FAILED', message: `Missing frontmatter for ${binding.ko_id}` });
      continue;
    }

    const status = parsed.frontmatter.inkloop_status;
    const tags = parsed.frontmatter.tags;
    const completed = parsed.frontmatter.completed;
    updates.push({
      ko_id: binding.ko_id,
      remote_path: remotePath,
      metadata: {
        status: typeof status === 'string' && statusSet.has(status as KnowledgeStatus) ? (status as KnowledgeStatus) : undefined,
        tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
        completed: typeof completed === 'boolean' ? completed : undefined,
      },
    });
  }

  return { updates, warnings };
}
