import { ulid } from '../../knowledge/ulid';

export function adapterId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}
