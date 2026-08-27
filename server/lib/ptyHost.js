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
const ENTER_DELAY_MS = 200; // 文本写入后延迟写回车：防 Windows ConPTY「背靠背吞回车」（8-27 修复）
const QUIET_READY_MS = 800; // 输出安静 800ms = claude 界面稳定，才算就绪（防启动滚动期误判）
const READY_SETTLE_MS = 300; // markReady（jsonl 信号）后再 settle：探测到 jsonl → 输入框激活
const INTERRUPT_SETTLE_MS = 600; // cancel 后冷却：等 claude 收尾回到输入态再注入（审查①，防新旧消息写同 jsonl 打架）

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
 * @param {{ claudeBin: string, bus?: object, onData?: (sid:string, data:string)=>void }} opts
 * 退出事件走 bus（'pty:exit'，Phase2 解耦）；onData 高频终端流保留直接回调。
 */
export function createPtyHost({ claudeBin, bus, onData }) {
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
    const rec = { child, lastActive: Date.now(), ready: false, outAcc: 0, pendingSubmits: [], quietTimer: null, lastInterruptAt: 0 };
    ptys.set(sid, rec);
    // M2 兜底：20s 内无论输出多少都强制就绪（防 claude 卡死/输出异常导致消息永久卡队列）
    setTimeout(() => {
      if (ptys.get(sid) !== rec) return;
      becomeReady(sid, rec, '20s兜底');
    }, 20000);
    child.onData((d) => {
      rec.lastActive = Date.now();
      rec.outAcc += d.length;
      // 就绪检测（8-27 修复）：仅「输出超 1KB」不可靠——claude 冷启动会先滚一大片
      // banner/历史，输入框还没激活。改成「输出超 1KB 且安静 800ms（输出停止=界面稳定）」
      // 才算就绪；另有 markReady（jsonl 信号）与 20s 兜底双保险。
      if (!rec.ready && rec.outAcc > 1000) {
        if (rec.quietTimer) clearTimeout(rec.quietTimer);
        rec.quietTimer = setTimeout(() => { rec.quietTimer = null; becomeReady(sid, rec, '输出安静'); }, QUIET_READY_MS);
      }
      onData?.(sid, d);
    });
    child.onExit(({ exitCode }) => {
      ptys.delete(sid);
      bus?.emit('pty:exit', { sid, exitCode });
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
    return doSubmit(rec, text);
  }

  /** 真正执行注入：文本写入（cancel 后延迟冷却），回车延迟 ENTER_DELAY_MS 再写。
   *  冷却语义（审查①）：cancel 发 Esc 后 claude 进程还在收尾，立即注入新消息会新旧
   *  写同 jsonl 打架 → cancel 后 INTERRUPT_SETTLE_MS 内提交先等 claude 回到输入态。 */
  function doSubmit(rec, text) {
    const sinceInterrupt = rec.lastInterruptAt ? Date.now() - rec.lastInterruptAt : Infinity;
    const wait = sinceInterrupt < INTERRUPT_SETTLE_MS ? INTERRUPT_SETTLE_MS - sinceInterrupt : 0;
    const go = () => {
      try {
        rec.child.write(String(text));
        rec.lastActive = Date.now(); // C1：注入成功刷新活跃时间（防空闲误回收）
        setTimeout(() => {
          try {
            rec.child.write('\r');
            rec.lastActive = Date.now();
          } catch { /* 已退出 */ }
        }, ENTER_DELAY_MS);
      } catch { /* 已退出 */ }
    };
    if (wait > 0) setTimeout(go, wait); else go();
    return true;
  }

  /** 就绪后补发积压的 submit（首次消息可能因启动慢被吞） */
  function flushPending(rec) {
    for (const t of rec.pendingSubmits.splice(0)) doSubmit(rec, t);
  }

  /** 置就绪（幂等）：任何可靠信号触发都走这里，统一补发积压消息 */
  function becomeReady(sid, rec, why) {
    if (rec.ready) return;
    console.log(`[ptyHost] 就绪 sid=${sid}（${why}）`);
    rec.ready = true;
    flushPending(rec);
  }

  /** 外部就绪信号：transcript 探测到 claude jsonl = 主程序真正起来（比 outAcc 可靠）。
   *  收到后再 settle READY_SETTLE_MS，给 TUI 画完输入框留时间。 */
  function markReady(sid) {
    const rec = ptys.get(sid);
    if (!rec || rec.ready) return;
    console.log(`[ptyHost] markReady sid=${sid}（jsonl 信号）`);
    setTimeout(() => {
      if (ptys.get(sid) === rec) becomeReady(sid, rec, 'jsonl信号');
    }, READY_SETTLE_MS);
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

  /** Esc 中断当前生成（对应聊天「停止」按钮）。记录时间供 submit 冷却（审查①） */
  function interrupt(sid) {
    const rec = ptys.get(sid);
    if (rec) rec.lastInterruptAt = Date.now();
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
    ensure, submit, markReady, write, resize, interrupt, kill, killAll, isRunning, touch, scheduleIdleReap,
    get available() { return pty !== null; },
  };
}
