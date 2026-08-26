import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { wsChannel } from '../ws.js';

/**
 * 终端视图（xterm 镜像常驻 claude TUI）
 * 全屏 overlay（复用 .skin-modal 范式），侧边栏「🖥 终端」按钮进入。
 * 键盘 → ws {t:'i'}；pty 原始流 → term.write；attach 回放当前屏。
 * 移动端触屏：底部控制键条（Esc/Enter/Ctrl+C/↑/↓/Tab/⟳刷新）。
 */

/** 常用控制键 → 实际发送给 pty 的字节序列 */
const KEY_SEQ = {
  esc: '\x1b',
  enter: '\r',
  ctrlc: '\x03',
  up: '\x1b[A',
  down: '\x1b[B',
  tab: '\t',
};

export default function TerminalView({ open, onClose, sessionId }) {
  const termRef = useRef(null); // 挂 xterm 的容器 div
  const termReadyRef = useRef(false);
  const termRefHolder = useRef(null); // 当前 xterm 实例

  useEffect(() => {
    if (!open || !sessionId || termReadyRef.current) return;
    const mount = termRef.current;
    if (!mount) return;
    termReadyRef.current = true;

    // 建 xterm 实例
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      theme: { background: '#1e1e2e', foreground: '#cdd6f4' },
    });
    termRefHolder.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mount);
    fit.fit();

    // 键盘 → pty
    term.onData((d) => wsChannel.send({ t: 'i', d }));

    // 订阅终端流
    const unsub = wsChannel.subscribe(sessionId, {
      onTermData: (d) => term.write(d),
      onTermReplay: (d) => {
        term.reset();
        term.write(d);
      },
    });

    // 连接 + attach
    wsChannel.connect(sessionId);
    wsChannel.attach();

    // 尺寸变化 → fit + 同步 pty。
    // ⚠ 卡顿修复：不再用 ResizeObserver 观察容器（fit.fit() 会改 xterm 尺寸 → 反触发 RO → 循环，
    // 每次循环都 send resize → claude TUI 全量重绘 → 输入卡顿）。只监听 window resize + 防抖。
    let resizeTimer = null;
    const doResize = () => {
      try {
        fit.fit();
        wsChannel.send({ t: 'r', c: term.cols, r: term.rows });
      } catch {
        // 容器未就绪
      }
    };
    const onWinResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doResize, 200); // 防抖：窗口连续变化只同步一次
    };
    window.addEventListener('resize', onWinResize);
    setTimeout(doResize, 100); // 打开后做一次初始 fit

    return () => {
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onWinResize);
      wsChannel.detach();
      unsub();
      term.dispose();
      termReadyRef.current = false;
      termRefHolder.current = null;
    };
  }, [open, sessionId]);

  // Esc 关闭终端页（注意：只在终端页打开时生效；终端内部的中断走键盘条「Esc 中断」）
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // M15：焦点在终端输入区（xterm）时，Esc 只转发 pty（中断生成），不关页；
      // 焦点在外（点标题栏/空白）时 Esc 才关闭终端页
      const inTerm = document.activeElement?.closest?.('.xterm');
      if (inTerm) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 未打开 → 不渲染（否则全屏 overlay 永远盖住聊天页，切不回去）
  if (!open) return null;

  // 控制键条点击
  const pressKey = (key) => {
    wsChannel.send({ t: 'i', d: KEY_SEQ[key] });
  };

  // 刷新终端：清屏 + 重订阅 + 抖动尺寸逼 TUI 全量重绘
  const refreshTerm = () => {
    const term = termRefHolder.current;
    if (!term) return;
    term.reset();
    wsChannel.attach();
    wsChannel.send({ t: 'r', c: term.cols, r: Math.max(2, term.rows - 1) });
    setTimeout(() => wsChannel.send({ t: 'r', c: term.cols, r: term.rows }), 120);
    term.focus();
  };

  return (
    <div className="skin-modal">
      <div className="terminal-box">
        <div className="terminal-header">
          <button className="terminal-back" onClick={onClose} title="返回聊天（Esc）">
            ← 返回聊天
          </button>
          <span className="terminal-title">🖥 终端（常驻 claude TUI）</span>
          <span className="terminal-session">会话 {String(sessionId ?? '').slice(0, 8)}…</span>
          <button className="terminal-close" onClick={onClose} title="关闭终端（Esc）">✕</button>
        </div>
        <div ref={termRef} className="terminal-wrap" />
        <div className="terminal-keys">
          <button className="termkey" onClick={() => pressKey('esc')}>Esc 中断</button>
          <button className="termkey" onClick={() => pressKey('enter')}>Enter</button>
          <button className="termkey" onClick={() => pressKey('ctrlc')}>Ctrl+C</button>
          <button className="termkey" onClick={() => pressKey('up')}>↑</button>
          <button className="termkey" onClick={() => pressKey('down')}>↓</button>
          <button className="termkey" onClick={() => pressKey('tab')}>Tab</button>
          <button className="termkey term-refresh" onClick={refreshTerm}>⟳ 刷新</button>
        </div>
      </div>
    </div>
  );
}
