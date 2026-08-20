import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 组装 claude 非交互参数。
 * 注意：-p + stream-json 必须带 --verbose，否则 claude 直接报错。
 */
export function buildArgs({ prompt, model, claudeSessionId }) {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'bypassPermissions',
  ];
  if (model) args.push('--model', model);
  if (claudeSessionId) args.push('--resume', claudeSessionId);
  return args;
}

/**
 * 启动一个 claude 子进程并逐行解析 stream-json 事件。
 * @param {{
 *   claudeBin: string,
 *   prompt: string,
 *   model?: string,
 *   claudeSessionId?: string,
 *   cwd: string,
 *   onEvent: (evt: object) => void,
 *   onExit?: (code: number|null) => void,
 *   onError?: (err: Error) => void,
 * }} opts
 * @returns {{ child: import('node:child_process').ChildProcess, done: Promise<void>, cancel: () => void }}
 */
export function createClaudeRunner({ claudeBin, prompt, model, claudeSessionId, cwd, onEvent, onExit, onError }) {
  const args = buildArgs({ prompt, model, claudeSessionId });
  const child = spawn(claudeBin, args, { cwd, shell: false, windowsHide: true });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      onEvent(JSON.parse(line));
    } catch {
      // 非 JSON 行（如进度输出）直接忽略
    }
  });

  // stderr 是 claude 的日志/进度，不外发；但落盘到 server/log.txt 便于排查启动/运行错误
  const logPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'log.txt');
  child.stderr.on('data', (d) => {
    try {
      fs.appendFileSync(logPath, `[claude] ${String(d).trim()}\n`);
    } catch {
      // 日志写不了不影响主流程
    }
  });

  // 整体超时兜底：claude 卡死（API 挂起/进程僵死）时 5 分钟强制结束，
  // 否则 runner.done 永不 resolve → 该会话 busy 锁被永久占着、再也发不了消息
  const MAX_RUN_MS = 5 * 60 * 1000;
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      } catch {
        // 进程可能已退出
      }
      onError?.(new Error('claude 处理超时（>5 分钟），已终止本次生成'));
      resolve();
    }, MAX_RUN_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      onError?.(err);
      resolve();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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
