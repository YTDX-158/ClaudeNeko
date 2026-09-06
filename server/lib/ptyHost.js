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
import { logger } from './logger.js';
import { buildClaudeArgs } from './claudeLaunch.js';

// ESM 加载原生 CommonJS 模块（node-pty）必须用 createRequire
const require = createRequire(import.meta.url);

/** 同步 sleep（Atomics.wait 短暂阻塞事件循环；仅 force-stop 等低频操作用） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 尝试加载 node-pty；失败返回 null（调用方降级，不阻塞服务） */
let pty = null;
try {
  pty = require('node-pty');
} catch (e) {
  logger.warn('ptyHost', 'node-pty 加载失败，终端功能不可用:', e.message);
}

const IDLE_REAP_MS = 30 * 60 * 1000; // 空闲 30 分钟回收
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 30;
const MIN_COLS = 50; // 列宽下钳（8-29 单色+c 源头根治）：claude Ink 在窄列（手机 attach ~40列）渲染崩溃只输出"C"，
                     // 手机 attach 的窄列必须钳到安全宽度；桌面正常宽度（≥120）不受影响，极窄窗口轻微折行可接受
const MIN_ROWS = 5;
// —— force-stop 并发写防护（8-29 审查剩余项修复） ——
// taskkill 是异步的，旧 claude 进程可能短暂残留写 jsonl；若 force-stop 后立即重开同会话，
// 新 pty resume 同 jsonl → 新旧并发写可能损坏文件。kill 时同步轮询确认旧进程退出后再放行新 pty。
const KILL_CONFIRM_MS = 2000; // 确认旧进程退出上限
const KILL_POLL_MS = 100; // 轮询间隔
const ENTER_DELAY_MS = 200; // 文本写入后延迟写回车：防 Windows ConPTY「背靠背吞回车」（8-27 修复）
// —— 9-03 长文本分块写入（根治 ConPTY 单次写入 >~1024 字符丢前段，实证：T1200 丢前 1024 剩后 176） ——
const DIRECT_LEN = 900;     // 短文本直接单次写（T900 实测完整，<1024 安全区；≤此值不启用分块，保持原语义）
const WRITE_CHUNK = 500;    // 分块大小（保守 <1024，双保险）
const CHUNK_DELAY_MS = 50;  // 块间延迟：让 ConPTY 缓冲落稳（claude 消费跟上，防积压再溢出）
const QUIET_READY_MS = 800; // 输出安静 800ms = claude 界面稳定，才算就绪（防启动滚动期误判）
const READY_SETTLE_MS = 300; // markReady（jsonl 信号）后再 settle：探测到 jsonl → 输入框激活
const INTERRUPT_SETTLE_MS = 600; // cancel 后冷却：等 claude 收尾回到输入态再注入（审查①，防新旧消息写同 jsonl 打架）
// —— 9-02 就绪主信号 + 确认送达（首条消息被吞修复） ——
const MARKER_SETTLE_MS = 200;    // bracket 标记（ESC[?2004h）后 settle：取证 marker 746ms / 输入框 820ms（差仅 74ms）
const MARKER_BUF_LEN = 300;      // marker 检测缓冲：保留最近 300 字节查 \x1b[?2004h（防跨 chunk 切开）
const CONFIRM_TIMEOUT_MS = 6000; // 确认送达超时：6s 未在 jsonl 确认 → 重发
const CONFIRM_MAX_RETRY = 2;     // 重发上限（防无限重发）

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

  /** 确保某会话有常驻 pty；没有则懒启动
   *  @param {string} [permissionMode] 权限档 ask|smart|bypass（缺省不传 = 跟随 claude 全局 settings，兼容旧行为） */
  function ensure(sid, { cwd, claudeSessionId, isNewClaudeSession, model, permissionMode } = {}) {
    if (!pty) return { isNew: false, available: false };
    const existing = ptys.get(sid);
    if (existing) {
      existing.lastActive = Date.now();
      return { isNew: false, available: true };
    }
    // 启动 claude TUI：有会话则 --resume 续接，否则新会话
    const file = claudeBin && existsSync(claudeBin) ? claudeBin : 'claude.cmd';
    logger.info('ptyHost', `ensure sid=${sid} file=${file} resume=${claudeSessionId || '无'} cwd=${cwd}`);
    const args = buildClaudeArgs({ claudeSessionId, isNewClaudeSession, model, permissionMode });
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
      logger.error('ptyHost', `spawn 失败 sid=${sid}:`, e.message);
      return { isNew: false, available: false };
    }
    const rec = { sid, child, lastActive: Date.now(), ready: false, outAcc: 0, pendingSubmits: [], quietTimer: null, lastInterruptAt: 0, termBuf: '', markerTimer: null, pendingConfirm: null, writeQueue: [], writing: false, permissionPending: false };
    ptys.set(sid, rec);
    // M2 兜底：20s 内无论输出多少都强制就绪（防 claude 卡死/输出异常导致消息永久卡队列）
    setTimeout(() => {
      if (ptys.get(sid) !== rec) return;
      becomeReady(sid, rec, '20s兜底');
    }, 20000);
    child.onData((d) => {
      rec.lastActive = Date.now();
      rec.outAcc += d.length;
      // 就绪主信号（9-02 取证）：claude 开启 bracketed-paste（ESC[?2004h）= 输入态激活。
      // 比「输出安静」可靠（终端协议，不随版本漂移）、比 jsonl 探测快（不用等 transcript 轮询 20s+）。
      // 取证：marker 746ms / 输入框 820ms（差 74ms）→ settle 200ms 落在输入框激活后。
      if (!rec.ready) {
        rec.termBuf = (rec.termBuf || '') + d;
        if (rec.termBuf.length > MARKER_BUF_LEN) rec.termBuf = rec.termBuf.slice(-MARKER_BUF_LEN);
        if (!rec.markerTimer && rec.termBuf.includes('\x1b[?2004h')) {
          rec.markerTimer = setTimeout(() => { rec.markerTimer = null; becomeReady(sid, rec, 'bracket标记'); }, MARKER_SETTLE_MS);
        }
      }
      // 就绪检测（fallback，8-27）：仅「输出超 1KB」不可靠——claude 冷启动会先滚一大片
      // banner/历史，输入框还没激活。改成「输出超 1KB 且安静 800ms（输出停止=界面稳定）」
      // 才算就绪；另有 markReady（jsonl 信号）与 20s 兜底双保险。
      if (!rec.ready && rec.outAcc > 1000) {
        if (rec.quietTimer) clearTimeout(rec.quietTimer);
        rec.quietTimer = setTimeout(() => { rec.quietTimer = null; becomeReady(sid, rec, '输出安静'); }, QUIET_READY_MS);
      }
      onData?.(sid, d);
    });
    child.onExit(({ exitCode }) => {
      cancelConfirm(rec); // pty 退出 → 清确认（不再重发/误报失败）
      // ⚠ 身份检查：只删自己——force-stop/自愈重启后旧进程 onExit 可能晚到，不能误删新 rec
      if (ptys.get(sid) === rec) ptys.delete(sid);
      bus?.emit('pty:exit', { sid, exitCode });
    });
    return { isNew: true, available: true };
  }

  /** 注入整条指令（文本 + 回车），供聊天/终端「对话」视图用
   *  @param {object} [opts] — { noConfirm: true } 媒体记忆等：不注册确认送达（丢了不重发，防重复注入） */
  function submit(sid, text, opts = {}) {
    const rec = ptys.get(sid);
    if (!rec) return false;
    // 指纹绑定（9-03 v2.1）：广播提交文本，供 transcript 探测验证 jsonl（防交叉错绑）
    bus?.emit('pty:submit', { sid, text: String(text) });
    // 确认送达（9-02）：提交即注册，transcript 在 jsonl 读到该文本 → 确认；6s 未确认 → 重发
    if (!opts.noConfirm) armConfirm(rec, String(text));
    // M2：pty 未就绪（claude TUI 还在启动）→ 进队列，就绪后自动补发（防消息被吞）
    if (!rec.ready) {
      rec.pendingSubmits.push(String(text));
      rec.lastActive = Date.now(); // C1：排队发送也算活跃（用户在发消息）
      return true;
    }
    return doSubmit(rec, text);
  }

  /** 注册确认送达：6s 后未确认（transcript 没在 jsonl 看到该文本）→ 重发；最多 CONFIRM_MAX_RETRY 次 */
  function armConfirm(rec, text) {
    if (rec.pendingConfirm) clearTimeout(rec.pendingConfirm.timer);
    const confirm = { text, attempts: 0, sentTs: Date.now() };
    rec.pendingConfirm = confirm;
    confirm.timer = setTimeout(() => checkConfirm(rec), CONFIRM_TIMEOUT_MS);
  }

  /** 确认送达：transcript 读到 jsonl 有该 user 文本（增量）→ 清，不再重发 */
  function confirmDelivered(sid, text, evTs) {
    const rec = ptys.get(sid);
    const c = rec?.pendingConfirm;
    if (!c || c.text !== text) return;
    // 只认「提交之后新出现」的 user 消息（evTs >= sentTs-1s 容差）——防 resume 历史回放误确认（重复提问历史句）
    if (evTs && c.sentTs && evTs < c.sentTs - 1000) return;
    clearTimeout(c.timer);
    rec.pendingConfirm = null;
  }

  /** 确认超时 → 重发（此时 claude 已就绪，成功率高）；耗尽 → 上报失败（server.js 释放 busy + 广播） */
  function checkConfirm(rec) {
    if (!ptys.has(rec.sid)) return; // pty 已退出/回收 → 不再重发（onExit/killAll 已清，双保险）
    const c = rec.pendingConfirm;
    if (!c) return;
    // 权限挂起中（claude 停在等 PermissionRequest hook 审批，输入框不可用）：
    // 消息"没确认"≠丢了——它在 claude 手里卡在权限门。不重发、不计 attempts、不报 fail，
    // 仅延后复查；挂起解除（setPermissionPending false）会主动触发一次补查。
    if (rec.permissionPending) {
      c.timer = setTimeout(() => checkConfirm(rec), CONFIRM_TIMEOUT_MS);
      return;
    }
    if (c.attempts >= CONFIRM_MAX_RETRY) {
      rec.pendingConfirm = null;
      bus?.emit('pty:confirm-fail', { sid: rec.sid, text: c.text });
      return;
    }
    c.attempts++;
    doSubmit(rec, c.text);
    c.timer = setTimeout(() => checkConfirm(rec), CONFIRM_TIMEOUT_MS);
  }

  /** 清确认（cancel/force-stop 时）：用户已停止 → 不再重发，避免打扰 */
  function cancelConfirm(rec) {
    if (rec?.pendingConfirm) {
      clearTimeout(rec.pendingConfirm.timer);
      rec.pendingConfirm = null;
    }
  }

  /** 权限挂起状态（外部在权限 request/respond/cancel 时通知，防等批权限时误重发同条消息）
   *  pending=true  → 该会话 claude 停在等 PermissionRequest hook 审批，输入框不可用 → 挂起确认重发
   *  pending=false → 解除：若仍有未确认消息 → 1s 后触发一次补查（claude 恢复、jsonl 推进；
   *                  1s 缓冲防"刚恢复 jsonl 未 flush"就误重发；confirmDelivered 通常已清无需补查） */
  function setPermissionPending(sid, pending) {
    const rec = ptys.get(sid);
    if (!rec) return;
    rec.permissionPending = !!pending;
    if (!pending && rec.pendingConfirm) {
      clearTimeout(rec.pendingConfirm.timer);
      rec.pendingConfirm.timer = setTimeout(() => checkConfirm(rec), 1000);
    }
  }

  /** 注入整条指令：入队 → 写队列串行执行（9-03 v2 根治长文本截断）。
   *  入队而非直接写：队列保证「一条完整 + \r 提交后才放下一条」，防分块/重发/连发交织。 */
  function doSubmit(rec, text) {
    rec.writeQueue.push(String(text));
    kickWrite(rec);
    return true;
  }

  /** 写队列泵：一次只处理一条；cancel 后冷却；超长分块写入（ConPTY 单次 >~1024 丢前段） */
  function kickWrite(rec) {
    if (rec.writing || !rec.writeQueue.length) return;
    // cancel 后冷却（审查①）：claude 收尾未回输入态时延迟启动，避免新旧消息写同 jsonl 打架
    const sinceInt = rec.lastInterruptAt ? Date.now() - rec.lastInterruptAt : Infinity;
    if (sinceInt < INTERRUPT_SETTLE_MS) {
      setTimeout(() => { if (ptys.get(rec.sid) === rec) kickWrite(rec); }, INTERRUPT_SETTLE_MS - sinceInt);
      return;
    }
    rec.writing = true;
    const text = rec.writeQueue.shift();
    const afterText = () => {
      // 回车隔离：下一条必须等这条 \r 发出（否则下一条字符接在未回车输入区后，两条合成一条）
      setTimeout(() => {
        try { rec.child.write('\r'); } catch { /* 已退出 */ }
        rec.lastActive = Date.now();
        rec.writing = false;
        kickWrite(rec);
      }, ENTER_DELAY_MS);
    };
    const s = String(text);
    if (s.length <= DIRECT_LEN) {
      // 短文本：原样单次写（<1024 实测安全，保持原语义零变化）
      try { rec.child.write(s); rec.lastActive = Date.now(); } catch { /* 已退出 */ }
      afterText();
      return;
    }
    // 长文本：码点安全拆块，逐块写 + 块间延迟（让 ConPTY 缓冲落稳，防积压溢出再丢前段）
    const chunks = splitChunks(s, WRITE_CHUNK);
    let i = 0;
    const step = () => {
      if (ptys.get(rec.sid) !== rec) { rec.writing = false; return; } // pty 被回收/kill → 中止剩余块
      if (i >= chunks.length) { afterText(); return; }
      try { rec.child.write(chunks[i]); rec.lastActive = Date.now(); } catch { afterText(); return; }
      i++;
      setTimeout(step, CHUNK_DELAY_MS);
    };
    step();
  }

  /** 按 Unicode 码点拆块（Array.from 防 slice 切断 emoji/代理对） */
  function splitChunks(s, size) {
    const chars = Array.from(s);
    const out = [];
    for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
    return out;
  }

  /** 就绪后补发积压的 submit（首次消息可能因启动慢被吞） */
  function flushPending(rec) {
    for (const t of rec.pendingSubmits.splice(0)) doSubmit(rec, t);
  }

  /** 置就绪（幂等）：任何可靠信号触发都走这里，统一补发积压消息 */
  function becomeReady(sid, rec, why) {
    if (rec.ready) return;
    logger.info('ptyHost', `就绪 sid=${sid}（${why}）`);
    rec.ready = true;
    flushPending(rec);
  }

  /** 外部就绪信号：transcript 探测到 claude jsonl = 主程序真正起来（比 outAcc 可靠）。
   *  收到后再 settle READY_SETTLE_MS，给 TUI 画完输入框留时间。 */
  function markReady(sid) {
    const rec = ptys.get(sid);
    if (!rec || rec.ready) return;
    logger.info('ptyHost', `markReady sid=${sid}（jsonl 信号）`);
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

  /** 终端尺寸变化 → 同步 pty，保证 TUI 不错位。
   *  ⚠ 下钳（8-29 单色+c 源头根治）：cols<MIN_COLS / rows<MIN_ROWS 一律钳到下限——
   *  手机 attach 窄列（~40列）会让 claude Ink 渲染崩溃只输出"C"（单色+c），
   *  钳到 MIN_COLS=50 安全宽度；前端错误小尺寸（1~3列）也被同一道拦下。 */
  function resize(sid, cols, rows) {
    const rec = ptys.get(sid);
    if (!rec) return;
    const c = Math.max(MIN_COLS, Number.isInteger(cols) && cols > 0 ? cols : DEFAULT_COLS);
    const r = Math.max(MIN_ROWS, Number.isInteger(rows) && rows > 0 ? rows : DEFAULT_ROWS);
    try {
      rec.child.resize(c, r);
      rec.lastActive = Date.now(); // C1：窗口调整也算活跃（防缩放间隙误回收）
    } catch {
      // 已退出
    }
  }

  /** Esc 中断当前生成（对应聊天「停止」按钮）。记录时间供 submit 冷却（审查①）；清确认（用户已停止，不再重发） */
  function interrupt(sid) {
    const rec = ptys.get(sid);
    if (rec) { rec.lastInterruptAt = Date.now(); cancelConfirm(rec); }
    return write(sid, '\x1b');
  }

  /** 强杀某会话 pty（force-stop）。
   *  ⚠ 8-29 并发写防护：taskkill 是异步的，旧 claude 可能短暂残留写 jsonl；若 force-stop 后立即重开
   *  同会话，新 pty resume 同 jsonl → 新旧并发写可能损坏文件。这里同步轮询确认旧进程退出后再删，
   *  保证后续 ensure（重开）时旧进程已死透。 */
  function kill(sid) {
    const rec = ptys.get(sid);
    if (!rec) return;
    cancelConfirm(rec); // 杀之前清确认（force-stop = 放弃当前消息，不重发）
    const pid = rec.child.pid;
    taskkill(pid);
    // 轮询确认退出（process.kill(pid, 0)：进程不存在抛 ESRCH，存在则成功）
    const deadline = Date.now() + KILL_CONFIRM_MS;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        break; // 已退出
      }
      sleepSync(KILL_POLL_MS);
    }
    ptys.delete(sid);
  }

  /** 服务退出时清理全部 */
  function killAll() {
    for (const [sid, rec] of ptys) {
      cancelConfirm(rec); // 清确认（防 timer 在 pty 已杀后误重发/误报失败）
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
          logger.info('ptyHost', `会话 ${sid} 空闲 ${Math.round(idleMs / 60000)} 分钟，回收 pty`);
          taskkill(rec.child.pid);
          ptys.delete(sid);
        }
      }
    }, 60 * 1000);
    // 防进程未退出（setInterval 不阻止进程退出）
  }

  return {
    ensure, submit, markReady, write, resize, interrupt, kill, killAll, isRunning, touch, scheduleIdleReap,
    confirmDelivered, // 确认送达（transcript 读到 jsonl user 文本时调）
    setPermissionPending, // 权限挂起状态（外部通知：挂起暂停重发，解除触发补查）
    get available() { return pty !== null; },
  };
}
