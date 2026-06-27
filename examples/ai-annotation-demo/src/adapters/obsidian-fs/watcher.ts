import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { adapterId } from '../core/ids';
import type { ExternalBinding } from '../core/types';
import type { ObsidianFsTarget } from './config';
import { parseFrontmatter } from '../markdown/frontmatter';
import { fromVaultRelative, toVaultRelative } from './target';
import { sha256Tagged } from '../../knowledge/hash';
import type { Sha256 } from '../../knowledge/knowledge-object';

export type ObsidianFsWatchEventType = 'file_seen' | 'file_modified' | 'file_deleted' | 'file_renamed';

export interface ObsidianFsWatchEvent {
  event_id: string;
  provider: 'obsidian_fs';
  target_id: string;
  binding_id: string;
  subject_id: string;
  event_type: ObsidianFsWatchEventType;
  remote_path: string;
  previous_remote_path?: string;
  observed_at: string;
}

export interface ObsidianFsWatchFileState {
  remote_path: string;
  mtime_ms: number;
  size_bytes: number;
  content_hash?: Sha256;
}

export type ObsidianFsWatchSnapshot = Record<string, ObsidianFsWatchFileState>;

export interface ObsidianFsWatchOutbox {
  append(event: ObsidianFsWatchEvent): Promise<void>;
}

export class JsonlWatchOutbox implements ObsidianFsWatchOutbox {
  constructor(private readonly filePath: string) {}

  async append(event: ObsidianFsWatchEvent): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}

interface RelocationIndex {
  bySubjectId: Map<string, string[]>;
  byContentHash: Map<Sha256, string[]>;
}

export function watchOutboxPath(target: ObsidianFsTarget): string {
  return path.join(target.vault_root, target.base_dir, '.inkloop-watch-outbox.jsonl');
}

async function fileState(target: ObsidianFsTarget, remotePath: string): Promise<ObsidianFsWatchFileState | null> {
  try {
    const absolutePath = fromVaultRelative(target.vault_root, remotePath);
    const info = await stat(absolutePath);
    if (!info.isFile()) return null;
    const content = await readFile(absolutePath, 'utf8').catch(() => '');
    return { remote_path: remotePath, mtime_ms: info.mtimeMs, size_bytes: info.size, content_hash: await sha256Tagged(content) };
  } catch {
    return null;
  }
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listMarkdownFiles(full)));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

async function listMarkdownFilesUnique(dirs: string[]): Promise<string[]> {
  return [...new Set((await Promise.all(dirs.map((dir) => listMarkdownFiles(dir)))).flat())].sort();
}

function indexValue<T>(map: Map<T, string[]>, key: T | undefined, remotePath: string): void {
  if (!key) return;
  const values = map.get(key) ?? [];
  values.push(remotePath);
  map.set(key, values);
}

async function buildRelocationIndex(target: ObsidianFsTarget): Promise<RelocationIndex> {
  const index: RelocationIndex = { bySubjectId: new Map(), byContentHash: new Map() };
  const basePath = path.join(target.vault_root, target.base_dir);
  for (const file of await listMarkdownFilesUnique([basePath, target.sources_dir])) {
    const content = await readFile(file, 'utf8').catch(() => null);
    if (!content) continue;
    const remotePath = toVaultRelative(target.vault_root, file);
    const frontmatter = parseFrontmatter(content)?.frontmatter;
    indexValue(index.bySubjectId, typeof frontmatter?.inkloop_projection_id === 'string' ? frontmatter.inkloop_projection_id : undefined, remotePath);
    indexValue(index.bySubjectId, typeof frontmatter?.inkloop_id === 'string' ? frontmatter.inkloop_id : undefined, remotePath);
    indexValue(index.byContentHash, await sha256Tagged(content), remotePath);
  }
  return index;
}

function findRelocatedPath(index: RelocationIndex, subjectId: string, prior?: ObsidianFsWatchFileState): string | null {
  const subjectMatches = index.bySubjectId.get(subjectId) ?? [];
  if (subjectMatches.length === 1) return subjectMatches[0];
  const hashMatches = prior?.content_hash ? (index.byContentHash.get(prior.content_hash) ?? []) : [];
  return hashMatches.length === 1 ? hashMatches[0] : null;
}

export async function scanObsidianFsChanges(input: {
  target: ObsidianFsTarget;
  bindings: ExternalBinding[];
  previous?: ObsidianFsWatchSnapshot;
  observed_at?: string;
  outbox?: ObsidianFsWatchOutbox;
}): Promise<{ events: ObsidianFsWatchEvent[]; snapshot: ObsidianFsWatchSnapshot }> {
  const observedAt = input.observed_at ?? new Date().toISOString();
  const previous = input.previous ?? {};
  const snapshot: ObsidianFsWatchSnapshot = {};
  const events: ObsidianFsWatchEvent[] = [];
  let relocationIndex: RelocationIndex | null = null;

  for (const binding of input.bindings) {
    const prior = previous[binding.binding_id];
    let remotePath = binding.remote_path;
    let current = await fileState(input.target, remotePath);
    let emittedRelocation = false;
    if (!current) {
      relocationIndex ??= await buildRelocationIndex(input.target);
      const relocated = findRelocatedPath(relocationIndex, binding.ko_id, prior);
      if (relocated && relocated !== remotePath) {
        remotePath = relocated;
        current = await fileState(input.target, remotePath);
        if (current) {
          events.push({
            event_id: adapterId('watch'),
            provider: 'obsidian_fs',
            target_id: input.target.target_id,
            binding_id: binding.binding_id,
            subject_id: binding.ko_id,
            event_type: 'file_renamed',
            remote_path: remotePath,
            previous_remote_path: binding.remote_path,
            observed_at: observedAt,
          });
          emittedRelocation = true;
        }
      }
    }

    if (!current) {
      if (prior) {
        events.push({
          event_id: adapterId('watch'),
          provider: 'obsidian_fs',
          target_id: input.target.target_id,
          binding_id: binding.binding_id,
          subject_id: binding.ko_id,
          event_type: 'file_deleted',
          remote_path: binding.remote_path,
          observed_at: observedAt,
        });
      }
      continue;
    }

    snapshot[binding.binding_id] = current;
    if (!prior) {
      events.push({
        event_id: adapterId('watch'),
        provider: 'obsidian_fs',
        target_id: input.target.target_id,
        binding_id: binding.binding_id,
        subject_id: binding.ko_id,
        event_type: 'file_seen',
        remote_path: remotePath,
        observed_at: observedAt,
      });
      continue;
    }

    if (emittedRelocation) continue;

    if (prior.remote_path !== remotePath || prior.mtime_ms !== current.mtime_ms || prior.size_bytes !== current.size_bytes) {
      events.push({
        event_id: adapterId('watch'),
        provider: 'obsidian_fs',
        target_id: input.target.target_id,
        binding_id: binding.binding_id,
        subject_id: binding.ko_id,
        event_type: prior.remote_path !== remotePath ? 'file_renamed' : 'file_modified',
        remote_path: remotePath,
        previous_remote_path: prior.remote_path !== remotePath ? prior.remote_path : undefined,
        observed_at: observedAt,
      });
    }
  }

  for (const event of events) await input.outbox?.append(event);
  return { events, snapshot };
}
