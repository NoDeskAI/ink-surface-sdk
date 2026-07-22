import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { NetworkInterfaceInfo } from 'node:os';

export interface ClassroomCertificatePaths {
  rootCertPath: string;
  rootKeyPath: string;
  serverCertPath: string;
  serverKeyPath: string;
}

function runOpenSsl(args: string[]): void {
  const result = spawnSync('openssl', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('classroom_https_certificate_failed');
}

function certificateCovers(certPath: string, expectedNames: string[]): boolean {
  if (!existsSync(certPath)) return false;
  const result = spawnSync('openssl', ['x509', '-in', certPath, '-noout', '-checkend', '86400', '-ext', 'subjectAltName'], { encoding: 'utf8' });
  if (result.status !== 0) return false;
  const output = result.stdout;
  return expectedNames.every((name) => output.includes(name));
}

export function resolveClassroomHostAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  return Object.entries(interfaces).flatMap(([name, entries]) => {
    if (!/^en\d+$/.test(name)) return [];
    return (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address);
  }).filter((address, index, addresses) => addresses.indexOf(address) === index);
}

export function ensureClassroomCertificates(directory: string, hostAddresses: string[]): ClassroomCertificatePaths {
  const rootKeyPath = resolve(directory, 'classroom.key.pem');
  const rootCertPath = resolve(directory, 'classroom.cert.pem');
  const serverKeyPath = resolve(directory, 'classroom-server.key.pem');
  const serverCertPath = resolve(directory, 'classroom-server.cert.pem');
  const serverCsrPath = resolve(directory, 'classroom-server.csr.pem');
  mkdirSync(directory, { recursive: true });

  if (!existsSync(rootKeyPath) || !existsSync(rootCertPath)) {
    runOpenSsl([
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', rootKeyPath,
      '-out', rootCertPath,
      '-days', '825',
      '-subj', '/CN=InkLoop Local Classroom',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ]);
  }

  const sanEntries = ['DNS:localhost', 'IP:127.0.0.1', ...Array.from(new Set(hostAddresses), (address) => `IP:${address}`)];
  const san = sanEntries.join(',');
  const expectedNames = ['DNS:localhost', 'IP Address:127.0.0.1', ...Array.from(new Set(hostAddresses), (address) => `IP Address:${address}`)];
  if (existsSync(serverKeyPath) && certificateCovers(serverCertPath, expectedNames)) {
    return { rootCertPath, rootKeyPath, serverCertPath, serverKeyPath };
  }
  runOpenSsl([
    'req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', serverKeyPath,
    '-out', serverCsrPath,
    '-subj', '/CN=InkLoop LAN Classroom Server',
    '-addext', `subjectAltName=${san}`,
    '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
    '-addext', 'extendedKeyUsage=serverAuth',
  ]);
  runOpenSsl([
    'x509', '-req',
    '-in', serverCsrPath,
    '-CA', rootCertPath,
    '-CAkey', rootKeyPath,
    '-CAcreateserial',
    '-out', serverCertPath,
    '-days', '397',
    '-sha256',
    '-copy_extensions', 'copy',
  ]);
  if (existsSync(serverCsrPath)) unlinkSync(serverCsrPath);

  return { rootCertPath, rootKeyPath, serverCertPath, serverKeyPath };
}
