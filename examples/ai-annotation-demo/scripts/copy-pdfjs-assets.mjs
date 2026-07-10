// 把 pdfjs-dist 的 CMap 表与标准字体拷进 public/，供老中文 PDF（非嵌入 CID 字体 +
// 预定义 CJK CMap，如 GBK-EUC-H）正常渲染。postinstall 自动跑；public/ 下这两个目录已 gitignore。
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));

for (const dir of ['cmaps', 'standard_fonts']) {
  cpSync(join(pdfjsRoot, dir), `public/${dir}`, { recursive: true });
}
console.log('pdfjs assets → public/{cmaps,standard_fonts}');
