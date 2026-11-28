import { describe, expect, it } from 'vitest';
import { parseHtmlForm, serializeFormData, decodeHtmlEntities } from './html-form-parser';

describe('html-form-parser (OMP 19.1.0+ ask HTML form)', () => {
  it('解码常见 HTML 实体与数字实体', () => {
    expect(decodeHtmlEntities('A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&#39; &#x27;F&#x27;')).toBe(
      `A & B <C> "D" 'E' 'F'`,
    );
  });

  it('彻底剥离 <script>/<style>/<iframe> 与 on* 属性，并拦截非安全图片协议', () => {
    const html = `
      <form>
        <h2>配置确认</h2>
        <script>alert("xss")</script>
        <style>body { display: none; }</style>
        <iframe src="https://evil.example"></iframe>
        <img src="javascript:alert(1)" alt="bad" onerror="alert(2)" />
        <img src="https://example.com/ok.png" alt="good" onload="evil()" />
        <img src="data:image/png;base64,AAAA" alt="data" />
        <input type="text" name="host" value="localhost" onclick="steal()" />
      </form>
    `;
    const parsed = parseHtmlForm(html);
    const json = JSON.stringify(parsed);
    expect(json).not.toContain('alert');
    expect(json).not.toContain('steal');
    expect(json).not.toContain('evil.example');
    expect(json).not.toContain('javascript:');
    // 合法的 https 与 data:image/ 应保留
    const imgs = parsed.nodes.filter((n) => n.kind === 'image');
    expect(imgs).toHaveLength(2);
    expect(parsed.initialValues.host).toBe('localhost');
  });

  it('OMP 19.1.1 关键契约：同一 <fieldset> 内不同 name 的 radio 互不干扰', () => {
    const html = `
      <form>
        <fieldset>
          <legend>部署策略</legend>
          <label><input type="radio" name="env" value="staging" checked /> Staging</label>
          <label><input type="radio" name="env" value="prod" /> Production</label>
          <label><input type="radio" name="region" value="us" /> US</label>
          <label><input type="radio" name="region" value="eu" checked /> EU</label>
        </fieldset>
      </form>
    `;
    const parsed = parseHtmlForm(html);
    expect(parsed.initialValues).toEqual({ env: 'staging', region: 'eu' });
    expect(parsed.fieldMeta.env?.kind).toBe('radio');
    expect(parsed.fieldMeta.region?.kind).toBe('radio');
  });

  it('复选框、多选下拉、单选下拉、数字框、textarea 初始值与序列化正确', () => {
    const html = `
      <form>
        <label><input type="checkbox" name="features" value="auth" checked /> Auth</label>
        <label><input type="checkbox" name="features" value="cache" /> Cache</label>
        <label><input type="checkbox" name="features" value="metrics" checked /> Metrics</label>
        <select name="framework">
          <option value="react">React</option>
          <option value="vue" selected>Vue</option>
        </select>
        <select name="targets" multiple>
          <option value="win" selected>Windows</option>
          <option value="mac" selected>macOS</option>
          <option value="linux">Linux</option>
        </select>
        <input type="number" name="port" value="8080" />
        <textarea name="notes">hello &amp; world</textarea>
      </form>
    `;
    const parsed = parseHtmlForm(html);
    expect(parsed.initialValues).toEqual({
      features: ['auth', 'metrics'],
      framework: 'vue',
      targets: ['win', 'mac'],
      port: 8080,
      notes: 'hello & world',
    });

    const out = serializeFormData(
      { ...parsed.initialValues, port: '9090', features: ['cache'] },
      parsed.fieldMeta,
    );
    expect(out.port).toBe(9090);
    expect(out.features).toEqual(['cache']);
    expect(out.targets).toEqual(['win', 'mac']);
  });

  it('解析表格、列表与代码块内容', () => {
    const html = `
      <form>
        <h3>对比表</h3>
        <table>
          <thead><tr><th>方案</th><th>耗时</th></tr></thead>
          <tbody>
            <tr><td>A</td><td>10ms</td></tr>
            <tr><td>B</td><td>20ms</td></tr>
          </tbody>
        </table>
        <ul><li>项 1</li><li>项 2</li></ul>
        <pre><code>const x = 1;</code></pre>
      </form>
    `;
    const parsed = parseHtmlForm(html);
    expect(parsed.nodes.some((n) => n.kind === 'heading' && n.text === '对比表')).toBe(true);
    const table = parsed.nodes.find((n) => n.kind === 'table');
    expect(table).toEqual({
      kind: 'table',
      headers: ['方案', '耗时'],
      rows: [
        ['A', '10ms'],
        ['B', '20ms'],
      ],
    });
    const list = parsed.nodes.find((n) => n.kind === 'list');
    expect(list).toEqual({ kind: 'list', ordered: false, items: ['项 1', '项 2'] });
    const pre = parsed.nodes.find((n) => n.kind === 'pre');
    expect(pre).toEqual({ kind: 'pre', text: 'const x = 1;' });
  });
});
