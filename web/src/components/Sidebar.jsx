import SessionList from './SessionList.jsx';

/**
 * 左侧栏（信息架构重构，借鉴 DSH 分层思路）：
 *   header      → 品牌 + 设置入口（⚙ 全局配置，置顶）
 *   主按钮      → ＋ 新建会话（主操作，显眼全宽）
 *   sidebar-scroll → 会话列表（内容区，独立滚动）
 *   （模型切换已移除：由 CC Switch 在系统层切换，claude CLI 用系统默认模型）
 */
export default function Sidebar({
  sessions,
  activeId,
  loading,
  onCreate,
  remove,
  setActiveId,
  onOpenSettings,
  onOpenMedia,
  onRename,
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="logo">
          Claude<span className="logo-accent">Neko</span>
        </span>
        <button className="icon-btn" title="外观与设置" onClick={onOpenSettings}>
          ⚙
        </button>
      </div>

      <button className="new-btn-primary" title="新建会话" onClick={onCreate}>
        ＋ 新建会话
      </button>

      <button className="media-nav-btn" title="媒体库（图片/视频/文档）" onClick={onOpenMedia}>
        🗂 媒体库
      </button>

      <div className="sidebar-scroll">
        <div className="section-label">会话</div>
        <div className="session-list">
          {loading ? (
            <p className="hint">加载中…</p>
          ) : sessions.length === 0 ? (
            <p className="hint">还没有会话，点击上方「＋ 新建会话」</p>
          ) : (
            <SessionList
              sessions={sessions}
              activeId={activeId}
              onSelect={setActiveId}
              onRemove={remove}
              onRename={onRename}
            />
          )}
        </div>
      </div>
    </aside>
  );
}
