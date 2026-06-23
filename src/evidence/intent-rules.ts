/**
 * intent 规则（IntentClassifier.java 的忠实 TS 移植）。
 *
 * 端侧 POC 的 intent 判定本就是 6 条关键词规则,极简、可保真;移到 TS 后**前端/dev/套壳都能跑**,
 * 无需原生桥/AAR/板子——让"端侧 intent 能否平替云端上下文分类器(respond/fold)"的 A/B 立刻可测。
 * 规则单一真源放这里;徐的原生 IntentClassifier 留作端侧资产,不再重复用于 A/B。
 *
 * 对齐源:端侧ocr方案/src/main/java/com/example/hmpocrpoc/IntentClassifier.java
 */
export type IntentLabel = 'question' | 'todo' | 'reject' | 'relation' | 'self_note' | 'attention';

const has = (t: string, ...needles: string[]): boolean => needles.some((n) => t.includes(n));

/** (action, text) → 6 标签之一。优先级与 Java 版一致(question→todo→reject→relation→self_note→attention)。 */
export function classifyIntentLocal(action: string, text: string): IntentLabel {
  const t = (text ?? '').trim();
  if (has(t, '?', '？', '为什么', '怎么办', '如何', '怎么')) return 'question';
  if (has(t, 'TODO', 'todo', '待办', '记得', '要做', '试试', '确认')) return 'todo';
  if (action === 'cross' || has(t, '错', '不对', '不要', '否定')) return 'reject';
  if (action === 'arrow' || has(t, '关联', '因为', '所以', '导致')) return 'relation';
  if (action === 'handwriting' || action === 'sketch') return 'self_note';
  return 'attention';
}
