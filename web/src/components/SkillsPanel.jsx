import { useEffect, useState } from 'react';

/**
 * SkillsPanel.jsx — 已装 Skills 查看面板（只读）
 * 从 /api/skills 拉取 ~/.claude/skills/ 等位置的所有 skills，卡片列表 + 点开看 SKILL.md 详情。
 */
export default function SkillsPanel({ open, onClose }) {
  const [skills, setSkills] = useState([]);
  const [expanded, setExpanded] = useState(null); // 当前展开的 skill 名
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch('/api/skills')
      .then((r) => r.json())
      .then((d) => setSkills(d.skills || []))
      .catch(() => setSkills([]))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  return (
    <div className="skin-modal" onClick={onClose}>
      <div className="skin-modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="skin-modal-header">
          <span className="skin-modal-title">已装 Skills（{skills.length}）</span>
          <button className="skin-close" onClick={onClose} title="关闭">✕</button>
        </div>

        <div className="skills-panel">
          {loading && <div className="skin-hint">加载中…</div>}
          {!loading && skills.length === 0 && <div className="skin-hint">暂无已装 Skills</div>}

          {!loading &&
            skills.map((s) => (
              <div
                key={s.name}
                className={`skill-card${expanded === s.name ? ' expanded' : ''}`}
                onClick={() => setExpanded(expanded === s.name ? null : s.name)}
                title="点击查看详情"
              >
                <div className="skill-card-head">
                  <span className="skill-card-name">{s.name}</span>
                  {s.description && <span className="skill-card-desc">{s.description}</span>}
                </div>
                {expanded === s.name && (
                  <pre className="skill-card-body">{s.body}</pre>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
