import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

/**
 * 组装 claude 非交互参数。
 * 注意：-p + stream-json 必须带 --verbose，否则 claude 直接报错。
 */
export function buildArgs({ prompt, model, effort, claudeSessionId }) {
  // 审查③：Windows CreateProcess 命令行上限 ~32767 字符，超长会静默失败 → 截断到安全长度
  const MAX_PROMPT_LEN = 20000;
  const safePrompt = String(prompt).replace(/\0/g, '').slice(0, MAX_PROMPT_LEN); // 过滤 NUL + 截断
  const args = [
    '-p',
    safePrompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'bypassPermissions',
  ];
  if (model) args.push('--model', model);
  // 思考档位（effort）：接口只放行 low(省) / max(强力)；标准档不传（DeepSeek 默认 high）
  if (effort) args.push('--effort', effort);
  if (claudeSessionId) args.push('--resume', claudeSessionId);
  return args;
}

/**
 * 启动一个 claude 子进程并逐行解析 stream-json 事件。
 * @param {{
 *   claudeBin: string,
 *   prompt: string,
 *   model?: string,
 *   effort?: string,
 *   claudeSessionId?: string,
 *   cwd: string,
 *   onEvent: (evt: object) => void,
 *   onExit?: (code: number|null) => void,
 *   onError?: (err: Error) => void,
 * }} opts
 * @returns {{ child: import('node:child_process').ChildProcess, done: Promise<void>, cancel: () => void }}
 */
export function createClaudeRunner({ claudeBin, prompt, model, effort, claudeSessionId, cwd, onEvent, onExit, onError }) {
  const args = buildArgs({ prompt, model, effort, claudeSessionId });
  const child = spawn(claudeBin, args, { cwd, shell: false, windowsHide: true });

  // 空闲超时兜底：claude 卡死（API 挂起/进程僵死）时强制结束，
  // 否则 runner.done 永不 resolve → 该会话 busy 锁被永久占着、再也发不了消息。
  // 注意是"空闲"超时而非"总时长"——只要 claude 还在持续输出（stdout 事件 / stderr 日志），
  // 就说明它活着在干活，绝不超时；只有长时间毫无动静才判定卡死。
  const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  const done = new Promise((resolve) => {
    let idleTimer = null;
    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const armIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        } catch {
          // 进程可能已退出
        }
        const err = new Error('claude 长时间无响应（空闲超时，已终止本次生成）');
        err.code = 'IDLE_TIMEOUT'; // 供调用方区分：这是超时中止，不是启动失败
        onError?.(err);
        resolve();
      }, IDLE_TIMEOUT_MS);
    };

    // 任何一条 stream-json 事件都是"活着"的心跳 → 重置空闲计时器
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const evt = JSON.parse(line);
        armIdleTimer();
        onEvent(evt);
      } catch {
        // 非 JSON 行（如进度输出）直接忽略
      }
    });

    // stderr 是 claude 的日志/进度，不外发；但落盘到 server/log.txt 便于排查启动/运行错误。
    // stderr 有输出也算"活着"（启动慢/加载长会话时 stdout 可能暂未出事件）
    child.stderr.on('data', (d) => {
      // 9-03 并入 logger：claude stderr 多为启动/进度输出 → debug 级（LOG_LEVEL=debug 调查时才看，默认不刷屏）
      logger.debug('claude', String(d).trim());
      armIdleTimer();
    });

    armIdleTimer(); // 启动计时

    child.on('error', (err) => {
      clearIdleTimer();
      onError?.(err);
      resolve();
    });
    child.on('close', (code) => {
      clearIdleTimer();
      onExit?.(code);
      resolve();
    });
  });

  return {
    child,
    done,
    /** 取消：Windows 杀整个进程树，避免残留 claude 子进程。 */
    cancel() {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      } catch {
        // 进程可能已退出
      }
    },
  };
}
