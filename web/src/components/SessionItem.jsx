import { useState } from 'react';

/**
 * 会话「最近对话时间」格式化（updatedAt 毫秒时间戳）：
 *  - 1 分钟内 → 刚刚
 *  - 1 小时内 → N分钟前
 *  - 今天 → 今天 HH:MM；昨天 → 昨天 HH:MM
 *  - 今年内 → M月D日；跨年 → YYYY-M-D
 */
function formatRecentTime(ts) {
  if (!ts) return '';
  const now = new Date();
  const d = new Date(ts);
  const diffMin = Math.floor((now - d) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round((startToday - startDay) / 86400000);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (dayDiff === 0) return `今天 ${hhmm}`;
  if (dayDiff === 1) return `昨天 ${hhmm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * 单个会话项：点击切换 / 双击改名 / 悬浮删除（两次确认）/
 * 第二行右侧显示最近对话时间（悬浮看完整时间）。
 */
export default function SessionItem({ session, active, onSelect, onRemove, onRename }) {
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startEdit = (e) => {
    e.stopPropagation();
    setDraft(session.title || '新会话');
    setEditing(true);
  };

  const commit = () => {
    const t = draft.trim();
    setEditing(false);
    if (t && t !== session.title) onRename?.(session.id, t);
  };

  const cancel = () => setEditing(false);

  const handleDelete = (e) => {
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 2000);
      return;
    }
    onRemove(session.id);
  };

  const modelShort = (session.model ?? '').replace(/^deepseek-/, '');

  return (
    <li
      className={`session-item${active ? ' active' : ''}`}
      role="listitem"
      onClick={() => !editing && onSelect(session.id)}
    >
      <div className="session-item-main">
        {editing ? (
          <input
            className="session-item-rename"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') cancel();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="session-item-title" onDoubleClick={startEdit} title="双击重命名">
            {session.title || '新会话'}
          </span>
        )}
        <div className="session-item-sub">
          <span className="session-item-model">{modelShort}</span>
          <span
            className="session-item-time"
            title={session.updatedAt ? new Date(session.updatedAt).toLocaleString() : undefined}
          >
            {formatRecentTime(session.updatedAt)}
          </span>
        </div>
      </div>
      <button
        className="session-item-del"
        title={confirming ? '再点一次确认删除' : '删除会话'}
        onClick={handleDelete}
      >
        {confirming ? '确认？' : '×'}
      </button>
    </li>
  );
}
