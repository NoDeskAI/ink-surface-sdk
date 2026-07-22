import { describe, expect, it } from 'vitest';
import { evaluateCompletingSquareResult } from '../scripts/education-completing-square-acceptance';

describe('evaluateCompletingSquareResult', () => {
  it('accepts the fixed current-step explanation and rejects a coordinate-only answer', () => {
    expect(evaluateCompletingSquareResult('current_step', '一次项系数 4 的一半是 2，平方为 4，所以等式两边同时加 4，右边由 5 变成 9，得到 x² + 4x + 4 = 9。').passed).toBe(true);
    expect(evaluateCompletingSquareResult('current_step', '老师刚刚写了几条横向笔画。')).toMatchObject({ passed: false });
  });

  it('accepts only the complete fixed derivation for summary and LessonGraph', () => {
    const complete = 'x² + 4x - 5 = 0；移项得 x² + 4x = 5；等式两边同时加 4 得 x² + 4x + 4 = 9；写成 (x + 2)² = 9；开平方得到 x + 2 = ±3；所以 x = 1 或 x = -5。';
    expect(evaluateCompletingSquareResult('class_summary', complete).passed).toBe(true);
    expect(evaluateCompletingSquareResult('lesson_graph', complete).passed).toBe(true);
    expect(evaluateCompletingSquareResult('class_summary', complete.replace('±3', '3').replace('或 x = -5', '')).passed).toBe(false);
    expect(evaluateCompletingSquareResult('lesson_graph', 'x² + 4x - 5 = 0；移项得 x² + 4x = 5。\n等式两边同时加 4，右边变成 9。\nx² + 4x + 4 = 9；(x + 2)² = 9；x + 2 = ±3；x = 1 或 x = -5。').passed).toBe(true);
    expect(evaluateCompletingSquareResult('lesson_graph', '原方程 x² + 4x - 5 = 0，移项得 x² + 4x = 5；等式两边同时加四，右边变成九，得到 x² + 4x + 4 = 9；(x + 2)² = 9；x + 2 = ±3；x = 1 或 x = -5。').passed).toBe(true);
  });

  it('requires selected-region explanation to identify the perfect square', () => {
    expect(evaluateCompletingSquareResult('selected_region', 'x² + 4x + 4 可以写成 (x + 2)²，因此等式成为 (x + 2)² = 9。').passed).toBe(true);
    expect(evaluateCompletingSquareResult('selected_region', '把常数移到等式右边。').passed).toBe(false);
  });

  it('checks a practice question, non-leaking hint, and mathematically correct answer', () => {
    expect(evaluateCompletingSquareResult('practice', '题目：用配方法解 x² + 6x + 5 = 0。\n提示：先移项，再在等式两边加一次项系数一半的平方。\n答案：x = -1 或 x = -5。').passed).toBe(true);
    expect(evaluateCompletingSquareResult('practice', '题目：x² + 6x - 7 = 0。提示：取半平方。答案：x² + 6x = 7 → (x + 3)² = 16 → x + 3 = ±4 → x = 1 或 x = -7。').passed).toBe(true);
    expect(evaluateCompletingSquareResult('practice', '题目：板书演示了 x² + 4x - 5 = 0。请仿照该方法解 x² + 6x - 7 = 0。提示：一次项系数 6 的一半是 3，等式两边同时加 9。答案：x² + 6x = 7 → (x + 3)² = 16 → x + 3 = ±4 → x = 1 或 x = -7。').passed).toBe(true);
    expect(evaluateCompletingSquareResult('practice', '题目：解 x² + 4x - 5 = 0。提示：取一次项系数一半的平方。答案：1. 移项得 x² + 4x = 5。2. 两边同时加 4，得 x² + 4x + 4 = 9。3. (x + 2)² = 9。4. 最终 x = 1 或 x = -5。').passed).toBe(true);
    expect(evaluateCompletingSquareResult('practice', '题目：x² + 6x + 5 = 0。提示：答案是 -1 和 -5。答案：x = -1 或 x = -5。').passed).toBe(false);
    expect(evaluateCompletingSquareResult('practice', '题目：x² + 6x + 5 = 0。提示：两边加 9。答案：x = 1 或 x = 5。').passed).toBe(false);
  });
});
