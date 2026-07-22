import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const CLASS_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DISPLAY_CONTROL = /[\u0000-\u001f\u007f]/;
const HTML_LIKE = /[<>]/;

export function credentialHash(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function verifyCredential(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(credentialHash(token));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createOpaqueCredential(prefix: 'teacher' | 'participant'): { token: string; hash: string } {
  const token = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, hash: credentialHash(token) };
}

export function createClassCode(length = 6): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let index = 0; index < length; index += 1) code += CLASS_CODE_ALPHABET[bytes[index] % CLASS_CODE_ALPHABET.length];
  return code;
}

function normalizeDisplayText(value: string, label: string, maximum: number): string {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error(`${label}_required`);
  if (normalized.length > maximum) throw new Error(`${label}_too_long`);
  if (DISPLAY_CONTROL.test(value) || HTML_LIKE.test(normalized)) throw new Error(`${label}_invalid`);
  return normalized;
}

export function normalizeNickname(value: string): string {
  return normalizeDisplayText(value, 'nickname', 48);
}

export function safeClassroomTitle(value: string): string {
  return normalizeDisplayText(value, 'classroom_title', 96);
}
