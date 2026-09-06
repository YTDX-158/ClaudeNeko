// server/lib/transcript.js — 轮询 claude 会话 jsonl，把新消息转成结构化事件
//
// 从 @inksnow/c2web (MIT) 的 transcript.mjs 移植 + 修正：
//   - encodeProjectDir 修正为「每个非字母数字字符都转 -」（实测 claude 编码：
//     C:\Users\someone → C--Users-------，中文逐个转 -）
//   - parseLenient 宽松解析（纯 JSON.parse，不依赖 @constellos 库）：
//     专治 DeepSeek 的 assistant 消息缺 requestId，严格 schema 会整条丢弃
//   - messageToEvents 增强：同一 message.id 的多块（thinking/text/tool_use）聚合，
//     提取 usage（存在 message.usage，同轮多块共享同一份）
//
// jsonl 权威结构（实测）：
//   - 每行一个 JSON 对象，type ∈ {mode,permission-mode,atis-latch,file-history-snapshot,
//     user,attachment,ai-title,assistant,last-prompt,system,file-history-delta,...}
//   - user 行：message.content 是字符串；行有 uuid；message.id 为 null
//   - assistant 行：同一轮拆多行，共享同一 message.id；
//     每行 message.content 是一个块（thinking/text/tool_use），都带同一份 message.usage
//   - 顶层无 usage/model（model 在 mode 行）

import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';

/** 诊断日志时间格式化（毫秒 → HH:MM:SS，仅供排雷日志） */
const fmtTs = (ms) => (ms ? new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) : '?');

/**
 * 把 jsonl 行的 timestamp 解析成 epoch 毫秒。
 * ⚠ 9-03 修复：jsonl 的 timestamp 实测是 ISO 字符串（"2026-09-02T22:07:04.618Z"），
 * 旧代码 `j.timestamp * 1000` 得 NaN → 所有事件 ts 变 NaN。数字按秒×1000、字符串走 Date、非法回退 now。
 */
function parseTs(j) {
  const t = j?.timestamp;
  if (t === undefined || t === null) return Date.now();
  const ms = typeof t === 'number' ? t * 1000 : new Date(t).getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

/** 把项目绝对路径编码成 ~/.claude/projects 下的目录名（每个非字母数字字符都转 -） */
export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/** 当前项目在 ~/.claude/projects 下的会话目录 */
function projectDir(cwd) {
  return join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
}

/**
 * 定位「afterTs 之后创建/修改」的会话 jsonl。
 * ⚠ 关键修复（8-26 P1 实测发现）：新会话无 claudeSessionId 时，若扫全目录会命中
 * 当前正在用的会话 jsonl（mtime 最新），把别人历史全量回放进新会话（数据污染）。
 * 所以必须用 baseline 过滤：只认 ensure 时刻之后新建的文件——新 pty 起的 claude
 * 必然新建一个 jsonl，mtime >= baseline。
 * @param {string} cwd 项目目录
 * @param {number} afterTs ensure 时刻（毫秒），只认「创建时间」>= 它的文件
 * @param {Set<string>} excludeIds 排除的 claudeSessionId（store 已有会话），防命中活跃会话
 * ⚠ 用 birthtime（创建时间）而非 mtime：当前活跃会话（如 CLI 本会话）的 jsonl mtime 一直在更新，
 *   baseline 过滤挡不住；但它是 ensure 之前就存在的，birthtime < baseline，天然被排除。
 */
/** 查文件是否含指纹片段（绑定验证用）。
 *  ⚠ 9-06 修复：claude jsonl 是流式追加，user 文本写在中部后会被后续 assistant/tool/system
 *  （stop_hook_summary / turn_duration 等）事件持续追加推离"尾部小窗口"——只查尾部 → 长回复/活跃会话
 *  绑定永不成功 → transcript 探测无结果 → 确认送达永不到 → ptyHost 6s 误重发耗尽（实测 227ccb34：
 *  user 文本偏移止于 45K，文件 66K，尾部 16K 全是系统事件）。改为：尾窗快路径 + 全文兜底（cap 防超大文件）。 */
function fileTailContains(file, fp, tailBytes = 16384, fullCap = 8 * 1024 * 1024) {
  try {
    const size = statSync(file).size;
    if (size < 1 || !fp) return false;
    const fd = openSync(file, 'r');
    try {
      // ① 尾部窗口（快路径：user 文本近尾时一次命中）
      const len = Math.min(size, tailBytes);
      const tail = Buffer.alloc(len);
      readSync(fd, tail, 0, len, size - len);
      if (tail.toString('utf8').includes(fp)) return true;
      // ② 全文检索兜底（cap 内整读；>cap 读前段——user 文本若被推离尾窗必在前中段）
      const probeLen = Math.min(size, fullCap);
      const probe = Buffer.alloc(probeLen);
      readSync(fd, probe, 0, probeLen, 0);
      return probe.toString('utf8').includes(fp);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * 定位本会话的 claude jsonl（9-03 v2.1 指纹绑定版）。
 * ⚠ 不再「猜最新文件」：未绑定会话必须带「最近提交文本指纹」才探测，
 *   且只接受「尾部确实含该指纹」的 jsonl —— 多会话并发各找各的，杜绝交叉错绑。
 * @param {string} cwd 项目目录
 * @param {number} afterTs ensure 时刻（毫秒）
 * @param {Set<string>} excludeIds 排除的 claudeSessionId（store 已有会话）
 * @param {string} fingerprint 最近提交文本前 30 字符；空则不确定，不探测（返回 null）
 */
export function findLatestSession(cwd, afterTs, excludeIds, fingerprint, onDiag) {
  const dir = projectDir(cwd);
  if (!existsSync(dir)) { onDiag?.({ error: '目录不存在', total: 0 }); return null; }
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    onDiag?.({ error: '读取目录失败', total: 0 });
    return null;
  }
  if (!files.length) { onDiag?.({ error: '无 jsonl', total: 0 }); return null; }
  const fp = String(fingerprint || '').trim().slice(0, 30);
  if (!fp) {
    // 无指纹（还没发消息）→ 不猜不绑（此时本会话的 jsonl 也未必生成）
    onDiag?.({ error: '无指纹(尚未发消息)不探测', total: files.length });
    return null;
  }
  // 候选：非排除 +（ensure 后新建 或 5s 内活跃写入），按 mtime 降序
  const candidates = [];
  for (const f of files) {
    const sessionId = f.replace(/\.jsonl$/, '');
    const excluded = !!excludeIds?.has(sessionId); // 排除已知会话
    if (excluded) continue;
    const full = join(dir, f);
    try {
      const st = statSync(full);
      const birth = st.birthtimeMs || st.ctimeMs; // Windows 有 birthtime；退化用 ctime
      const mtime = st.mtimeMs;
      const active = !!(afterTs && mtime >= afterTs - 5000); // 5s 内活跃写入 = 正在用
      if (!active && !(afterTs && birth >= afterTs)) continue; // 既非新建也非活跃 → 跳过
      candidates.push({ id: sessionId.slice(0, 8), file: full, sessionId, birth, mtime, active });
    } catch {
      // 文件被占/删除，跳过
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates) {
    if (fileTailContains(c.file, fp)) {
      onDiag?.({ baseline: afterTs, total: files.length, matched: c.id, candidates: candidates.map((x) => `${x.id}(创建${fmtTs(x.birth)}/改${fmtTs(x.mtime)})`) });
      return { mt: c.mtime, file: c.file, sessionId: c.sessionId };
    }
  }
  onDiag?.({ baseline: afterTs, total: files.length, error: '候选均不含指纹', candidates: candidates.map((x) => `${x.id}(创建${fmtTs(x.birth)}/改${fmtTs(x.mtime)})`) });
  return null;
}

/** 由会话 id 拼出 transcript 文件路径（--resume <id> 显式指定时） */
export function sessionFile(cwd, claudeSessionId) {
  return join(projectDir(cwd), `${claudeSessionId}.jsonl`);
}

/** 宽松解析：逐行认 user/assistant，不依赖严格 schema */
function parseLenient(file) {
  const msgs = [];
  let content = '';
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return msgs;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j && (j.type === 'user' || j.type === 'assistant') && j.message) msgs.push(j);
    } catch {
      // 半行/噪声忽略
    }
  }
  return msgs;
}

/** 取 message.content 的 usage（assistant 同轮多块共享同一份） */
function extractUsage(m) {
  return m?.usage || null;
}

/**
 * 把一条消息行转成事件。
 * assistant 多块同 message.id：用 Map 累积，thinking 累积进 thinking、text 累积进 text、
 * tool_use 单独出 tool 事件；凑齐「有 text」时视为主文本完整，emit assistant 事件。
 * @param {object} j 单行 json
 * @param {Map<string,{text,thinking,usage}>} acc 按 message.id 的累积器（跨行状态）
 * @returns {object[]} 本次要 emit 的事件（可能为空）
 */
export function messageToEvents(j, acc) {
  const type = j.type;
  const m = j.message || {};
  if (type === 'user') {
    const text = typeof m.content === 'string' ? m.content : '';
    // ⚠ 过滤 claude --resume 自动注入的系统消息（"Continue from where you left off."）：
    // 它是 claude 恢复会话时自己写的，不是用户真实输入，落盘会污染对话（8-27 修复）
    if (text.trim() === 'Continue from where you left off.') return [];
    // ⚠ 过滤 claude compact 注入的上下文摘要（"This session is being continued..."）：
    // 压缩时 claude 把旧对话摘要作为 user 消息注入，transcript 会当用户消息显示（8-28 修复）
    if (/^This session is being continued from a previous conversation that ran out of context\./i.test(text.trim())) return [];
    // user 无 message.id，用行 uuid 作唯一标识（认领/去重用）
    const claudeMessageId = j.uuid || `user-${j.timestamp ?? ''}-${text.length}`;
    if (text.trim()) return [{ kind: 'user', text, claudeMessageId, ts: parseTs(j) }];
    return [];
  }
  if (type !== 'assistant') return [];
  const mid = m.id;
  if (!mid) return [];
  const cur = acc.get(mid) || { text: '', thinking: '', usage: null };
  const c = m.content;
  const blocks = Array.isArray(c) ? c : [];
  const out = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'thinking' && typeof b.thinking === 'string') {
      cur.thinking += b.thinking;
    } else if (b.type === 'text' && typeof b.text === 'string') {
      cur.text += b.text;
      if (!cur.usage) cur.usage = extractUsage(m);
    } else if (b.type === 'tool_use') {
      // tool 事件：单独 emit，不并入主文本
      out.push({ kind: 'tool', text: String(b.name || 'tool'), claudeMessageId: mid, ts: parseTs(j) });
    }
  }
  // 有 text 块 → 主文本完整，emit 一条 assistant 事件
  if (cur.text) {
    acc.delete(mid);
    // ⚠ 过滤 resume 副产物 "No response requested."（claude 对系统注入消息的"无需回复"，
    // 非真回答；与上面 "Continue from where you left off." 成对出现，8-27 修复）
    if (cur.text.trim() === 'No response requested.') return out;
    const ev = {
      kind: 'assistant',
      text: cur.text,
      claudeMessageId: mid,
      ts: parseTs(j),
    };
    if (cur.thinking) ev.thinking = cur.thinking;
    if (cur.usage) ev.usage = cur.usage;
    if (j.effort) ev.effort = j.effort;
    // 8-30 方案A：回合结束权威信号——message.stop_reason 为终止值（end_turn/stop_sequence/stop）
    // 时标记 turnEnd。前端据此立即熄灭"生成中"胶囊（替代"无活动超时"启发式：claude 思考再久也不闪）
    if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence' || m.stop_reason === 'stop') {
      ev.turnEnd = true;
    }
    out.push(ev);
  } else {
    acc.set(mid, cur);
  }
  return out;
}

/**
 * 创建 transcript 服务：轮询会话 jsonl，增量把新消息转事件推到 bus（Phase2 解耦）。
 * @param {{
 *   bus: object,                       // 事件总线（emit transcript:* 事件，见 lib/bus.js 事件字典）
 *   getKnownSessionIds?: ()=>string[], // store 里已有会话的 claudeSessionId（探测时排除）
 * }} opts
 */
export function createTranscriptService({ bus, getKnownSessionIds }) {
  // sid -> { timer, emitted, lastSize, running, acc, cwd, claudeSessionId }
  const pollers = new Map();

  // 指纹绑定（9-03 v2.1）：ptyHost submit 时广播提交文本 → 记录为探测指纹（防交叉错绑）。
  // 若 submit 早于 ensure（罕见），先缓存 pendingSubmit，ensure 建 rec 时补上。
  const pendingSubmit = new Map();
  bus.on('pty:submit', ({ sid, text }) => {
    const rec = pollers.get(sid);
    if (rec) rec.lastSubmitText = String(text);
    else pendingSubmit.set(sid, String(text));
  });

  /** 绑定某会话的轮询（懒启动）。有 claudeSessionId 直接绑文件；没有则扫描探测。 */
  function ensure(sid, { cwd, claudeSessionId }) {
    const existing = pollers.get(sid);
    if (existing) {
      if (claudeSessionId) existing.claudeSessionId = claudeSessionId;
      return;
    }
    const rec = { timer: null, emitted: 0, lastSize: -1, running: false, acc: new Map(), cwd, claudeSessionId: claudeSessionId || null, baseline: Date.now(), lastSubmitText: null };
    if (pendingSubmit.has(sid)) {
      rec.lastSubmitText = pendingSubmit.get(sid);
      pendingSubmit.delete(sid);
    }
    pollers.set(sid, rec);
    const pump = () => {
      if (rec.running) return;
      // 无 claudeSessionId → 探测 ensure 之后新建的 jsonl（首次启动无 resume，新 pty 会建新文件）
      let file = null;
      if (rec.claudeSessionId) {
        file = sessionFile(rec.cwd, rec.claudeSessionId);
      } else {
        // ⚠ 指纹驱动（9-03 v2.1）：没发过消息（无指纹）→ 不探测（jsonl 未生成，也防"猜最新"错绑/刷屏）
        const fp = rec.lastSubmitText ? String(rec.lastSubmitText).trim().slice(0, 30) : '';
        if (!fp) return;
        // 排除 store 已有会话的 claudeSessionId：防命中活跃会话
        const known = new Set(getKnownSessionIds?.() ?? []);
        const latest = findLatestSession(rec.cwd, rec.baseline, known, fp, (d) => {
          // 探测诊断（9-03 排雷）：只在「无结果」时打印明细，同 sid 8s 限流防刷屏
          if (d.matched) return;
          const now = Date.now();
          if (rec.lastDiagTs && now - rec.lastDiagTs < 8000) return;
          rec.lastDiagTs = now;
          const desc = d.error || (d.candidates || []).join(' ') || '无候选';
          logger.warn('transcript', `探测无结果 sid=${sid.slice(0, 8)} 共${d.total}文件 ${desc}`);
        });
        if (latest && latest.sessionId) {
          bus.emit('transcript:sessionId', { sid, claudeSessionId: latest.sessionId });
          rec.claudeSessionId = latest.sessionId;
          file = latest.file;
        }
      }
      if (!file) return; // 还没会话文件，下轮再试
      let size;
      try {
        size = statSync(file).size;
      } catch {
        return;
      }
      if (size === rec.lastSize) return;
      rec.running = true;
      try {
        const msgs = parseLenient(file);
        const emittedEvents = [];
        for (let i = rec.emitted; i < msgs.length; i++) {
          const evs = messageToEvents(msgs[i], rec.acc);
          for (const ev of evs) emittedEvents.push(ev);
        }
        rec.emitted = msgs.length;
        rec.lastSize = size;
        for (const ev of emittedEvents) bus.emit(`transcript:${ev.kind}`, { sid, ev });
      } catch {
        // 半行/瞬时错误，下轮重试（不更新 lastSize）
      } finally {
        rec.running = false;
      }
    };
    pump(); // 首次：回放历史（emitted=0 → 全量）
    rec.timer = setInterval(pump, 700);
  }

  /** 释放某会话的轮询（pty 回收/服务退出时） */
  function release(sid) {
    const rec = pollers.get(sid);
    if (rec && rec.timer) clearInterval(rec.timer);
    pollers.delete(sid);
  }

  /** 服务退出时全部释放 */
  function releaseAll() {
    for (const [, rec] of pollers) {
      if (rec.timer) clearInterval(rec.timer);
    }
    pollers.clear();
  }

  return { ensure, release, releaseAll };
}
