import { useState } from 'react';

/**
 * SkillBar.jsx — 输入框下方技能包（生图 / 生视频 / 下载视频）
 * 选中技能 → 显示对应选项条；未配 key 显示引导；时长选项跟随所选模型。
 * 可用性由后端运行时判定（未开通模型点了给明确提示），这里不写死灰显。
 */
const SKILLS = [
  { id: 'image', label: '🎨 生图' },
  { id: 'video', label: '🎬 生视频' },
  { id: 'download', label: '⬇️ 下载视频' },
];

export default function SkillBar({ skill, onSkillChange, opts, onOptsChange, mediaCfg }) {
  const modelList = skill === 'image' ? mediaCfg?.imageModels || [] : mediaCfg?.videoModels || [];
  const curModel = modelList.find((m) => m.id === opts.model) || null;
  const set = (patch) => onOptsChange({ ...opts, ...patch });

  return (
    <div className="skillbar">
      <div className="skillbar-row">
        {SKILLS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`skill-btn${skill === s.id ? ' active' : ''}`}
            onClick={() => onSkillChange(skill === s.id ? null : s.id)}
            title={s.label}
          >
            {s.label}
          </button>
        ))}
      </div>

      {skill && !mediaCfg?.hasKey && (
        <div className="skillbar-hint">
          ⚠️ 未配置生成 key（DOUBAO_API_KEY / VISION_API_KEY），到 ~/.claude/settings.json 的 env 配置后刷新即可
        </div>
      )}

      {skill === 'image' && (
        <div className="skillbar-opts">
          <select value={opts.model} onChange={(e) => set({ model: e.target.value })}>
            {modelList.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <select value={opts.ratio} onChange={(e) => set({ ratio: e.target.value })}>
            {mediaCfg?.ratios?.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select value={opts.resolution || '2K'} onChange={(e) => set({ resolution: e.target.value })}>
            {(mediaCfg?.imageResolutions || [{ id: '2K', label: '2K' }, { id: '3K', label: '3K' }, { id: '4K', label: '4K' }]).map(
              (r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                  {r.id !== '2K' ? '（更慢更贵）' : ''}
                </option>
              ),
            )}
          </select>
        </div>
      )}

      {skill === 'video' && (
        <div className="skillbar-opts">
          <select
            value={opts.model}
            onChange={(e) => set({ model: e.target.value, duration: undefined })}
          >
            {modelList.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <select value={opts.ratio} onChange={(e) => set({ ratio: e.target.value })}>
            {mediaCfg?.ratios?.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          {curModel?.durations?.length > 0 && (
            <select
              value={opts.duration ?? curModel.durations[0]}
              onChange={(e) => set({ duration: Number(e.target.value) })}
            >
              {curModel.durations.map((d) => (
                <option key={d} value={d}>
                  {d}s
                </option>
              ))}
            </select>
          )}
          {curModel?.resolutions?.length > 0 && (
            <select value={opts.resolution || '720P'} onChange={(e) => set({ resolution: e.target.value })}>
              {curModel.resolutions.map((r) => (
                <option key={r} value={r}>
                  {r}
                  {r === '720P' ? '（更清晰）' : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {skill === 'download' && (
        <div className="skillbar-opts">
          <input
            className="skillbar-url"
            placeholder="粘贴视频链接…"
            value={opts.url || ''}
            onChange={(e) => set({ url: e.target.value })}
          />
          <label className="skillbar-check">
            <input
              type="checkbox"
              checked={!!opts.transcribe}
              onChange={(e) => set({ transcribe: e.target.checked })}
            />
            下载后转录文案
          </label>
        </div>
      )}
    </div>
  );
}
