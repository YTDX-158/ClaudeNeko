import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 会话存储：sessions.json 索引 + sessions/<id>.jsonl 每会话消息日志。
 * 所有写操作同步执行（本地单机，量小足够）。
 */
export class SessionStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.messagesDir = path.join(dataDir, 'sessions');
    fs.mkdirSync(this.messagesDir, { recursive: true });
    this.sessions = this.#load();
  }

  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
    } catch {
      return [];
    }
  }

  #save() {
    // 原子写：先写临时文件再 rename，防崩溃时写一半损坏索引 → 下次启动丢全部会话
    const tmp = `${this.sessionsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.sessions, null, 2));
    fs.renameSync(tmp, this.sessionsFile);
  }

  /** @returns {Array<object>} 置顶优先，其次按 updatedAt 倒序的新数组。
   *  兼容历史会话无 pinned 字段（undefined 视为 false）。 */
  list() {
    return [...this.sessions].sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || (b.updatedAt - a.updatedAt));
  }

  /** @returns {object|null} */
  get(id) {
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  /** 创建会话，claudeSessionId 初始为 null。 */
  create({ model, cwd, title, parentId, branchFromMsg, branchContextInjected, branchContextPending, effort }) {
    const now = Date.now();
    const session = {
      id: crypto.randomUUID(),
      title: title ?? '新会话',
      model,
      cwd,
      effort,
      claudeSessionId: null,
      parentId: parentId ?? null, // 分支来源会话 id（普通会话 null）
      branchFromMsg: branchFromMsg ?? null, // 分支点消息的 claudeMessageId
      branchContextInjected,
      branchContextPending,
      pinned: false, // 会话置顶：置顶优先排前，不被新会话刷沉
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.push(session);
    this.#save();
    return session;
  }

  /** 更新会话字段，返回新对象；不存在返回 null。 */
  update(id, patch) {
    const i = this.sessions.findIndex((s) => s.id === id);
    if (i < 0) return null;
    this.sessions[i] = { ...this.sessions[i], ...patch, updatedAt: Date.now() };
    this.#save();
    return this.sessions[i];
  }

  /** 删除会话索引 + 消息日志。 */
  remove(id) {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.#save();
    try {
      fs.unlinkSync(path.join(this.messagesDir, `${id}.jsonl`));
    } catch {
      // 日志文件可能不存在，忽略
    }
  }

  /** 追加一条消息到会话日志。 */
  appendMessage(id, msg) {
    fs.appendFileSync(path.join(this.messagesDir, `${id}.jsonl`), `${JSON.stringify(msg)}\n`);
    // 消息落盘即视为会话有更新：刷新 updatedAt（内存 + 落盘），
    // 让多开 3s 轮询同步与会话排序依赖"消息落盘"，而非 model_update 副作用
    const s = this.sessions.find((x) => x.id === id);
    if (s) {
      s.updatedAt = Date.now();
      this.#save();
    }
  }

  /** 读取会话消息（逐行容错：损坏行跳过，不让一行坏导致整个会话读不了）。 */
  readMessages(id) {
    const file = path.join(this.messagesDir, `${id}.jsonl`);
    if (!fs.existsSync(file)) return [];
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // 跳过损坏行（崩溃中途写入等），其余消息照常可用
      }
    }
    return out;
  }

  /** 按索引更新单条消息（认领 pendingJsonl 补 claudeMessageId 用）：读改写整个文件 */
  updateMessage(id, index, patch) {
    const file = path.join(this.messagesDir, `${id}.jsonl`);
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    if (index < 0 || index >= lines.length) return;
    try {
      const msg = JSON.parse(lines[index]);
      Object.assign(msg, patch);
      lines[index] = JSON.stringify(msg);
      fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    } catch {
      // 损坏行跳过（不阻塞）
    }
  }

  /** 按稳定消息 id 删除一条消息；仅用于提交尚未发生时回滚本次追加，避免误删并发消息。 */
  removeMessage(id, messageId) {
    if (!messageId) return false;
    const file = path.join(this.messagesDir, `${id}.jsonl`);
    if (!fs.existsSync(file)) return false;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
    const kept = [];
    let removed = false;
    for (const line of lines) {
      if (!removed) {
        try {
          if (JSON.parse(line)?.id === messageId) {
            removed = true;
            continue;
          }
        } catch {
          // 损坏行原样保留
        }
      }
      kept.push(line);
    }
    if (!removed) return false;
    fs.writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
    return true;
  }
}
