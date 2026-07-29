import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptMeetingPostprocessTemplates } from './accept-meeting-postprocess-templates';

describe('acceptMeetingPostprocessTemplates', () => {
  it('renders a clean comparison directory for selected templates', async () => {
    const outputDir = mkdtempSync(resolve(tmpdir(), 'inkloop-template-acceptance-'));
    const result = await acceptMeetingPostprocessTemplates([
      'fixtures/meeting-postprocess/ordinary.json',
      '--templates=meeting_expert,interview_memo',
      '--meeting-date=2026-07-14',
      `--output-dir=${outputDir}`,
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.status === 'passed')).toBe(true);
    expect(readFileSync(resolve(outputDir, 'README.md'), 'utf8')).toContain('五模板后处理验收');
    expect(readFileSync(resolve(outputDir, result.rows[0].file), 'utf8')).not.toContain('脑图');
    expect(readFileSync(resolve(outputDir, result.rows[0].file), 'utf8')).toContain('2026-07-14（具体时间未记录）');
    expect(JSON.parse(readFileSync(resolve(outputDir, 'manifest.json'), 'utf8')).rows).toHaveLength(2);
  });
});
