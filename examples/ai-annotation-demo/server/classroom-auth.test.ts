import { describe, expect, it } from 'vitest';
import {
  createClassCode,
  createOpaqueCredential,
  credentialHash,
  normalizeNickname,
  safeClassroomTitle,
  verifyCredential,
} from './classroom-auth';

describe('classroom auth', () => {
  it('creates opaque credentials and verifies hashes without persisting plaintext', () => {
    const teacher = createOpaqueCredential('teacher');
    const participant = createOpaqueCredential('participant');

    expect(teacher.token).toMatch(/^teacher_/);
    expect(participant.token).toMatch(/^participant_/);
    expect(teacher.token).not.toBe(participant.token);
    expect(teacher.hash).not.toContain(teacher.token);
    expect(verifyCredential(teacher.token, teacher.hash)).toBe(true);
    expect(verifyCredential(participant.token, teacher.hash)).toBe(false);
    expect(credentialHash(teacher.token)).toBe(teacher.hash);
  });

  it('normalizes display input while rejecting empty, control, HTML-like, and oversized values', () => {
    expect(normalizeNickname('  Alice  ')).toBe('Alice');
    expect(safeClassroomTitle('  Algebra I  ')).toBe('Algebra I');
    for (const value of ['', '   ', 'Alice\nAdmin', '<img src=x>', 'a'.repeat(49)]) {
      expect(() => normalizeNickname(value)).toThrow();
    }
  });

  it('creates short class codes with enough entropy for LAN discovery', () => {
    const codes = new Set(Array.from({ length: 50 }, () => createClassCode()));
    expect(codes.size).toBe(50);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-9]{6}$/);
  });
});
