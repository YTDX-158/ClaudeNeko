import { useState, useEffect, useRef } from 'react';
import SessionList from './SessionList.jsx';
import { api } from '../api.js';
import { downloadText, exportSessionText } from '../utils/export.js';

/** 大数字格式化：123456 → 123K，1234567 → 1.2M（成本统计展示用） */
function fmtK(n) {
  if (!n) return '0';
  return n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

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
  onOpenTerminal,
  onRename,
  togglePin,
  removeMany,
  drawerOpen = false,
  onDrawerClose = () => {},
  onJumpResult,
}) {
  // 移动端：选中会话后自动收起抽屉（桌面无抽屉，onDrawerClose 空操作）
  // 同时清空搜索态：避免点击结果跳转后侧栏卡在搜索模式、回不到会话列表
  const selectSession = (id) => {
    setActiveId(id);
    setQuery('');
    setResults(null);
    setSearchError(false);
    setSearchDegraded(false);
    setSearchTruncated(false);
    onDrawerClose();
  };

  // 点搜索结果：清空搜索态 + 通知 App 切会话并定位目标气泡
  const jumpFromResult = (sessionId, messageIndex) => {
    setQuery('');
    setResults(null);
    setSearchError(false);
    setSearchDegraded(false);
    setSearchTruncated(false);
    onJumpResult?.(sessionId, messageIndex);
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

  // 批量导出（含思考跟随全局开关；单会话失败不整批丢弃，记名提示）
  const handleBatchExport = async () => {
    if (!selected.size) return;
    const includeThinking = localStorage.getItem('neko-export-thinking') === '1';
    const parts = [];
    const failed = [];
    for (const s of sessions.filter((s) => selected.has(s.id))) {
      try {
        const { messages } = await api.listMessages(s.id);
        parts.push(exportSessionText(s, messages, { includeThinking }));
      } catch {
        failed.push(s.title || s.id.slice(0, 8));
      }
    }
    if (parts.length) {
      const d = new Date();
      const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      downloadText(`ClaudeNeko-批量会话-${date}.txt`, parts.join('\n\n'));
    }
    if (failed.length) alert(`有 ${failed.length} 个会话导出失败：${failed.slice(0, 5).join('、')}${failed.length > 5 ? '…' : ''}`);
  };

  // 全局成本统计（v1.6.0）：sessions 内容变化时刷新（3s 轮询 sig 去重，无变化不重跑）
  const [stats, setStats] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.stats().then((d) => { if (!cancelled) setStats(d.totals); }).catch(() => {});
    return () => { cancelled = true; };
  }, [sessions]);

  // 搜索（v1.6.0）：标题 + 全文，debounce 300ms + 请求序号守卫（防旧请求覆盖新结果）
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null); // null = 未搜索
  const [searchError, setSearchError] = useState(false); // 搜索失败单独提示，不与"无结果"混淆
  const [searchDegraded, setSearchDegraded] = useState(false); // 多关键词 AND 无结果降级 OR
  const [searchTruncated, setSearchTruncated] = useState(false); // 结果超过上限被截断
  const searchTimer = useRef(null);
  const searchSeq = useRef(0); // 请求序号：只认最新一轮的结果
  const handleSearch = (e) => {
    const v = e.target.value;
    setQuery(v);
    setSearchError(false);
    clearTimeout(searchTimer.current);
    if (!v.trim()) {
      searchSeq.current++; // 失效在途请求：清空后旧结果不得写回
      setResults(null);
      setSearchDegraded(false);
      setSearchTruncated(false);
      return;
    }
    setResults(null); // 每次击键重置：防抖+请求期稳定显示"搜索中…"，旧结果不闪现
    const seq = ++searchSeq.current;
    searchTimer.current = setTimeout(async () => {
      try {
        const d = await api.search(v.trim());
        if (searchSeq.current === seq) {
          setResults(d.results);
          setSearchDegraded(d.degraded);
          setSearchTruncated(d.truncated);
        }
      } catch {
        if (searchSeq.current === seq) { setResults([]); setSearchError(true); }
      }
    }, 300);
  };
  // 卸载时清理防抖定时器 + 失效在途请求（Sidebar 常驻，仅整页关闭触发）
  useEffect(() => () => { clearTimeout(searchTimer.current); searchSeq.current++; }, []);
  const searchActive = query.trim().length > 0;

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

      <input
        className="search-input"
        type="text"
        placeholder="🔍 搜索内容，多关键词用空格隔开"
        value={query}
        onChange={handleSearch}
        title="搜索对话内容，多个关键词用空格隔开，点结果跳转到对应消息"
      />

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
        <div className="sidebar-sessions">
          {searchActive ? (
            searchError ? (
              <p className="hint">搜索失败，请重试</p>
            ) : results === null ? (
              <p className="hint">搜索中…</p>
            ) : results.length === 0 ? (
              <p className="hint">没有匹配结果</p>
            ) : (
              <>
                {searchDegraded && (
                  <p className="hint search-note">未找到同时包含全部关键词的，已显示任一匹配</p>
                )}
                {searchTruncated && (
                  <p className="hint search-note">结果较多，仅显示前 {results.length} 条</p>
                )}
                <div className="search-results">
                  {results.map((r) => (
                    <div
                      key={`${r.sessionId}-${r.messageIndex}`}
                      className="search-result"
                      onClick={() => jumpFromResult(r.sessionId, r.messageIndex)}
                      title={r.sessionTitle}
                    >
                      <div className="search-result-title">
                        {r.sessionTitle}
                        <span className="search-result-tag">{r.role === 'user' ? '你' : 'AI'}</span>
                        {r.matchedKeywords?.length > 1 && (
                          <span className="search-result-tag">{r.matchedKeywords.length} 词命中</span>
                        )}
                      </div>
                      {r.snippet && <div className="search-result-snippet">{r.snippet}</div>}
                    </div>
                  ))}
                </div>
              </>
            )
          ) : loading ? (
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
              onOpenTerminal={onOpenTerminal}
              manageMode={manageMode}
              selected={selected}
              onToggleSelected={toggleSelected}
            />
          )}
        </div>
      </div>

      {/* 全局成本统计小字（v1.6.0） */}
      {!manageMode && stats && stats.messages > 0 && (
        <div className="stats-bar" title="全部会话累计 token（v1.6.0 起统计；输入含记忆/历史上下文）">
          📊 ↑{fmtK(stats.input_tokens)} ↓{fmtK(stats.output_tokens)}
          {stats.thinking_tokens > 0 && ` 🧠${fmtK(stats.thinking_tokens)}`}
          <span className="stats-bar-sub">· {stats.messages} 条</span>
        </div>
      )}

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
