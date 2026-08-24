import { useState } from 'react';
import SessionList from './SessionList.jsx';
import { api } from '../api.js';
import { downloadText, exportSessionText } from '../utils/export.js';

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
  togglePin,
  removeMany,
  drawerOpen = false,
  onDrawerClose = () => {},
}) {
  // 移动端：选中会话后自动收起抽屉（桌面无抽屉，onDrawerClose 空操作）
  const selectSession = (id) => {
    setActiveId(id);
    onDrawerClose();
  };

  // 会话批量管理：多选模式 + 选中集合
  const [manageMode, setManageMode] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const enterManage = () => { setManageMode(true); setSelected(new Set()); };
  const exitManage = () => { setManageMode(false); setSelected(new Set()); };
  const toggleSelected = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => (prev.size === sessions.length ? new Set() : new Set(sessions.map((s) => s.id))));
  };

  // 批量删除（确认后执行，删除不可撤销）
  const handleBatchDelete = async () => {
    if (!selected.size) return;
    if (!window.confirm(`确定删除选中的 ${selected.size} 个会话？此操作不可撤销。`)) return;
    await removeMany([...selected]);
    exitManage();
  };

  // 批量导出（含思考跟随全局开关）
  const handleBatchExport = async () => {
    if (!selected.size) return;
    const includeThinking = localStorage.getItem('neko-export-thinking') === '1';
    try {
      const parts = [];
      for (const s of sessions.filter((s) => selected.has(s.id))) {
        const { messages } = await api.listMessages(s.id);
        parts.push(exportSessionText(s, messages, { includeThinking }));
      }
      const d = new Date();
      const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      downloadText(`ClaudeNeko-批量会话-${date}.txt`, parts.join('\n\n'));
    } catch {
      // 导出失败静默
    }
  };

  return (
    <aside className={`sidebar${drawerOpen ? ' drawer-open' : ''}`}>
      <div className="sidebar-header">
        <span className="logo">
          Claude<span className="logo-accent">Neko</span>
        </span>
        <div className="sidebar-header-actions">
          <button
            className={`icon-btn${manageMode ? ' active' : ''}`}
            title={manageMode ? '退出管理' : '批量管理会话（删除/导出）'}
            onClick={manageMode ? exitManage : enterManage}
          >
            {manageMode ? '✓' : '☑'}
          </button>
          <button className="icon-btn" title="外观与设置" onClick={onOpenSettings}>
            ⚙
          </button>
        </div>
      </div>

      <button className="new-btn-primary" title="新建会话" onClick={() => { onCreate(); onDrawerClose(); }}>
        ＋ 新建会话
      </button>

      <button className="media-nav-btn" title="媒体库（图片/视频/文档）" onClick={onOpenMedia}>
        🗂 媒体库
      </button>

      <div className="sidebar-scroll">
        <div className="section-label">
          {manageMode ? (
            <>
              <span>已选 {selected.size} 项</span>
              <button className="batch-select-all" onClick={toggleAll}>
                {selected.size === sessions.length ? '取消全选' : '全选'}
              </button>
            </>
          ) : (
            '会话'
          )}
        </div>
        <div className="session-list">
          {loading ? (
            <p className="hint">加载中…</p>
          ) : sessions.length === 0 ? (
            <p className="hint">还没有会话，点击上方「＋ 新建会话」</p>
          ) : (
            <SessionList
              sessions={sessions}
              activeId={activeId}
              onSelect={selectSession}
              onRemove={remove}
              onRename={onRename}
              onTogglePin={togglePin}
              manageMode={manageMode}
              selected={selected}
              onToggleSelected={toggleSelected}
            />
          )}
        </div>
      </div>

      {/* 批量管理操作条（管理模式下吸底显示） */}
      {manageMode && (
        <div className="batch-bar">
          <button className="batch-btn" onClick={handleBatchExport} disabled={selected.size === 0}>
            导出
          </button>
          <button className="batch-btn danger" onClick={handleBatchDelete} disabled={selected.size === 0}>
            删除
          </button>
          <button className="batch-btn" onClick={exitManage}>
            完成
          </button>
        </div>
      )}
    </aside>
  );
}
