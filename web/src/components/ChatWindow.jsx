import MessageList from './MessageList.jsx';
import Composer from './Composer.jsx';
import CatMascot from './CatMascot.jsx';

/**
 * 右侧聊天窗口：标题栏 + 消息流 + 输入区。
 */
export default function ChatWindow({ session, chat }) {
  return (
    <main className="chat">
      <header className="chat-header">
        <h1 className="chat-title">{session?.title ?? '新会话'}</h1>
        <div className="chat-tools">
          {session?.model && <span className="chat-model">{session.model}</span>}
        </div>
      </header>

      <MessageList messages={chat.messages} error={chat.error} />

      {/* 粒子猫猫（纯视觉点缀，输入框上方） */}
      <CatMascot />

      <Composer
        onSend={chat.send}
        streaming={chat.streaming}
        onStop={chat.stop}
        disabled={!session}
      />
    </main>
  );
}
