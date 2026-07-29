import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MEETING_TEMPLATE_IDS } from './templates';

const savedPromptSchema = z.object({
  id: z.string().uuid(),
  template_id: z.enum(MEETING_TEMPLATE_IDS),
  base_version: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(100_000),
  model: z.string().trim().min(1).max(160),
  created_at: z.string().datetime(),
}).strict();

const promptStoreSchema = z.object({
  schema_version: z.literal('inkloop.postprocess-market-prompts.v1'),
  prompts: z.array(savedPromptSchema).max(2_000),
}).strict();

export type SavedMarketPrompt = z.infer<typeof savedPromptSchema>;

export class MeetingPostprocessMarketStore {
  constructor(private readonly path: string) {}

  list(templateId?: string): SavedMarketPrompt[] {
    const prompts = this.read().prompts;
    return prompts
      .filter((item) => !templateId || item.template_id === templateId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  save(input: Omit<SavedMarketPrompt, 'id' | 'created_at'>, now = new Date()): SavedMarketPrompt {
    const item = savedPromptSchema.parse({ ...input, id: randomUUID(), created_at: now.toISOString() });
    const current = this.read();
    current.prompts.push(item);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    return item;
  }

  private read(): z.infer<typeof promptStoreSchema> {
    try {
      return promptStoreSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      return { schema_version: 'inkloop.postprocess-market-prompts.v1', prompts: [] };
    }
  }
}

export function marketPromptStorePath(root: string): string {
  return resolve(root, '.inkloop/postprocess-market/prompt-versions.json');
}
