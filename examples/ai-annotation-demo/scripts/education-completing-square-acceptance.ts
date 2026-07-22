export type CompletingSquareResultKind = 'current_step' | 'selected_region' | 'class_summary' | 'practice' | 'lesson_graph';

export interface CompletingSquareSemanticVerdict {
  passed: boolean;
  checks: Array<{ check: string; passed: boolean }>;
  failures: string[];
}

function normalized(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[−–—]/g, '-')
    .replace(/[＋]/g, '+')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[，。；、,;:\s]/g, '');
}

function compactFormula(value: string): string {
  return normalized(value).replace(/\^2/g, '²').replace(/\*|×/g, '');
}

function hasFormula(value: string, formula: string): boolean {
  return compactFormula(value).includes(compactFormula(formula));
}

function addsFourToBothSides(value: string): boolean {
  return /(两边|等式两侧|双方).*(加(?:4|四)|同加(?:4|四))/.test(normalized(value));
}

function verdict(checks: Array<{ check: string; passed: boolean }>): CompletingSquareSemanticVerdict {
  const failures = checks.filter((item) => !item.passed).map((item) => item.check);
  return { passed: failures.length === 0, checks, failures };
}

function currentStep(value: string): CompletingSquareSemanticVerdict {
  const text = normalized(value);
  return verdict([
    { check: 'explains_half_coefficient_squared', passed: /(一半|除以2|half).*(平方|²)|2.*平方/.test(text) },
    { check: 'adds_four_to_both_sides', passed: addsFourToBothSides(text) },
    { check: 'states_completed_equation', passed: hasFormula(value, 'x²+4x+4=9') },
  ]);
}

function selectedRegion(value: string): CompletingSquareSemanticVerdict {
  return verdict([
    { check: 'identifies_expanded_square', passed: hasFormula(value, 'x²+4x+4') },
    { check: 'identifies_perfect_square', passed: hasFormula(value, '(x+2)²=9') || (hasFormula(value, '(x+2)²') && /完全平方/.test(value)) },
  ]);
}

function completeDerivation(value: string): CompletingSquareSemanticVerdict {
  const text = normalized(value);
  return verdict([
    { check: 'original_equation', passed: hasFormula(value, 'x²+4x-5=0') },
    { check: 'moves_constant', passed: hasFormula(value, 'x²+4x=5') },
    { check: 'adds_four_to_both_sides', passed: hasFormula(value, 'x²+4x+4=9') && addsFourToBothSides(text) },
    { check: 'perfect_square', passed: hasFormula(value, '(x+2)²=9') },
    { check: 'keeps_plus_minus_branch', passed: hasFormula(value, 'x+2=±3') || (/正负3|正负三/.test(text) && hasFormula(value, 'x+2')) },
    { check: 'final_roots', passed: hasFormula(value, 'x=1') && hasFormula(value, 'x=-5') },
  ]);
}

interface ParsedPractice {
  b: number;
  c: number;
  roots: number[];
  hint: string;
}

function signedNumber(value: string): number {
  return Number(value.replace(/\s/g, ''));
}

function parsePractice(value: string): ParsedPractice | null {
  const plain = value.normalize('NFKC').replace(/[−–—]/g, '-').replace(/[＋]/g, '+');
  const answerStart = plain.search(/答案\s*[:：]/);
  const question = plain.slice(0, answerStart >= 0 ? answerStart : undefined);
  const equations = [...question.matchAll(/x(?:²|\^\s*2|2)\s*([+-]\s*\d+(?:\.\d+)?)\s*x\s*([+-]\s*\d+(?:\.\d+)?)\s*=\s*0/gi)];
  const equation = equations.at(-1);
  if (!equation) return null;
  const hintStart = plain.search(/提示\s*[:：]/);
  const hint = hintStart >= 0 ? plain.slice(hintStart, answerStart >= 0 ? answerStart : undefined) : '';
  const answer = answerStart >= 0 ? plain.slice(answerStart) : '';
  const finalClause = answer.split(/[→⇒]/).at(-1) ?? answer;
  const roots = [...finalClause.matchAll(/(?<!\d)x\s*=\s*([+-]?\s*\d+(?:\.\d+)?)/gi)].map((match) => signedNumber(match[1]));
  return { b: signedNumber(equation[1]), c: signedNumber(equation[2]), roots: [...new Set(roots)], hint };
}

function practice(value: string): CompletingSquareSemanticVerdict {
  const parsed = parsePractice(value);
  if (!parsed) return verdict([{ check: 'parseable_monic_quadratic', passed: false }]);
  const rootsCorrect = parsed.roots.length === 2
    && Math.abs(parsed.roots[0] + parsed.roots[1] + parsed.b) < 1e-9
    && Math.abs(parsed.roots[0] * parsed.roots[1] - parsed.c) < 1e-9;
  const hint = normalized(parsed.hint);
  const leaksRoot = parsed.roots.some((root) => hint.includes(`x=${root}`) || hint.includes(`答案是${root}`));
  return verdict([
    { check: 'parseable_monic_quadratic', passed: true },
    { check: 'two_correct_roots', passed: rootsCorrect },
    { check: 'hint_uses_completing_square', passed: /(一半|取半.*平方|除以2|两边加|同加|完全平方|配方)/.test(hint) },
    { check: 'hint_does_not_reveal_roots', passed: !leaksRoot && !/答案是/.test(hint) },
  ]);
}

export function evaluateCompletingSquareResult(kind: CompletingSquareResultKind, content: string): CompletingSquareSemanticVerdict {
  if (kind === 'current_step') return currentStep(content);
  if (kind === 'selected_region') return selectedRegion(content);
  if (kind === 'practice') return practice(content);
  return completeDerivation(content);
}
