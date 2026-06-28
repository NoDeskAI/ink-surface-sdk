import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateRuntimeSyncEvent } from '../../../packages/runtime-schema/src/index';

interface FixtureLine {
  case: string;
  request: {
    schema_version?: string;
    events?: unknown[];
  };
  response: {
    schema_version?: string;
    events?: unknown[];
    [key: string]: unknown;
  };
}

function fixtures(): FixtureLine[] {
  const file = resolve(import.meta.dirname, '..', 'contracts', 'runtime-sync-api.test-fixtures.jsonl');
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureLine);
}

describe('sync api contract fixtures', () => {
  it('keeps every accepted push event compatible with runtime schema validation', () => {
    const acceptedPushes = fixtures().filter((fixture) => fixture.request.schema_version === 'inkloop.runtime_sync_batch.v1');

    expect(acceptedPushes.length).toBeGreaterThan(0);
    for (const fixture of acceptedPushes) {
      for (const event of fixture.request.events ?? []) {
        expect(validateRuntimeSyncEvent(event)).toEqual([]);
      }
    }
  });

  it('documents unsupported schema behavior', () => {
    const unsupported = fixtures().find((fixture) => fixture.case === 'push_unsupported_schema');

    expect(unsupported?.response).toMatchObject({
      error: { code: 'unsupported_schema_version' },
    });
  });

  it('keeps pull response events compatible with runtime schema validation', () => {
    const pull = fixtures().find((fixture) => fixture.case === 'pull_ok');

    expect(pull?.response).toMatchObject({
      schema_version: 'inkloop.runtime_sync_pull.v1',
      next_cursor: '1',
    });
    for (const event of pull?.response.events ?? []) {
      expect(validateRuntimeSyncEvent(event)).toEqual([]);
    }
  });
});
