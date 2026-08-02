/**
 * image-data-url.ts — 把 readImageAsDataUrl 返回的完整 data:image/...;base64,... URL
 * 转成 omp ImageContent.data 要求的「裸 base64」（不带 data: 前缀）。
 *
 * 背景（实证 session 019fc31c）：omp 侧对 {type:'image', data, mimeType} 块的 data
 * 直接做 Buffer.from(data, 'base64')。若传入带前缀的完整 data URL，"data:image/png;base64,"
 * 会被当作 base64 一并解码（其中 '/' 是合法 base64 字符），得到损坏字节：
 *  blob 入库为垃圾、vision 描述失败（[Image description unavailable]）、
 *  inspect_image 报 "only supports PNG, JPEG, GIF, and WEBP"、agent 退化成 bash 瞎折腾。
 * 原生 OMP 的 ImageContent.data 就是裸 base64，这里做等价转换。
 */
export function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(';base64,');
  return comma >= 0 ? dataUrl.slice(comma + ';base64,'.length) : dataUrl;
}
