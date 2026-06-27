// 生成一个最小的、带真实文本层的数字版 PDF，供 HMP/SurfaceIndex 验证用。
// 一个大字号标题（reflowLocal→title）+ 两行正文段落（→text_block）。纯 ASCII，char 长度=字节偏移。
import { writeFileSync, mkdirSync } from 'node:fs';

// 三段话题互不相干的正文，行距均匀（无空行）——reflowLocal 会按 gap 把它们并成一个巨块；
// AI 结构重建应靠内容把它们切回三段。每段两行。
const body = [
  'The first paragraph talks about a quiet morning routine.',          // P1
  'It mentions coffee, soft sunlight, and a tidy desk before work.',
  'A second, unrelated paragraph shifts entirely to the weather.',     // P2
  'Rain had been falling since midnight and the streets were grey.',
  'The third paragraph is about writing code late at night.',          // P3
  'Bugs hide in tall paragraphs, and clean structure helps find them.',
];
const stream = [
  'BT /F1 24 Tf 72 720 Td (Hello SurfaceIndex Title) Tj ET',
  ...body.map((line, i) => `BT /F1 13 Tf 72 ${680 - i * 22} Td (${line}) Tj ET`),
].join('\n');

const objs = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  // Info 字典：getMetadata() 取的就是这些（演示"元信息拿到手"）
  '<< /Title (Hello SurfaceIndex Title) /Author (InkLoop Demo) /Subject (HMP char-level fixture) /Creator (make-sample-pdf.mjs) /Producer (InkLoop) /CreationDate (D:20260617120000Z) >>',
];

let pdf = '%PDF-1.4\n';
const offsets = [];
objs.forEach((body, i) => { offsets[i] = pdf.length; pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
offsets.forEach((off) => { pdf += `${String(off).padStart(10, '0')} 00000 n \n`; });
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF`;

mkdirSync('public', { recursive: true });
writeFileSync('public/sample.pdf', pdf, 'latin1');
console.log(`wrote public/sample.pdf (${pdf.length} bytes)`);
