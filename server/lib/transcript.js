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

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
export function findLatestSession(cwd, afterTs, excludeIds) {
  const dir = projectDir(cwd);
  if (!existsSync(dir)) return null;
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  if (!files.length) return null;
  let best = null;
  for (const f of files) {
    const sessionId = f.replace(/\.jsonl$/, '');
    if (excludeIds?.has(sessionId)) continue; // 排除已知会话
    const full = join(dir, f);
    try {
      const st = statSync(full);
      const bt = st.birthtimeMs || st.ctimeMs; // Windows 有 birthtime；退化用 ctime
      if (afterTs && bt < afterTs) continue; // 只认 ensure 之后「创建」的（新建会话）
      if (!best || bt > best.mt) best = { mt: bt, file: full, sessionId };
    } catch {
      // 文件被占/删除，跳过
    }
  }
  return best;
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
    // user 无 message.id，用行 uuid 作唯一标识（认领/去重用）
    const claudeMessageId = j.uuid || `user-${j.timestamp ?? ''}-${text.length}`;
    if (text.trim()) return [{ kind: 'user', text, claudeMessageId, ts: j.timestamp ? j.timestamp * 1000 : Date.now() }];
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
      out.push({ kind: 'tool', text: String(b.name || 'tool'), claudeMessageId: mid, ts: j.timestamp ? j.timestamp * 1000 : Date.now() });
    }
  }
  // 有 text 块 → 主文本完整，emit 一条 assistant 事件
  if (cur.text) {
    acc.delete(mid);
    const ev = {
      kind: 'assistant',
      text: cur.text,
      claudeMessageId: mid,
      ts: j.timestamp ? j.timestamp * 1000 : Date.now(),
    };
    if (cur.thinking) ev.thinking = cur.thinking;
    if (cur.usage) ev.usage = cur.usage;
    if (j.effort) ev.effort = j.effort;
    out.push(ev);
  } else {
    acc.set(mid, cur);
  }
  return out;
}

/**
 * 创建 transcript 服务：轮询会话 jsonl，增量把新消息转事件推给回调。
 * @param {{
 *   onEvent:(sid:string, ev:object)=>void,
 *   onSessionId?:(sid:string, id:string)=>void,
 *   getKnownSessionIds?: ()=>string[],  // store 里已有会话的 claudeSessionId（探测时排除）
 * }} opts
 */
export function createTranscriptService({ onEvent, onSessionId, getKnownSessionIds }) {
  // sid -> { timer, emitted, lastSize, running, acc, cwd, claudeSessionId }
  const pollers = new Map();

  /** 绑定某会话的轮询（懒启动）。有 claudeSessionId 直接绑文件；没有则扫描探测。 */
  function ensure(sid, { cwd, claudeSessionId }) {
    const existing = pollers.get(sid);
    if (existing) {
      if (claudeSessionId) existing.claudeSessionId = claudeSessionId;
      return;
    }
    const rec = { timer: null, emitted: 0, lastSize: -1, running: false, acc: new Map(), cwd, claudeSessionId: claudeSessionId || null, baseline: Date.now() };
    pollers.set(sid, rec);
    const pump = () => {
      if (rec.running) return;
      // 无 claudeSessionId → 探测 ensure 之后新建的 jsonl（首次启动无 resume，新 pty 会建新文件）
      let file = null;
      if (rec.claudeSessionId) {
        file = sessionFile(rec.cwd, rec.claudeSessionId);
      } else {
        // 排除 store 已有会话的 claudeSessionId：防命中活跃会话（当前会话一直在写，baseline 挡不住）
        const known = new Set(getKnownSessionIds?.() ?? []);
        const latest = findLatestSession(rec.cwd, rec.baseline, known);
        console.log(`[transcript] 探测 sid=${sid} cwd=${rec.cwd} → ${latest ? latest.sessionId.slice(0,8) : '无'}（排除${known.size}已知）`);
        if (latest && latest.sessionId) {
          if (onSessionId) onSessionId(sid, latest.sessionId);
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
        for (const ev of emittedEvents) onEvent(sid, ev);
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
