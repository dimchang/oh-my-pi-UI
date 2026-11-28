/**
 * html-form-parser.ts — OMP 19.1.0 `ask` 工具整页 HTML `<form>` 的安全纯函数解析器。
 *
 * 安全契约：
 * - 绝不执行任何脚本或内联事件处理器（剥离 <script>/<style>/<iframe>/<object>/<embed>/<noscript> 与 on* 属性）；
 * - <img> 仅允许 http(s): 与 data:image/ 协议（禁止 javascript:/vbscript:/file:）；
 * - 纯 TypeScript 实现，不依赖浏览器 DOM，可在 Node / Vitest / Renderer 无差异运行。
 *
 * 协议对齐（omp 18.18.3 / 19.1.0 / 19.1.1）：
 * - 请求：extension_ui_request { method: 'form', html: string, timeout?: number }
 * - 响应：extension_ui_response { id, data: Record<string, string | number | string[]> } 或 { id, cancelled: true }
 * - 19.1.1 关键修复：同一 <fieldset> 内不同 name 的 radio 互不干扰，按各自 name 独立分组与提交。
 */

export type FormFieldValue = string | number | string[];
export type FormDataRecord = Record<string, FormFieldValue>;

export interface FormOption {
  value: string;
  label: string;
  selected?: boolean;
  disabled?: boolean;
}

export type FormNode =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'pre'; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'hr' }
  | { kind: 'fieldset'; legend?: string; children: FormNode[] }
  | {
      kind: 'radio';
      name: string;
      value: string;
      label: string;
      checked: boolean;
      disabled?: boolean;
    }
  | {
      kind: 'checkbox';
      name: string;
      value: string;
      label: string;
      checked: boolean;
      disabled?: boolean;
    }
  | {
      kind: 'select';
      name: string;
      label?: string;
      multiple: boolean;
      required?: boolean;
      disabled?: boolean;
      options: FormOption[];
    }
  | {
      kind: 'input';
      inputType: 'text' | 'number' | 'email' | 'url' | 'password' | 'search' | 'hidden';
      name: string;
      label?: string;
      defaultValue: string;
      placeholder?: string;
      required?: boolean;
      disabled?: boolean;
    }
  | {
      kind: 'textarea';
      name: string;
      label?: string;
      defaultValue: string;
      placeholder?: string;
      rows?: number;
      required?: boolean;
      disabled?: boolean;
    };

export interface ParsedHtmlForm {
  nodes: FormNode[];
  /** 按 HTML 初始状态（checked / selected / value / textarea 正文）生成的默认提交值 */
  initialValues: FormDataRecord;
  /** 每个字段名对应的控件类型，用于决定复选框序列化为 string[] 还是单值 */
  fieldMeta: Record<string, { kind: 'radio' | 'checkbox' | 'select-single' | 'select-multi' | 'input' | 'textarea' | 'number'; checkboxCount?: number }>;
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const DANGEROUS_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template']);

interface RawElement {
  type: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: RawNode[];
}
interface RawText {
  type: 'text';
  text: string;
}
type RawNode = RawElement | RawText;

/** 常见 HTML 实体解码 */
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g, (full, ent: string) => {
    switch (ent) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return ' ';
      default:
        if (ent.startsWith('#x') || ent.startsWith('#X')) {
          const cp = parseInt(ent.slice(2), 16);
          return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
        }
        if (ent.startsWith('#')) {
          const cp = parseInt(ent.slice(1), 10);
          return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
        }
        return full;
    }
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const key = m[1]!.toLowerCase();
    // 严禁任何事件处理器属性
    if (key.startsWith('on')) continue;
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = decodeHtmlEntities(val);
  }
  return attrs;
}

/** 轻量级容错 HTML 树构建（不执行脚本，剥离危险标签） */
function parseRawTree(html: string): RawNode[] {
  // 先去掉 HTML 注释与危险标签块
  let clean = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of DANGEROUS_TAGS) {
    clean = clean.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    clean = clean.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }

  const root: RawElement = { type: 'element', tag: '#root', attrs: {}, children: [] };
  const stack: RawElement[] = [root];
  const tokenRe = /<(\/)?([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^<>]*?)?)(\/)?>/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(clean))) {
    if (m.index > lastIdx) {
      const text = decodeHtmlEntities(clean.slice(lastIdx, m.index));
      if (text) stack[stack.length - 1]!.children.push({ type: 'text', text });
    }
    lastIdx = tokenRe.lastIndex;

    const isClose = Boolean(m[1]);
    const tag = m[2]!.toLowerCase();
    const attrStr = m[3] ?? '';
    const isSelfClose = Boolean(m[4]) || VOID_TAGS.has(tag);

    if (isClose) {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i]!.tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const el: RawElement = {
      type: 'element',
      tag,
      attrs: parseAttrs(attrStr),
      children: [],
    };
    stack[stack.length - 1]!.children.push(el);
    if (!isSelfClose) {
      stack.push(el);
    }
  }

  if (lastIdx < clean.length) {
    const tail = decodeHtmlEntities(clean.slice(lastIdx));
    if (tail) stack[stack.length - 1]!.children.push({ type: 'text', text: tail });
  }
  return root.children;
}

function collectText(nodes: RawNode[], preserveWhitespace = false): string {
  const parts: string[] = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      parts.push(n.text);
    } else if (n.tag === 'br') {
      parts.push('\n');
    } else if (n.tag === 'input' || n.tag === 'select' || n.tag === 'textarea') {
      // 控件自身不贡献给外层标签文字
    } else {
      parts.push(collectText(n.children, preserveWhitespace || n.tag === 'pre' || n.tag === 'code'));
    }
  }
  const joined = parts.join('');
  if (preserveWhitespace) return joined;
  return joined.replace(/[ \t\r\n]+/g, ' ').trim();
}

function isSafeImageSrc(src: string): boolean {
  const s = src.trim().toLowerCase();
  return s.startsWith('https://') || s.startsWith('http://') || s.startsWith('data:image/');
}

function findElements(nodes: RawNode[], pred: (el: RawElement) => boolean, out: RawElement[] = []): RawElement[] {
  for (const n of nodes) {
    if (n.type === 'element') {
      if (pred(n)) out.push(n);
      findElements(n.children, pred, out);
    }
  }
  return out;
}

/** 收集所有 <label for="id"> 映射 */
function buildLabelForMap(nodes: RawNode[]): Map<string, string> {
  const map = new Map<string, string>();
  const labels = findElements(nodes, (el) => el.tag === 'label' && Boolean(el.attrs.for));
  for (const lb of labels) {
    const id = lb.attrs.for!;
    const txt = collectText(lb.children);
    if (id && txt && !map.has(id)) map.set(id, txt);
  }
  return map;
}

function hasInteractiveDescendant(nodes: RawNode[]): boolean {
  return findElements(nodes, (el) => el.tag === 'input' || el.tag === 'select' || el.tag === 'textarea').length > 0;
}

/** 解析 HTML `<form>` 为安全的声明式 FormNode 树 + 初始提交值 */
export function parseHtmlForm(html: string): ParsedHtmlForm {
  const rawTree = parseRawTree(html || '');
  const labelFor = buildLabelForMap(rawTree);
  const usedLabelFor = new Set<string>();
  let autoFieldSeq = 0;

  const nextAutoName = (prefix: string): string => `${prefix}_${++autoFieldSeq}`;

  const convertInput = (el: RawElement, wrapLabel?: string): FormNode | null => {
    const rawType = (el.attrs.type ?? 'text').toLowerCase();
    if (rawType === 'submit' || rawType === 'button' || rawType === 'reset') return null;

    const id = el.attrs.id;
    const forText = id ? labelFor.get(id) : undefined;
    if (id && forText) usedLabelFor.add(id);
    const label = (wrapLabel || forText || el.attrs['aria-label'] || '').trim();
    const name = (el.attrs.name || id || nextAutoName(rawType)).trim();
    const disabled = 'disabled' in el.attrs;
    const required = 'required' in el.attrs;

    if (rawType === 'radio') {
      const value = el.attrs.value ?? (label || 'on');
      return {
        kind: 'radio',
        name,
        value,
        label: label || value,
        checked: 'checked' in el.attrs,
        disabled,
      };
    }
    if (rawType === 'checkbox') {
      const value = el.attrs.value ?? (label || 'on');
      return {
        kind: 'checkbox',
        name,
        value,
        label: label || value,
        checked: 'checked' in el.attrs,
        disabled,
      };
    }
    const allowedTypes = new Set(['text', 'number', 'email', 'url', 'password', 'search', 'hidden']);
    const inputType = (allowedTypes.has(rawType) ? rawType : 'text') as
      | 'text'
      | 'number'
      | 'email'
      | 'url'
      | 'password'
      | 'search'
      | 'hidden';
    return {
      kind: 'input',
      inputType,
      name,
      label: label || undefined,
      defaultValue: el.attrs.value ?? '',
      placeholder: el.attrs.placeholder,
      required,
      disabled,
    };
  };

  const convertSelect = (el: RawElement, wrapLabel?: string): FormNode => {
    const id = el.attrs.id;
    const forText = id ? labelFor.get(id) : undefined;
    if (id && forText) usedLabelFor.add(id);
    const label = (wrapLabel || forText || el.attrs['aria-label'] || '').trim() || undefined;
    const name = (el.attrs.name || id || nextAutoName('select')).trim();
    const optEls = findElements(el.children, (c) => c.tag === 'option');
    const options: FormOption[] = optEls.map((opt) => {
      const text = collectText(opt.children);
      const value = 'value' in opt.attrs ? opt.attrs.value! : text;
      return {
        value,
        label: text || value,
        selected: 'selected' in opt.attrs,
        disabled: 'disabled' in opt.attrs,
      };
    });
    return {
      kind: 'select',
      name,
      label,
      multiple: 'multiple' in el.attrs,
      required: 'required' in el.attrs,
      disabled: 'disabled' in el.attrs,
      options,
    };
  };

  const convertTextarea = (el: RawElement, wrapLabel?: string): FormNode => {
    const id = el.attrs.id;
    const forText = id ? labelFor.get(id) : undefined;
    if (id && forText) usedLabelFor.add(id);
    const label = (wrapLabel || forText || el.attrs['aria-label'] || '').trim() || undefined;
    const name = (el.attrs.name || id || nextAutoName('textarea')).trim();
    const rowsNum = el.attrs.rows ? Number(el.attrs.rows) : undefined;
    return {
      kind: 'textarea',
      name,
      label,
      defaultValue: collectText(el.children, true),
      placeholder: el.attrs.placeholder,
      rows: rowsNum && Number.isFinite(rowsNum) && rowsNum > 0 ? Math.min(rowsNum, 16) : undefined,
      required: 'required' in el.attrs,
      disabled: 'disabled' in el.attrs,
    };
  };

  const convertNodes = (nodes: RawNode[]): FormNode[] => {
    const out: FormNode[] = [];
    let inlineTextBuf: string[] = [];

    const flushInlineText = () => {
      const txt = inlineTextBuf.join(' ').replace(/[ \t\r\n]+/g, ' ').trim();
      inlineTextBuf = [];
      if (txt) out.push({ kind: 'paragraph', text: txt });
    };

    for (const n of nodes) {
      if (n.type === 'text') {
        const t = n.text.replace(/[ \t\r\n]+/g, ' ').trim();
        if (t) inlineTextBuf.push(t);
        continue;
      }

      const tag = n.tag;

      if (tag === 'form' || tag === 'div' || tag === 'section' || tag === 'main' || tag === 'article' || tag === 'header' || tag === 'footer' || tag === 'aside' || tag === 'details') {
        flushInlineText();
        out.push(...convertNodes(n.children));
        continue;
      }

      if (tag === 'fieldset') {
        flushInlineText();
        let legend: string | undefined;
        const rest: RawNode[] = [];
        for (const ch of n.children) {
          if (ch.type === 'element' && ch.tag === 'legend' && legend === undefined) {
            const lt = collectText(ch.children);
            if (lt) legend = lt;
          } else {
            rest.push(ch);
          }
        }
        const children = convertNodes(rest);
        if (legend || children.length > 0) {
          out.push({ kind: 'fieldset', legend, children });
        }
        continue;
      }

      if (/^h[1-6]$/.test(tag)) {
        flushInlineText();
        const text = collectText(n.children);
        if (text) out.push({ kind: 'heading', level: Number(tag[1]), text });
        continue;
      }

      if (tag === 'p' || tag === 'summary' || tag === 'blockquote') {
        flushInlineText();
        if (hasInteractiveDescendant(n.children)) {
          out.push(...convertNodes(n.children));
        } else {
          const text = collectText(n.children);
          if (text) out.push({ kind: 'paragraph', text });
        }
        continue;
      }

      if (tag === 'ul' || tag === 'ol') {
        flushInlineText();
        if (hasInteractiveDescendant(n.children)) {
          out.push(...convertNodes(n.children));
        } else {
          const items = findElements(n.children, (c) => c.tag === 'li')
            .map((li) => collectText(li.children))
            .filter(Boolean);
          if (items.length > 0) out.push({ kind: 'list', ordered: tag === 'ol', items });
        }
        continue;
      }

      if (tag === 'li') {
        flushInlineText();
        if (hasInteractiveDescendant(n.children)) {
          out.push(...convertNodes(n.children));
        } else {
          const text = collectText(n.children);
          if (text) out.push({ kind: 'paragraph', text: `• ${text}` });
        }
        continue;
      }

      if (tag === 'pre') {
        flushInlineText();
        const text = collectText(n.children, true).replace(/^\n+|\n+$/g, '');
        if (text) out.push({ kind: 'pre', text });
        continue;
      }

      if (tag === 'table') {
        flushInlineText();
        const trs = findElements(n.children, (c) => c.tag === 'tr');
        const headers: string[] = [];
        const rows: string[][] = [];
        for (const tr of trs) {
          const ths = tr.children.filter((c): c is RawElement => c.type === 'element' && c.tag === 'th');
          const tds = tr.children.filter((c): c is RawElement => c.type === 'element' && c.tag === 'td');
          if (ths.length > 0 && headers.length === 0) {
            headers.push(...ths.map((c) => collectText(c.children)));
          } else if (tds.length > 0 || ths.length > 0) {
            rows.push([...ths, ...tds].map((c) => collectText(c.children)));
          }
        }
        if (headers.length > 0 || rows.length > 0) {
          out.push({ kind: 'table', headers, rows });
        }
        continue;
      }

      if (tag === 'hr') {
        flushInlineText();
        out.push({ kind: 'hr' });
        continue;
      }

      if (tag === 'img') {
        flushInlineText();
        const src = n.attrs.src ?? '';
        if (src && isSafeImageSrc(src)) {
          out.push({ kind: 'image', src, alt: n.attrs.alt ?? '' });
        } else if (n.attrs.alt) {
          out.push({ kind: 'paragraph', text: `[图片: ${n.attrs.alt}]` });
        }
        continue;
      }

      if (tag === 'label') {
        flushInlineText();
        const controls = findElements(n.children, (c) => c.tag === 'input' || c.tag === 'select' || c.tag === 'textarea');
        const labelText = collectText(n.children);
        if (controls.length > 0) {
          for (const ctrl of controls) {
            const converted =
              ctrl.tag === 'input'
                ? convertInput(ctrl, labelText)
                : ctrl.tag === 'select'
                  ? convertSelect(ctrl, labelText)
                  : convertTextarea(ctrl, labelText);
            if (converted) out.push(converted);
          }
        } else if (n.attrs.for) {
          // 已被 for 绑定到后续控件的 label 不重复渲染；若后面未消费会在末尾检查
          if (!usedLabelFor.has(n.attrs.for) && !labelFor.has(n.attrs.for) && labelText) {
            out.push({ kind: 'paragraph', text: labelText });
          }
        } else if (labelText) {
          out.push({ kind: 'paragraph', text: labelText });
        }
        continue;
      }

      if (tag === 'input') {
        flushInlineText();
        const node = convertInput(n);
        if (node) out.push(node);
        continue;
      }

      if (tag === 'select') {
        flushInlineText();
        out.push(convertSelect(n));
        continue;
      }

      if (tag === 'textarea') {
        flushInlineText();
        out.push(convertTextarea(n));
        continue;
      }

      if (tag === 'button') {
        // 表单内部 <button type="submit"> 由模态统一的提交/取消按钮接管
        continue;
      }

      // 其余行内元素（span / strong / em / code / a / small 等）
      if (hasInteractiveDescendant(n.children)) {
        flushInlineText();
        out.push(...convertNodes(n.children));
      } else {
        const txt = collectText(n.children);
        if (txt) inlineTextBuf.push(txt);
      }
    }

    flushInlineText();
    return out;
  };

  const nodes = convertNodes(rawTree);
  const { initialValues, fieldMeta } = extractInitialFormState(nodes);
  return { nodes, initialValues, fieldMeta };
}

function extractInitialFormState(nodes: FormNode[]): {
  initialValues: FormDataRecord;
  fieldMeta: ParsedHtmlForm['fieldMeta'];
} {
  const initialValues: FormDataRecord = {};
  const fieldMeta: ParsedHtmlForm['fieldMeta'] = {};

  const walk = (list: FormNode[]) => {
    for (const node of list) {
      if (node.kind === 'fieldset') {
        walk(node.children);
        continue;
      }
      if (node.kind === 'radio') {
        if (!fieldMeta[node.name]) fieldMeta[node.name] = { kind: 'radio' };
        if (node.checked) {
          initialValues[node.name] = node.value;
        }
      } else if (node.kind === 'checkbox') {
        const meta = fieldMeta[node.name];
        if (!meta) {
          fieldMeta[node.name] = { kind: 'checkbox', checkboxCount: 1 };
        } else {
          meta.checkboxCount = (meta.checkboxCount ?? 0) + 1;
        }
        const cur = Array.isArray(initialValues[node.name]) ? (initialValues[node.name] as string[]) : [];
        if (node.checked && !cur.includes(node.value)) {
          initialValues[node.name] = [...cur, node.value];
        } else if (!(node.name in initialValues)) {
          initialValues[node.name] = [];
        }
      } else if (node.kind === 'select') {
        if (node.multiple) {
          fieldMeta[node.name] = { kind: 'select-multi' };
          initialValues[node.name] = node.options.filter((o) => o.selected).map((o) => o.value);
        } else {
          fieldMeta[node.name] = { kind: 'select-single' };
          const sel = node.options.find((o) => o.selected) ?? node.options.find((o) => !o.disabled);
          initialValues[node.name] = sel ? sel.value : '';
        }
      } else if (node.kind === 'input') {
        if (node.inputType === 'number') {
          fieldMeta[node.name] = { kind: 'number' };
          const num = node.defaultValue !== '' ? Number(node.defaultValue) : NaN;
          initialValues[node.name] = Number.isFinite(num) ? num : node.defaultValue;
        } else {
          fieldMeta[node.name] = { kind: 'input' };
          initialValues[node.name] = node.defaultValue;
        }
      } else if (node.kind === 'textarea') {
        fieldMeta[node.name] = { kind: 'textarea' };
        initialValues[node.name] = node.defaultValue;
      }
    }
  };

  walk(nodes);
  return { initialValues, fieldMeta };
}

/** 序列化提交负载：确保数字类型正确转换、空数组/未选字段符合 OMP `ask` 表单契约 */
export function serializeFormData(
  values: FormDataRecord,
  fieldMeta: ParsedHtmlForm['fieldMeta'],
): FormDataRecord {
  const out: FormDataRecord = {};
  for (const [name, val] of Object.entries(values)) {
    const meta = fieldMeta[name];
    if (meta?.kind === 'number') {
      if (typeof val === 'number' && Number.isFinite(val)) {
        out[name] = val;
      } else if (typeof val === 'string' && val.trim() !== '' && Number.isFinite(Number(val))) {
        out[name] = Number(val);
      } else {
        out[name] = '';
      }
    } else if (meta?.kind === 'checkbox' || meta?.kind === 'select-multi') {
      out[name] = Array.isArray(val) ? val : val ? [String(val)] : [];
    } else {
      out[name] = val;
    }
  }
  return out;
}
