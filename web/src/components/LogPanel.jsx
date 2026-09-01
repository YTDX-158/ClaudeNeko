import { useEffect, useState } from 'react';

/**
 * LogPanel.jsx — 台账视图（8-31，媒体库的「台账」tab）
 * 展示生成记录（时间/类型/模型/提示词全文/参数/结果），支持记录开关、批量勾选删除（只删记录 / 删记录+文件）、清空全部。
 * 走 /api/media/log（GET 列表 / DELETE 删除 / PUT log-enabled 开关）。
 */
export default function LogPanel() {
  const [enabled, setEnabled] = useState(true);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(new Set());

  const refresh = () => {
    setLoading(true);
    fetch('/api/media/log')
      .then((r) => r.json())
      .then((d) => {
        setEnabled(d.enabled ?? true);
        setRecords(d.records || []);
      })
      .catch(() => { setEnabled(true); setRecords([]); })
      .finally(() => setLoading(false));
  };
  useEffect(() => { refresh(); }, []);

  const toggleEnabled = async () => {
    const next = !enabled;
    setEnabled(next);
    try {
      await fetch('/api/media/log-enabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
    } catch { /* 静默 */ }
  };

  const toggleSelected = (id) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => (prev.size === records.length ? new Set() : new Set(records.map((r) => r.id))));
  };

  const handleDelete = async (delFile) => {
    if (!selected.size) return;
    const label = delFile ? '删除记录+对应文件' : '删除记录';
    if (!window.confirm(`确定${label}（${selected.size} 条）？${delFile ? '对应媒体文件也会删除，不可恢复！' : '仅删除记录，媒体文件保留。'}`)) return;
    try {
      await fetch('/api/media/log', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected], delFile }),
      });
    } catch { /* 静默 */ }
    setSelected(new Set());
    refresh();
  };
  const handleClear = async () => {
    if (!records.length) return;
    if (!window.confirm('确定清空全部台账记录？此操作不可恢复。')) return;
    try {
      await fetch('/api/media/log', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
    } catch { /* 静默 */ }
    setSelected(new Set());
    refresh();
  };

  return (
    <div className="media-log-panel">
      <div className="media-log-toolbar">
        <label className="media-log-toggle" title="关闭后不再记录新的生成，历史记录保留">
          <input type="checkbox" checked={enabled} onChange={toggleEnabled} />
          记录生成日志
        </label>
        <span className="skin-hint">共 {records.length} 条{records.length >= 5000 ? '（已达软上限，建议清理）' : ''}</span>
        <button className="skin-btn danger" onClick={handleClear} disabled={!records.length}>清空全部</button>
      </div>

      <div className="media-log-list">
        {loading && <div className="skin-hint">加载中…</div>}
        {!loading && records.length === 0 && (
          <div className="skin-hint">暂无台账记录（生成图片/视频后自动记录，可关）</div>
        )}
        {!loading &&
          records.map((r) => (
            <div
              key={r.id}
              className={`media-log-item${selected.has(r.id) ? ' selected' : ''}`}
              onClick={() => toggleSelected(r.id)}
            >
              <input type="checkbox" checked={selected.has(r.id)} readOnly />
              <div className="media-log-item-info">
                <div className="media-log-item-top">
                  <span className="media-log-type">{r.type === 'image' ? '🖼' : '🎬'}</span>
                  <span className="media-log-model" title={r.model}>{r.model}</span>
                  <span className={`media-log-result ${r.result}`}>{r.result === 'success' ? '成功' : '失败'}</span>
                  <span className="media-log-time">{new Date(r.time).toLocaleString()}</span>
                </div>
                <div className="media-log-prompt" title={r.prompt}>{r.prompt || '（无提示词）'}</div>
                <div className="media-log-params">
                  分辨率 {r.resolution || '-'} · 时长 {r.duration ? `${r.duration}s` : '-'} · 比例 {r.ratio || '-'}
                  {r.sizeMb ? ` · ${r.sizeMb}MB` : ''}
                  {r.mediaId ? ' · 文件在库' : r.result === 'success' ? ' · 文件已清' : ''}
                  {r.error ? ` · ${r.error}` : ''}
                </div>
              </div>
            </div>
          ))}
      </div>

      {selected.size > 0 && (
        <div className="media-batch-bar">
          <span className="media-batch-info">已选 {selected.size} 条</span>
          <button className="batch-btn" onClick={toggleAll}>
            {selected.size === records.length ? '取消全选' : '全选'}
          </button>
          <button className="batch-btn" onClick={() => handleDelete(false)} disabled={!selected.size}>
            删记录
          </button>
          <button className="batch-btn danger" onClick={() => handleDelete(true)} disabled={!selected.size}>
            删记录+文件
          </button>
        </div>
      )}
    </div>
  );
}
