import { lazy, Suspense, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';
import { useSessions } from './hooks/useSessions.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { useChatStream } from './hooks/useChatStream.js';
import Sidebar from './components/Sidebar.jsx';
import ChatWindow from './components/ChatWindow.jsx';
// 懒加载「打开才用」的大组件（瘦身：终端 xterm / 设置 / 媒体库 不进首屏，点开才下载）
const SkinSettings = lazy(() => import('./skin/SkinSettings.jsx'));
import FluidCanvas from './skin/FluidCanvas.jsx';
const MediaLibrary = lazy(() => import('./components/MediaLibrary.jsx'));
const TerminalView = lazy(() => import('./components/TerminalView.jsx'));
import { readDefaultEffort } from './utils/effort.js';

export default function App() {
  const sessions = useSessions();
  const { activeId, activeSession, create, patch, updateLocalModel } = sessions;

  const [serverOk, setServerOk] = useState(null);
  const [skinOpen, setSkinOpen] = useState(false);
  // 全局当前模型（右上角显示用）：改模型是全局的（写 env），显示也全局统一，不跟会话走
  const [globalModel, setGlobalModel] = useState(null);
  // 对话模型是否已配置（null=未知/加载中）：未配置 → 顶栏提示先去设置配（引导，不硬拦）
  const [configured, setConfigured] = useState(null);
  const refreshModel = useCallback(() => {
    api.getConfig().then((r) => {
      setGlobalModel(r.model || null);
      setConfigured(!!r.configured);
    }).catch(() => {});
  }, []);
  useEffect(() => { refreshModel(); }, [refreshModel]);
  // 预启动（9-02）：切到会话 → 后台拉起 claude pty（发消息时已就绪，首条不等 20-40s 冷启动）
  useEffect(() => {
    if (activeId) api.prewarmSession(activeId).catch(() => {});
  }, [activeId]);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false); // 终端页（c2web 模式）
  const [terminalSessionId, setTerminalSessionId] = useState(null); // 打开终端的会话 id（每个会话独立入口）
  // 搜索跳转目标：Sidebar 点搜索结果 → 切会话 + 定位到目标消息气泡（ChatWindow 消费后清除）
  const [jumpTarget, setJumpTarget] = useState(null);
  const handleJumpResult = (sessionId, messageIndex) => {
    sessions.setActiveId(sessionId);
    setJumpTarget({ sessionId, messageIndex });
  };
  // 移动端侧栏抽屉开关（窄屏默认收起，点汉堡展开；宽屏无感）
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = () => setSidebarOpen(false);

  useEffect(() => {
    const check = () => {
      api
        .health()
        .then(() => setServerOk(true))
        .catch(() => setServerOk(false));
    };
    check();
    // 切回本页时重新检测，服务后启动/恢复时横幅自动消失
    const onVisible = () => {
      if (!document.hidden) check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const chat = useChatStream(
    activeId,
    (sid, model) => updateLocalModel(sid, model),
  );

  const handleCreate = () => {
    // 方案C：新建时后端自动清理所有空会话，前端直接创建即可
    // 模型不传：由 CC Switch 在系统层切换，claude CLI 用系统默认模型
    // 思考档位：带全局默认档（localStorage 设置，省/标准/强力）
    create(undefined, readDefaultEffort());
  };

  // 分支：从某条 AI 回复新建会话（后端复制其之前历史），成功后切到新会话
  // useCallback（审查⑦）：稳定回调引用，MessageBubble 的 memo 才生效（不因父重渲染全量重建）
  const handleBranch = useCallback(async (message) => {
    if (!activeId || !message?.claudeMessageId) return;
    const { session } = await api.createBranch(activeId, message.claudeMessageId);
    // 新会话插到列表头部并激活
    sessions.setActiveId(session.id);
    await sessions.refresh();
  }, [activeId, sessions]);

  return (
    <div className="app">
      {/* WebGL 流体背景（设为「流体」壁纸时生效） */}
      <FluidCanvas />
      {/* 移动端汉堡按钮：窄屏切换侧栏抽屉（开=✕ 可关）；宽屏隐藏（display:none） */}
      <button
        className="mobile-menu-btn"
        aria-label={sidebarOpen ? '关闭侧栏' : '打开侧栏'}
        onClick={() => setSidebarOpen((v) => !v)}
      >
        {sidebarOpen ? '✕' : '☰'}
      </button>
      {/* 移动端侧栏遮罩：抽屉开着时点空白收起 */}
      {sidebarOpen && (
        <div className="sidebar-scrim" onClick={closeSidebar} />
      )}
      <Sidebar
        {...sessions}
        onCreate={() => { handleCreate(); closeSidebar(); }}
        onOpenSettings={() => { setSkinOpen(true); closeSidebar(); }}
        onOpenMedia={() => { setMediaOpen(true); closeSidebar(); }}
        onOpenTerminal={(sid) => { setTerminalSessionId(sid); setTerminalOpen(true); closeSidebar(); }}
        onRename={(id, title) => patch(id, { title })}
        drawerOpen={sidebarOpen}
        onDrawerClose={closeSidebar}
        onJumpResult={handleJumpResult}
      />
      <ChatWindow
        session={activeSession}
        model={globalModel}
        chat={chat}
        onBranch={handleBranch}
        onEffortChange={(effort) => activeId && patch(activeId, { effort }).catch(() => {})}
        jumpTarget={jumpTarget}
        onJumpDone={() => setJumpTarget(null)}
      />
      {serverOk === false && (
        <div className="banner" role="alert">
          无法连接后端（127.0.0.1:4000）——请双击桌面「启动ClaudeNeko.bat」启动服务
        </div>
      )}
      {serverOk !== false && configured === false && (
        <div className="banner" role="alert">
          ⚠️ 未检测到对话模型配置——请先到
          <button className="banner-link" onClick={() => { setSkinOpen(true); closeSidebar(); }}>设置→模型配置</button>
          填写后再使用
        </div>
      )}
      <ErrorBoundary>
        <Suspense fallback={null}>
          <SkinSettings open={skinOpen} onClose={() => setSkinOpen(false)} onModelChanged={refreshModel} />
          <MediaLibrary open={mediaOpen} onClose={() => setMediaOpen(false)} />
          <TerminalView open={terminalOpen} onClose={() => setTerminalOpen(false)} sessionId={terminalSessionId} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
