const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(timeMs: number): string {
  let value = Math.max(0, Math.floor(timeMs));
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function randomPart(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 16; i++) out += CROCKFORD[bytes[i] % 32];
  return out;
}

export function ulid(now = Date.now()): string {
  return `${encodeTime(now)}${randomPart()}`;
}

export function koId(now = Date.now()): string {
  return `ko_${ulid(now)}`;
}
