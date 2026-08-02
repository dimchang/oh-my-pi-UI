/**
 * omp-skills.test.ts — 技能管理回归测试：
 * - setSkillEnabled 只改 config.yml 的 skills.ignoredSkills，保留其它内容；
 * - uninstallSkill 把技能目录移到 skills-trash 并加入 ignoredSkills。
 * 通过 OMP_HOME 指向临时目录隔离真实配置（getAgentDir 读取 OMP_HOME）。
 */
import { describe, expect, it, beforeEach, afterEach, afterAll } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  listSkills,
  readSkillConfig,
  setSkillEnabled,
  uninstallSkill,
} from '../../electron/omp-skills';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-skills-test-'));
const agentDir = path.join(tmpRoot, 'agent');
const configPath = path.join(agentDir, 'config.yml');

beforeEach(() => {
  process.env.OMP_HOME = tmpRoot;
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    ['theme:', '  dark: titanium', 'skills:', '  ignoredSkills:', '    - quick-commit', ''].join('\n'),
    'utf8',
  );
});

afterEach(() => {
  delete process.env.OMP_HOME;
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('setSkillEnabled', () => {
  it('停用 = 追加到 ignoredSkills；启用 = 移除；保留其它配置', async () => {
    await setSkillEnabled('agentmail', false);
    const cfg = await readSkillConfig();
    expect(cfg.ignoredSkills).toContain('agentmail');
    expect(cfg.ignoredSkills).toContain('quick-commit');
    // 其它配置内容必须原样保留
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('dark: titanium');

    await setSkillEnabled('quick-commit', true);
    const cfg2 = await readSkillConfig();
    expect(cfg2.ignoredSkills).not.toContain('quick-commit');
    expect(fs.readFileSync(configPath, 'utf8')).toContain('dark: titanium');
  });

  it('技能名校验拒绝路径穿越', async () => {
    await expect(setSkillEnabled('../evil', false)).rejects.toThrow();
  });
});

describe('uninstallSkill', () => {
  it('把技能目录移到 skills-trash 并加入 ignoredSkills（防止副本重新被发现）', async () => {
    // 在 OMP_HOME 下造一个假技能根 ~/.agents/skills/foo
    const skillRoot = path.join(tmpRoot, '.agents', 'skills', 'foo');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '---\nname: foo\n---\n# Foo\n', 'utf8');

    try {
      const before = await listSkills();
      expect(before.some((s) => s.name === 'foo')).toBe(true);

      const res = await uninstallSkill('foo');
      expect(res.ok).toBe(true);
      expect(res.moved.length).toBeGreaterThan(0);

      // 目录已移出技能根
      expect(fs.existsSync(skillRoot)).toBe(false);
      // trash 里能找回
      const trashDir = path.join(agentDir, 'skills-trash');
      const movedName = fs.readdirSync(trashDir).find((d) => d.startsWith('foo-'));
      expect(movedName).toBeTruthy();
      // 加入 ignoredSkills
      const cfg = await readSkillConfig();
      expect(cfg.ignoredSkills).toContain('foo');
      // 列表不再包含
      const after = await listSkills();
      expect(after.some((s) => s.name === 'foo')).toBe(false);
    } finally {
      // noop
    }
  });
});
