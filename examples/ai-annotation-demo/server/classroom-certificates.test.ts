import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureClassroomCertificates, resolveClassroomHostAddresses } from '../scripts/classroom-certificates';

function inspect(path: string, ...args: string[]): string {
  return execFileSync('openssl', ['x509', '-in', path, '-noout', ...args], { encoding: 'utf8' });
}

describe('classroom HTTPS certificates', () => {
  it('uses physical LAN interfaces and ignores VPN or Clash virtual addresses', () => {
    expect(resolveClassroomHostAddresses({
      en0: [{ address: '172.168.20.95', family: 'IPv4', internal: false, netmask: '255.255.254.0', cidr: '172.168.20.95/23', mac: '00:00:00:00:00:01' }],
      utun0: [{ address: '192.168.120.2', family: 'IPv4', internal: false, netmask: '255.255.255.0', cidr: '192.168.120.2/24', mac: '00:00:00:00:00:02' }],
      utun9: [{ address: '198.18.0.1', family: 'IPv4', internal: false, netmask: '255.254.0.0', cidr: '198.18.0.1/15', mac: '00:00:00:00:00:03' }],
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0', cidr: '127.0.0.1/8', mac: '00:00:00:00:00:00' }],
    })).toEqual(['172.168.20.95']);
  });

  it('uses a trusted CA to sign a dedicated serverAuth leaf for every LAN address', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inkloop-classroom-cert-'));
    const result = ensureClassroomCertificates(directory, ['172.168.20.95', '192.168.120.2']);

    expect(readFileSync(result.rootCertPath, 'utf8')).toContain('BEGIN CERTIFICATE');
    expect(inspect(result.rootCertPath, '-ext', 'basicConstraints')).toContain('CA:TRUE');

    expect(inspect(result.serverCertPath, '-issuer')).toContain('issuer=CN=InkLoop Local Classroom');
    expect(inspect(result.serverCertPath, '-ext', 'basicConstraints')).toContain('CA:FALSE');
    expect(inspect(result.serverCertPath, '-ext', 'extendedKeyUsage')).toContain('TLS Web Server Authentication');
    const san = inspect(result.serverCertPath, '-ext', 'subjectAltName');
    expect(san).toContain('IP Address:172.168.20.95');
    expect(san).toContain('IP Address:192.168.120.2');

    expect(() => execFileSync('openssl', [
      'verify',
      '-CAfile', result.rootCertPath,
      '-purpose', 'sslserver',
      result.serverCertPath,
    ])).not.toThrow();

    const issuedAt = statSync(result.serverCertPath).mtimeMs;
    const reused = ensureClassroomCertificates(directory, ['192.168.120.2', '172.168.20.95']);
    expect(reused.serverCertPath).toBe(result.serverCertPath);
    expect(statSync(result.serverCertPath).mtimeMs).toBe(issuedAt);
  });

  it('rotates the leaf only when a new LAN address is missing from its SAN', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inkloop-classroom-cert-'));
    const first = ensureClassroomCertificates(directory, ['172.168.20.95']);
    const firstSerial = inspect(first.serverCertPath, '-serial');
    const rotated = ensureClassroomCertificates(directory, ['172.168.20.95', '172.168.20.96']);
    expect(inspect(rotated.serverCertPath, '-ext', 'subjectAltName')).toContain('IP Address:172.168.20.96');
    expect(inspect(rotated.serverCertPath, '-serial')).not.toBe(firstSerial);
  });
});
