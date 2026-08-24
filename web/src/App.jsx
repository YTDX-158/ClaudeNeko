import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useSessions } from './hooks/useSessions.js';
import { useChatStream } from './hooks/useChatStream.js';
import Sidebar from './components/Sidebar.jsx';
import ChatWindow from './components/ChatWindow.jsx';
import SkinSettings from './skin/SkinSettings.jsx';
import FluidCanvas from './skin/FluidCanvas.jsx';
import MediaLibrary from './components/MediaLibrary.jsx';
import { readDefaultEffort } from './utils/effort.js';

export default function App() {
  const sessions = useSessions();
  const { activeId, activeSession, create, patch, updateLocalTitle, updateLocalModel } = sessions;

  const [serverOk, setServerOk] = useState(null);
  const [skinOpen, setSkinOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
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
    (sid, title) => updateLocalTitle(sid, title),
    (sid, model) => updateLocalModel(sid, model),
  );

  const handleCreate = () => {
    // 方案C：新建时后端自动清理所有空会话，前端直接创建即可
    // 模型不传：由 CC Switch 在系统层切换，claude CLI 用系统默认模型
    // 思考档位：带全局默认档（localStorage 设置，省/标准/强力）
    create(undefined, readDefaultEffort());
  };

  // 分支：从某条 AI 回复新建会话（后端复制其之前历史），成功后切到新会话
  const handleBranch = async (message) => {
    if (!activeId || !message?.claudeMessageId) return;
    const { session } = await api.createBranch(activeId, message.claudeMessageId);
    // 新会话插到列表头部并激活
    sessions.setActiveId(session.id);
    await sessions.refresh();
  };

  return (
    <div className="app">
      {/* WebGL 流体背景（设为「流体」壁纸时生效） */}
      <FluidCanvas />
      {/* 移动端汉堡按钮：窄屏展开侧栏抽屉；宽屏隐藏（display:none） */}
      <button
        className="mobile-menu-btn"
        aria-label="打开侧栏"
        onClick={() => setSidebarOpen(true)}
      >
        ☰
      </button>
      {/* 移动端侧栏遮罩：抽屉开着时点空白收起 */}
      {sidebarOpen && (
        <div className="sidebar-scrim" onClick={closeSidebar} />
      )}
      <Sidebar
        {...sessions}
        onCreate={() => { handleCreate(); closeSidebar(); }}
        onOpenSettings={() => setSkinOpen(true)}
        onOpenMedia={() => setMediaOpen(true)}
        onRename={(id, title) => patch(id, { title })}
        drawerOpen={sidebarOpen}
        onDrawerClose={closeSidebar}
      />
      <ChatWindow
        session={activeSession}
        chat={chat}
        onRename={(title) => activeId && patch(activeId, { title })}
        onBranch={handleBranch}
        onEffortChange={(effort) => activeId && patch(activeId, { effort }).catch(() => {})}
        onClickCapture={closeSidebar}
      />
      {serverOk === false && (
        <div className="banner" role="alert">
          无法连接后端（127.0.0.1:4000）——请双击桌面「启动ClaudeNeko.bat」启动服务
        </div>
      )}
      <SkinSettings open={skinOpen} onClose={() => setSkinOpen(false)} />
      <MediaLibrary open={mediaOpen} onClose={() => setMediaOpen(false)} />
    </div>
  );
}
