import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useSessions } from './hooks/useSessions.js';
import { useChatStream } from './hooks/useChatStream.js';
import Sidebar from './components/Sidebar.jsx';
import ChatWindow from './components/ChatWindow.jsx';
import SkinSettings from './skin/SkinSettings.jsx';
import FluidCanvas from './skin/FluidCanvas.jsx';

export default function App() {
  const sessions = useSessions();
  const { activeId, activeSession, create, patch, updateLocalTitle, updateLocalModel } = sessions;

  const [serverOk, setServerOk] = useState(null);
  const [skinOpen, setSkinOpen] = useState(false);

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
    create();
  };

  return (
    <div className="app">
      {/* WebGL 流体背景（设为「流体」壁纸时生效） */}
      <FluidCanvas />
      <Sidebar
        {...sessions}
        onCreate={handleCreate}
        onOpenSettings={() => setSkinOpen(true)}
        onRename={(id, title) => patch(id, { title })}
      />
      <ChatWindow
        session={activeSession}
        chat={chat}
        onRename={(title) => activeId && patch(activeId, { title })}
      />
      {serverOk === false && (
        <div className="banner" role="alert">
          无法连接后端（127.0.0.1:4000）——请双击桌面「启动ClaudeNeko.bat」启动服务
        </div>
      )}
      <SkinSettings open={skinOpen} onClose={() => setSkinOpen(false)} />
    </div>
  );
}
