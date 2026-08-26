// 图标渲染脚本：SVG → 多尺寸 PNG + 多尺寸 ICO（PNG 内嵌，Vista+ 兼容）
// 用法：node icons-src/render.mjs <svg路径> <输出基名>
// 产物：<base>-1024.png（预览）、<base>-256/48/32.png（小图检查）、<base>.ico（16/24/32/48/64/128/256）
import sharp from 'sharp';
import fs from 'node:fs';

const [svgPath, outBase] = process.argv.slice(2);
if (!svgPath || !outBase) { console.error('用法: node render.mjs <svg> <outBase>'); process.exit(1); }

const SIZES = [256, 128, 64, 48, 32, 24, 16];
const svg = fs.readFileSync(svgPath);

const pngs = new Map();
for (const s of SIZES) {
  // ponytail: 全尺寸 PNG 内嵌 ICO，Win7+ 均支持；如需 XP 兼容再换 BMP 编码
  pngs.set(s, await sharp(svg, { density: 72 }).resize(s, s, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer());
}
await sharp(svg).png().toFile(`${outBase}-1024.png`);
await fs.promises.writeFile(`${outBase}-256.png`, pngs.get(256));
await fs.promises.writeFile(`${outBase}-48.png`, pngs.get(48));
await fs.promises.writeFile(`${outBase}-32.png`, pngs.get(32));

const entries = [...pngs.entries()].sort((a, b) => b[0] - a[0]);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
const dir = Buffer.alloc(16 * entries.length);
let offset = 6 + 16 * entries.length;
const blobs = [];
entries.forEach(([s, png], i) => {
  const e = i * 16;
  dir.writeUInt8(s === 256 ? 0 : s, e);      // width, 0 = 256
  dir.writeUInt8(s === 256 ? 0 : s, e + 1);  // height
  dir.writeUInt8(0, e + 2); dir.writeUInt8(0, e + 3); // palette
  dir.writeUInt16LE(1, e + 4);               // planes
  dir.writeUInt16LE(32, e + 6);              // bpp
  dir.writeUInt32LE(png.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += png.length; blobs.push(png);
});
await fs.promises.writeFile(`${outBase}.ico`, Buffer.concat([header, dir, ...blobs]));
console.log('OK', outBase, '| ico sizes:', entries.map((e) => e[0]).join('/'));
