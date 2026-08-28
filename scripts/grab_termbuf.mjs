// scripts/grab_termbuf.mjs — 抓取某会话的 termBuf 原始内容（单色+c 取证工具）
//
// 用法：node scripts/grab_termbuf.mjs <ClaudeNeko会话sid> [端口]
//   从 sessions.json 拿 sid（id 字段），默认端口 4000
// 作用：attach 后服务端会回放 termBuf（term-replay），把内容可打印化打印出来。
//   直接看 claude 输出的是什么——判断「单色+c」是 claude 真卡死（空/单字符帧）
//   还是正常画面被渲染坏。
// ⚠ 会 attach 并 resize pty 到 80 列（取证时 pty 已卡死，无副作用）
import WebSocket from 'ws';

const sid = process.argv[2];
const port = process.argv[3] || 4000;
if (!sid) {
  console.error('用法: node scripts/grab_termbuf.mjs <sid> [端口]');
  process.exit(1);
}

const url = `ws://127.0.0.1:${port}/ws?sid=${sid}`;
const ws = new WebSocket(url);
let gotReplay = false;

ws.on('open', () => {
  console.log(`[连接成功] ${url}`);
  ws.send(JSON.stringify({ t: 'attach', cols: 80, rows: 24 }));
  // 2.5s 后关闭（等 term-replay + 一段实时流）
  setTimeout(() => ws.close(), 2500);
});

ws.on('message', (raw) => {
  let m;
  try {
    m = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (m.t === 'term-replay') {
    gotReplay = true;
    const d = m.d || '';
    // 可打印化：控制字符转义，只看前 1000 字符
    const vis = d
      .slice(0, 1000)
      .replace(/\x1b\[/g, '␛[') // ESC[ 序列
      .replace(/\x1b[()]/g, '␛(')
      .replace(/\x1b/g, '␛')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');
    console.log(`=== term-replay === 原始长度: ${d.length}`);
    console.log(`前1000字符（可打印）:`);
    console.log(vis);
    // 统计关键内容
    const escCount = (d.match(/\x1b/g) || []).length;
    const visibleChars = d.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[^\x20-\x7e]/g, '');
    console.log(`--- 统计: ESC序列数=${escCount} 可显示字符="${visibleChars.slice(0, 200)}"`);
  } else if (m.t === 'term') {
    if (gotReplay) return;
    console.log(`[term 实时流] 长度: ${(m.d || '').length}（attach 同步窗内收到的实时流）`);
  } else if (m.t === 'ev') {
    // 聊天事件，忽略
  } else {
    console.log(`[其他消息] ${m.t}`);
  }
});

ws.on('error', (e) => {
  console.error(`[WS 错误] ${e.message}`);
  console.error('  服务没在跑？端口不对？sid 不是 ClaudeNeko 的 id？');
});

ws.on('close', () => {
  console.log('[连接关闭]');
  if (!gotReplay) console.log('⚠ 没收到 term-replay（该会话可能没有累积缓冲，或服务端没回放）');
  process.exit(0);
});
