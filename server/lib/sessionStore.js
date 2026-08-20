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
    fs.writeFileSync(this.sessionsFile, JSON.stringify(this.sessions, null, 2));
  }

  /** @returns {Array<object>} 按 updatedAt 倒序的新数组 */
  list() {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** @returns {object|null} */
  get(id) {
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  /** 创建会话，claudeSessionId 初始为 null。 */
  create({ model, cwd }) {
    const now = Date.now();
    const session = {
      id: crypto.randomUUID(),
      title: '新会话',
      model,
      cwd,
      claudeSessionId: null,
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
  }

  /** 读取会话消息。 */
  readMessages(id) {
    const file = path.join(this.messagesDir, `${id}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}
