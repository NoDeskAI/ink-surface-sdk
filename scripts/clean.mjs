import { readdirSync, rmSync } from 'node:fs';

const TARGETS = [
  'dist',
  ...readdirSync('.').filter((entry) => /^ink-surface-sdk-.+\.tgz$/.test(entry)),
];

for (const target of TARGETS) {
  try {
    rmSync(target, { recursive: true, force: true });
    console.log(`removed ${target}`);
  } catch (error) {
    console.warn(`skip ${target}: ${error.message}`);
  }
}
