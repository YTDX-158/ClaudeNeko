// server/lib/ptyHost.js — 常驻 claude TUI 进程管理（node-pty 多会话）
//
// 从 @inksnow/c2web (MIT) 的 pty-host.mjs 移植 + 扩展为多会话：
//   - 每个 Neko 会话一个常驻 pty（懒启动 + 空闲回收），聊天和终端都挂它
//   - 聊天发消息 = submit(text) 注入（文本 + 回车）
//   - 终端页 = write(d) 原始按键透传
//   - 空闲 30min / 服务退出时 taskkill 清理，避免 Windows 下孤儿残留
//
// 关键点：claude TUI（交互模式）与现有 -p 非交互模式是两条路，这里只管 TUI。
// node-pty 用 prebuild 预编译二进制，无需源码编译（win32-x64 已验证）。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// ESM 加载原生 CommonJS 模块（node-pty）必须用 createRequire
const require = createRequire(import.meta.url);

/** 尝试加载 node-pty；失败返回 null（调用方降级，不阻塞服务） */
let pty = null;
try {
  pty = require('node-pty');
} catch (e) {
  console.warn('[ptyHost] node-pty 加载失败，终端功能不可用:', e.message);
}

const IDLE_REAP_MS = 30 * 60 * 1000; // 空闲 30 分钟回收
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 30;

/**
 * 清洗传给 pty claude 的环境变量。
 * ⚠ 关键修复（8-26 P1 实测）：ClaudeNeko 在 claude 会话里运行时，process.env 继承了大量
 * CLAUDE* 变量（CHILD_SESSION/SESSION_ID/PID/CLAUDECODE/AI_AGENT 等）——若原样传给新 claude，
 * 它会被当成"子会话"，Transcript saving is off，**不写 jsonl** → transcript 永远探测不到，
 * 聊天/终端全断。必须清掉所有 CLAUDE*（含无下划线的 CLAUDECODE）+ AI_AGENT，让新 claude 独立。
 */
function cleanClaudeEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (/^CLAUDE/.test(k) || /^AI_AGENT$/.test(k)) {
      delete out[k];
    }
  }
  return out;
}

/**
 * 创建常驻 pty 管理器。
 * @param {{ claudeBin: string, onData?: (sid:string, data:string)=>void, onExit?: (sid:string, code:number)=>void }} opts
 */
export function createPtyHost({ claudeBin, onData, onExit }) {
  // sid -> { child, sessionId, lastActive }
  const ptys = new Map();

  /** Windows 下 taskkill 杀进程树（node-pty 的 child.kill 可能留孤儿） */
  function taskkill(pid) {
    try {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      k.on('error', () => { /* taskkill 缺失等，静默 */ });
    } catch {
      // 已退出
    }
  }

  /** 确保某会话有常驻 pty；没有则懒启动 */
  function ensure(sid, { cwd, claudeSessionId, model } = {}) {
    if (!pty) return { isNew: false, available: false };
    const existing = ptys.get(sid);
    if (existing) {
      existing.lastActive = Date.now();
      return { isNew: false, available: true };
    }
    // 启动 claude TUI：有会话则 --resume 续接，否则新会话
    const file = claudeBin && existsSync(claudeBin) ? claudeBin : 'claude.cmd';
    console.log(`[ptyHost] ensure sid=${sid} file=${file} resume=${claudeSessionId || '无'} cwd=${cwd}`);
    const args = [];
    if (claudeSessionId) args.push('--resume', claudeSessionId);
    if (model) args.push('--model', model);
    let child;
    try {
      const childEnv = cleanClaudeEnv(process.env);
      child = pty.spawn(file, args, {
        name: 'xterm-color',
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd: cwd || process.cwd(),
        env: childEnv,
      });
    } catch (e) {
      console.error(`[ptyHost] spawn 失败 sid=${sid}:`, e.message);
      return { isNew: false, available: false };
    }
    const rec = { child, lastActive: Date.now(), ready: false, outAcc: 0, pendingSubmits: [] };
    ptys.set(sid, rec);
    // M2 兜底：20s 内无论输出多少都强制就绪（防 claude 卡死/输出异常导致消息永久卡队列）
    setTimeout(() => {
      if (ptys.get(sid) !== rec || rec.ready) return;
      rec.ready = true;
      for (const t of rec.pendingSubmits.splice(0)) {
        try { rec.child.write(String(t)); rec.child.write('\r'); } catch { /* 已退出 */ }
      }
    }, 20000);
    child.onData((d) => {
      rec.lastActive = Date.now();
      rec.outAcc += d.length;
      // 就绪检测：claude TUI 首次绘制会输出足够内容（界面/提示符），累计 ~1KB 视为就绪
      if (!rec.ready && rec.outAcc > 1000) {
        rec.ready = true;
        // 就绪后补发积压的 submit（首次消息可能因启动慢被吞）
        for (const t of rec.pendingSubmits.splice(0)) {
          try { rec.child.write(String(t)); rec.child.write('\r'); } catch { /* 已退出 */ }
        }
      }
      onData?.(sid, d);
    });
    child.onExit(({ exitCode }) => {
      ptys.delete(sid);
      onExit?.(sid, exitCode);
    });
    return { isNew: true, available: true };
  }

  /** 注入整条指令（文本 + 回车），供聊天/终端「对话」视图用 */
  function submit(sid, text) {
    const rec = ptys.get(sid);
    if (!rec) return false;
    // M2：pty 未就绪（claude TUI 还在启动）→ 进队列，就绪后自动补发（防消息被吞）
    if (!rec.ready) {
      rec.pendingSubmits.push(String(text));
      rec.lastActive = Date.now(); // C1：排队发送也算活跃（用户在发消息）
      return true;
    }
    try {
      rec.child.write(String(text));
      rec.child.write('\r');
      rec.lastActive = Date.now(); // C1：注入成功刷新活跃时间（防空闲误回收）
      return true;
    } catch {
      return false;
    }
  }

  /** 原始按键透传（含 Esc 中断、方向键选择、Ctrl+C 等），终端视图用 */
  function write(sid, data) {
    const rec = ptys.get(sid);
    if (!rec) return false;
    try {
      rec.child.write(String(data));
      rec.lastActive = Date.now(); // C1：透传按键也算活跃（终端操作中防误回收）
      return true;
    } catch {
      return false;
    }
  }

  /** 终端尺寸变化 → 同步 pty，保证 TUI 不错位 */
  function resize(sid, cols, rows) {
    const rec = ptys.get(sid);
    if (!rec) return;
    try {
      rec.child.resize(cols || DEFAULT_COLS, rows || DEFAULT_ROWS);
      rec.lastActive = Date.now(); // C1：窗口调整也算活跃（防缩放间隙误回收）
    } catch {
      // 已退出
    }
  }

  /** Esc 中断当前生成（对应聊天「停止」按钮） */
  function interrupt(sid) {
    return write(sid, '\x1b');
  }

  /** 强杀某会话 pty（force-stop） */
  function kill(sid) {
    const rec = ptys.get(sid);
    if (!rec) return;
    taskkill(rec.child.pid);
    ptys.delete(sid);
  }

  /** 服务退出时清理全部 */
  function killAll() {
    for (const [sid, rec] of ptys) {
      taskkill(rec.child.pid);
    }
    ptys.clear();
  }

  function isRunning(sid) {
    return ptys.has(sid);
  }

  function touch(sid) {
    const rec = ptys.get(sid);
    if (rec) rec.lastActive = Date.now();
  }

  /** 空闲回收：遍历 Map，超过 idleMs 未活跃的 pty 杀掉（WS 断开后计时） */
  function scheduleIdleReap(idleMs = IDLE_REAP_MS) {
    setInterval(() => {
      const now = Date.now();
      for (const [sid, rec] of ptys) {
        if (now - rec.lastActive > idleMs) {
          console.log(`[ptyHost] 会话 ${sid} 空闲 ${Math.round(idleMs / 60000)} 分钟，回收 pty`);
          taskkill(rec.child.pid);
          ptys.delete(sid);
        }
      }
    }, 60 * 1000);
    // 防进程未退出（setInterval 不阻止进程退出）
  }

  return {
    ensure, submit, write, resize, interrupt, kill, killAll, isRunning, touch, scheduleIdleReap,
    get available() { return pty !== null; },
  };
}
