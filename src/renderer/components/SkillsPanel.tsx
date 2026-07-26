import React, { useMemo, useState } from 'react';
import { useApp } from '../store';
import { Icon } from './Icon';
import type { SlashCommand } from '../../shared/rpc-types';

/** 把一条命令渲染成卡片（技能 / 插件通用）。 */
function CmdCard({ cmd }: { cmd: SlashCommand }): React.ReactElement {
  const aliases = cmd.aliases ?? [];
  const subs = cmd.subcommands ?? [];
  return (
    <div className="skill-item">
      <div className="skill-item-head">
        <span className="skill-name">/{cmd.name}</span>
        {aliases.length > 0 && (
          <span className="skill-aliases">
            {aliases.map((a) => (
              <span key={a} className="skill-alias">/{a}</span>
            ))}
          </span>
        )}
        {cmd.source && cmd.source !== 'builtin' && (
          <span className="skill-source">{cmd.source}</span>
        )}
      </div>
      {cmd.description && <div className="skill-desc">{cmd.description}</div>}
      {cmd.input?.hint && <div className="skill-hint">参数：{cmd.input.hint}</div>}
      {subs.length > 0 && (
        <div className="skill-subcommands">
          {subs.map((s) => (
            <div key={s.name} className="skill-sub">
              <span className="skill-sub-name">/{cmd.name} {s.name}</span>
              {s.description && <span className="skill-sub-desc">{s.description}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * SkillsPanel — 右侧主工作区视图（mainView==='skills'）。
 * 展示 omp 已安装的「技能」（source==='skill'）与「插件/扩展」
 * （非 builtin、非 skill 的来源，如 extension / custom / mcp__*），
 * 排除内置命令。数据来自 store.slashCommands
 * （启动时 available_commands_update 帧注入 + App 兜底 get_available_commands）。
 */
export const SkillsPanel: React.FC = () => {
  const cmds = useApp((s) => s.slashCommands);
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();

  const { skills, plugins, totalSkills, totalPlugins } = useMemo(() => {
    const match = (c: SlashCommand) => {
      if (!query) return true;
      const hay = `${c.name} ${(c.aliases ?? []).join(' ')} ${c.description ?? ''}`.toLowerCase();
      return hay.includes(query);
    };
    // 单次遍历分组，避免多次 filter（含 4 次全量扫描）
    const sk: SlashCommand[] = [];
    const pl: SlashCommand[] = [];
    let ts = 0;
    let tp = 0;
    for (const c of cmds) {
      const isSkill = c.source === 'skill';
      const isPlugin = !!c.source && c.source !== 'builtin' && c.source !== 'skill';
      if (isSkill) ts++;
      if (isPlugin) tp++;
      if (!match(c)) continue;
      if (isSkill) sk.push(c);
      else if (isPlugin) pl.push(c);
    }
    return { skills: sk, plugins: pl, totalSkills: ts, totalPlugins: tp };
  }, [cmds, query]);

  const back = () => useApp.getState().setMainView('chat');

  return (
    <div className="skills-view">
      <div className="skills-topbar">
        <div className="skills-title">
          <span className="skills-title-main">技能与插件</span>
          <span className="skills-title-sub">
            已安装技能 {totalSkills} · 插件/扩展 {totalPlugins}
          </span>
        </div>
        <button className="btn" onClick={back}>← 返回对话</button>
      </div>

      <div className="skills-body">
        <input
          type="text"
          className="skill-filter"
          autoFocus
          placeholder="筛选技能 / 插件（按名称、别名或描述）…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        <section className="skills-section">
          <div className="skills-section-title">
            <Icon name="skill" size={14} /> 技能 Skills <span className="skills-section-count">{skills.length}</span>
          </div>
          {skills.length === 0 ? (
            <div className="skills-empty">
              {totalSkills === 0
                ? 'omp 当前没有已安装的技能（Skills）。'
                : '没有匹配的技能。'}
            </div>
          ) : (
            <div className="skill-list">{skills.map((c) => <CmdCard key={c.name} cmd={c} />)}</div>
          )}
        </section>

        <section className="skills-section">
          <div className="skills-section-title">
            <Icon name="plug" size={14} /> 插件 / 扩展 Plugins <span className="skills-section-count">{plugins.length}</span>
          </div>
          {plugins.length === 0 ? (
            <div className="skills-empty">
              {totalPlugins === 0
                ? '没有额外的插件 / 扩展（仅有内置命令）。'
                : '没有匹配的插件 / 扩展。'}
            </div>
          ) : (
            <div className="skill-list">{plugins.map((c) => <CmdCard key={c.name} cmd={c} />)}</div>
          )}
        </section>

        {totalSkills === 0 && totalPlugins === 0 && (
          <div className="skills-empty skills-empty-hint">
            omp 尚未推送命令列表，请等待连接就绪或切换工作空间后重试。
          </div>
        )}
      </div>
    </div>
  );
};
