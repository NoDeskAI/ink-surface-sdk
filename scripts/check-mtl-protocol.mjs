#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = resolve(
  repoRoot,
  'examples/ai-annotation-demo/server/fixtures/mtl-protocol-contract.json',
);
const functionNames = [
  'firstNonEmpty',
  'isPlainObject',
  'compactObject',
  'normalizeAbsoluteMs',
  'maybeAbsoluteMs',
  'normalizeCandidates',
  'buildMeetingStartPayload',
  'buildMeetingEndPayload',
  'buildTimelineMark',
];
const builderNames = [
  'buildMeetingStartPayload',
  'buildMeetingEndPayload',
  'buildTimelineMark',
];

function usage() {
  console.error('Usage: node scripts/check-mtl-protocol.mjs <meeting-timeline-sdk-clone>');
}

function matchingDelimiter(source, start, open, close) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`Unclosed ${open} delimiter`);
}

function extractFunction(source, name) {
  const declaration = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = declaration.exec(source);
  if (!match) throw new Error(`Function ${name} was not found`);
  const parametersOpen = source.indexOf('(', match.index);
  const parametersClose = matchingDelimiter(source, parametersOpen, '(', ')');
  const open = source.indexOf('{', parametersClose);
  const close = matchingDelimiter(source, open, '{', '}');
  return source.slice(match.index, close + 1).replaceAll('\r\n', '\n').trim();
}

function splitTopLevelProperties(source) {
  const parts = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') round += 1;
    else if (char === ')') round -= 1;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === ',' && round === 0 && square === 0 && curly === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function extractPayloadKeys(functionSource) {
  const returnIndex = functionSource.indexOf('return compactObject(');
  if (returnIndex < 0) throw new Error('return compactObject(...) was not found');
  const open = functionSource.indexOf('{', returnIndex);
  const close = matchingDelimiter(functionSource, open, '{', '}');
  return splitTopLevelProperties(functionSource.slice(open + 1, close)).flatMap((part) => {
    const match = /^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(part.trim());
    return match ? [match[1]] : [];
  });
}

function extractFrozenStrings(source, name) {
  const declaration = source.indexOf(`export const ${name}`);
  if (declaration < 0) throw new Error(`Constant ${name} was not found`);
  const open = source.indexOf('[', declaration);
  const close = matchingDelimiter(source, open, '[', ']');
  return [...source.slice(open + 1, close).matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

function digest(source) {
  return createHash('sha256').update(source).digest('hex');
}

function diffValues(expected, actual, path, differences) {
  if (isDeepStrictEqual(expected, actual)) return;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      diffValues(expected[index], actual[index], `${path}[${index}]`, differences);
    }
    return;
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) diffValues(expected[key], actual[key], `${path}.${key}`, differences);
    return;
  }
  differences.push(`${path}: pinned=${JSON.stringify(expected)} current=${JSON.stringify(actual)}`);
}

async function main() {
  const sdkArg = process.argv[2];
  if (!sdkArg || sdkArg.startsWith('-')) {
    usage();
    process.exitCode = 2;
    return;
  }

  const sdkRoot = resolve(sdkArg);
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const indexPath = resolve(sdkRoot, fixture.source.payload_builders);
  const corePath = resolve(sdkRoot, fixture.source.live_acceptance_core);
  const runnerPath = resolve(sdkRoot, fixture.source.live_acceptance_runner);
  let indexSource;
  let coreSource;
  let runnerSource;
  try {
    [indexSource, coreSource, runnerSource] = await Promise.all([
      readFile(indexPath, 'utf8'),
      readFile(corePath, 'utf8'),
      readFile(runnerPath, 'utf8'),
    ]);
  } catch (error) {
    console.error(`MTL protocol check failed: ${String(error?.message ?? error)}`);
    process.exitCode = 2;
    return;
  }

  const functions = Object.fromEntries(functionNames.map((name) => [name, extractFunction(indexSource, name)]));
  const sourceHashes = Object.fromEntries(functionNames.map((name) => [name, digest(functions[name])]));
  const payloadKeys = Object.fromEntries(builderNames.map((name) => [name, extractPayloadKeys(functions[name])]));
  const platforms = extractFrozenStrings(coreSource, 'THREE_PLATFORM_LIVE_ACCEPTANCE_PLATFORMS');
  const speakerCheckIds = extractFrozenStrings(coreSource, 'THREE_PLATFORM_SPEAKER_CHECK_IDS');
  const evaluationSource = extractFunction(coreSource, 'evaluateThreePlatformLiveEvidence');
  const allCheckIds = [...evaluationSource.matchAll(/\bcheck\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  const coreCheckIds = allCheckIds.filter((id) => !speakerCheckIds.includes(id));
  const httpResponseCheckpoints = [
    ...(/!response\.ok/.test(runnerSource) ? ['response.ok'] : []),
    ...(/response\.status/.test(runnerSource) ? ['response.status'] : []),
    ...(/annotation\.ack\?\.accepted/.test(runnerSource) ? ['annotation.ack.accepted'] : []),
  ];

  const differences = [];
  diffValues(
    fixture.live_acceptance_core_sha256,
    digest(coreSource.replaceAll('\r\n', '\n').trim()),
    'live_acceptance_core_sha256',
    differences,
  );
  diffValues(fixture.payload_source_hashes, sourceHashes, 'payload_source_hashes', differences);
  diffValues(fixture.payload_keys, payloadKeys, 'payload_keys', differences);
  diffValues(fixture.live_acceptance.platforms, platforms, 'live_acceptance.platforms', differences);
  diffValues(fixture.live_acceptance.core_check_ids, coreCheckIds, 'live_acceptance.core_check_ids', differences);
  diffValues(fixture.live_acceptance.speaker_check_ids, speakerCheckIds, 'live_acceptance.speaker_check_ids', differences);
  diffValues(
    fixture.live_acceptance.http_response_checkpoints,
    httpResponseCheckpoints,
    'live_acceptance.http_response_checkpoints',
    differences,
  );

  let sdk;
  try {
    sdk = await import(`${pathToFileURL(indexPath).href}?mtl-contract=${Date.now()}`);
  } catch (error) {
    differences.push(`SDK payload builders could not be loaded: ${String(error?.message ?? error)}`);
  }
  if (sdk) {
    for (const [caseName, payloadCase] of Object.entries(fixture.payload_cases)) {
      const builder = sdk[payloadCase.builder];
      if (typeof builder !== 'function') {
        differences.push(`payload_cases.${caseName}: builder ${payloadCase.builder} is not exported`);
        continue;
      }
      try {
        const actual = builder(payloadCase.input, payloadCase.defaults);
        diffValues(payloadCase.expected, actual, `payload_cases.${caseName}.expected`, differences);
      } catch (error) {
        differences.push(`payload_cases.${caseName}: builder threw ${String(error?.message ?? error)}`);
      }
    }
  }

  let currentCommit = 'unknown';
  try {
    currentCommit = execFileSync('git', ['-C', sdkRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}

  if (differences.length) {
    console.error(`MTL protocol drift detected (${differences.length} difference(s)).`);
    console.error(`Pinned SDK commit: ${fixture.source.commit}`);
    console.error(`Checked SDK commit: ${currentCommit}`);
    for (const difference of differences) console.error(`- ${difference}`);
    console.error('Review the SDK change, update the receiver if required, then refresh the fixture and contract test.');
    process.exitCode = 1;
    return;
  }

  console.log(`MTL protocol compatible: checked ${currentCommit} against fixture ${fixture.source.commit}.`);
}

main().catch((error) => {
  console.error(`MTL protocol check failed: ${String(error?.stack ?? error)}`);
  process.exitCode = 2;
});
