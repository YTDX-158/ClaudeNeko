import { useState } from 'react';

/**
 * 单个会话项：
 *  - 点击切换（左侧竖条高亮当前）
 *  - 双击标题重命名（Enter/失焦保存，Esc 取消）
 *  - 悬浮显示删除（两次点击确认）
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
        <span className="session-item-model">{modelShort}</span>
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
