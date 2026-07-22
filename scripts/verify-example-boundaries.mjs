import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceFiles = execFileSync('rg', ['--files', 'src', 'packages', 'plugins'], { cwd: root, encoding: 'utf8' })
  .trim().split('\n').filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file));
const forbidden = /examples\/ai-annotation-demo|(?:^|[/'"])(?:server|src)\/classroom/;
const violations = sourceFiles.filter((file) => forbidden.test(readFileSync(resolve(root, file), 'utf8')));
if (violations.length) throw new Error(`SDK source imports or embeds education demo code:\n${violations.join('\n')}`);

const runtimeSchema = readFileSync(resolve(root, 'packages/runtime-schema/src/index.ts'), 'utf8');
const hostContractNames = ['EducationAiJob', 'EducationAiJobKind', 'TeacherLessonCandidate', 'TeacherLessonReviewStatus'];
const leakedContracts = hostContractNames.filter((name) => new RegExp(`export\\s+(?:interface|type|class|const|function)\\s+${name}\\b`).test(runtimeSchema));
if (leakedContracts.length) throw new Error(`Education host workflow contracts leaked into runtime-schema:\n${leakedContracts.join('\n')}`);

const exampleFiles = execFileSync('rg', ['--files', 'examples/ai-annotation-demo'], { cwd: root, encoding: 'utf8' })
  .trim().split('\n').filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file));
const internalSdkImports = exampleFiles.filter((file) => /from\s+['"](?:\.\.\/){2,}packages\//.test(readFileSync(resolve(root, file), 'utf8')));
if (internalSdkImports.length) throw new Error(`Example bypasses public SDK package exports:\n${internalSdkImports.join('\n')}`);

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
if (packageFiles.some((entry) => entry === 'examples' || entry.startsWith('examples/'))) {
  throw new Error('Root npm package must not publish examples/');
}

const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
const packedFiles = pack.flatMap((entry) => entry.files ?? []).map((entry) => entry.path);
const leaked = packedFiles.filter((file) => file.startsWith('examples/') || file.startsWith('.inkloop/') || /(?:classroom-cert|textbooks\/)/.test(file));
if (leaked.length) throw new Error(`Root npm package contains demo/runtime assets:\n${leaked.join('\n')}`);
console.log(`Example boundary verified: ${sourceFiles.length} SDK source files and ${packedFiles.length} packed files checked.`);
