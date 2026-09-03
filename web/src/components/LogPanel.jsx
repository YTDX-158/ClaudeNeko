/**
 * LogPanel.jsx — 日志面板（9-03）：设置页查看 server/log.txt 尾部
 *  - 显示最近 2000 行（后端读尾，已去 \r/截半行）
 *  - 自动刷新（4s）+ 手动刷新；内容没变不重渲（防闪烁/滚动跳）
 *  - 贴底才自动滚（用户上翻看历史不停）
 *  - 复制（剪贴板，本地 127.0.0.1 为 secure context）+ 下载完整（含 log.old 合并）
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export default function LogPanel({ open, onClose }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [copied, setCopied] = useState(false);
  const [auto, setAuto] = useState(true);
  const scrollRef = useRef(null);
  const lastTextRef = useRef('');
  const stickRef = useRef(true); // 是否贴底（用户上翻则停止自动滚）

  const load = async (silent) => {
    try {
      const r = await api.logLines(2000);
      // C（9-03）：按行首日期插分隔标题（哪段是哪天一目了然；纯文本，保持单 <pre> 轻渲染）
      let prevDay = '';
      const seg = [];
      for (const line of r.lines || []) {
        const m = line.match(/^\[(\d{4}-\d{2}-\d{2})/);
        const day = m ? m[1] : prevDay; // 旧日志行（无时间戳）归入当前段
        if (day && day !== prevDay) {
          seg.push(`════════════════  ${day}  ════════════════`);
          prevDay = day;
        }
        seg.push(line);
      }
      const t = seg.join('\n');
      if (t === lastTextRef.current) return; // 内容没变 → 不 setState 不重渲
      lastTextRef.current = t;
      setText(t);
      setStatus(`最近 ${r.lines.length} 行 · ${r.path || 'server/log.txt'}`);
    } catch {
      if (!silent) setStatus('日志读取失败（远程不可用或文件不存在）');
    }
  };

  // 打开拉一次 + 自动刷新；卸载清 interval（防泄漏）
  useEffect(() => {
    if (!open) return;
    stickRef.current = true;
    load(false);
    const iv = setInterval(() => { if (auto) load(true); }, 4000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, auto]);

  // 内容更新：贴底才自动滚到底（上翻看历史不被拽回）
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const copy = async () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
    try {
      await navigator.clipboard.writeText(text);
      done();
    } catch {
      // fallback：隐藏 textarea + execCommand
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch { /* 复制失败忽略 */ }
    }
  };

  if (!open) return null;
  return (
    <div className="skin-modal log-panel" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="log-panel-box">
        <div className="log-panel-head">
          <span className="log-panel-title">📋 ClaudeNeko 日志</span>
          <span className="log-panel-status">{status}</span>
          <div className="log-panel-btns">
            <button className="skin-btn" onClick={() => setAuto((a) => !a)}>{auto ? '⏸ 停自动' : '▶ 自动'}</button>
            <button className="skin-btn" onClick={() => load(false)}>🔄 刷新</button>
            <button className="skin-btn" onClick={copy}>{copied ? '✅ 已复制' : '📄 复制'}</button>
            <button className="skin-btn" onClick={() => api.logDownload().catch(() => {})}>⬇ 下载完整</button>
            <button className="skin-btn" onClick={onClose} aria-label="关闭">✕</button>
          </div>
        </div>
        <pre ref={scrollRef} className="log-panel-body" onScroll={onScroll}>{text}</pre>
      </div>
    </div>
  );
}
