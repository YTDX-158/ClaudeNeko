#!/usr/bin/env node
// scripts/regression.js — ClaudeNeko 主链路回归脚本
//
// 用法：
//   node scripts/regression.js             # 全量（含真实发消息等 claude 回复，约 1-3 分钟）
//   node scripts/regression.js --skip-chat # 快速（跳过发消息等回复，几秒跑完其余）
//
// 每次改代码后跑一遍，坏了立刻定位是哪个环节。任何 FAIL → 退出码 1。
// 覆盖：健康 / 会话CRUD / 发消息主链路(acquire→回复→release) / cancel / force-stop
//       / 搜索 / 统计(全局+单会话) / 导出(单+全部zip) / 清理
//
// 前置：服务已启动（http://127.0.0.1:4000）。全量模式会真实调 claude（有 token 成本）。

const BASE = 'http://127.0.0.1:4000';
const SKIP_CHAT = process.argv.includes('--skip-chat');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? '✅ PASS' : '❌ FAIL';
  console.log(`${mark}  ${name}${detail ? `  (${detail})` : ''}`);
}
async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opt);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 导出等非 JSON */ }
  return { status: res.status, ct: res.headers.get('content-type') || '', data, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newSession() {
  const r = await api('POST', '/api/sessions', {});
  if (r.status !== 201 || !r.data?.session?.id) throw new Error(`新建会话失败 HTTP ${r.status}`);
  return r.data.session.id;
}

/** 轮询该会话直到出现「有文本的 assistant 消息」，超时返回 null */
async function waitAssistant(sid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await api('GET', `/api/sessions/${sid}/messages`);
    if (r.status === 200 && r.data?.messages) {
      const a = r.data.messages.filter((m) => m.role === 'assistant' && m.text);
      if (a.length) return a[0];
    }
    await sleep(3000);
  }
  return null;
}

async function main() {
  console.log(`=== ClaudeNeko 主链路回归 ===  ${SKIP_CHAT ? '快速模式(跳过真实发消息)' : '全量'}  ${new Date().toLocaleTimeString()}`);

  // 1. 服务健康（失败直接退出——服务没起，后面全白测）
  const h = await api('GET', '/api/health');
  if (!(h.status === 200 && h.data?.ok === true)) {
    console.log(`❌ FAIL  服务健康 (HTTP ${h.status})`);
    console.log('   服务未启动？先 wscript run-node.vbs 启动后再跑。');
    process.exit(1);
  }
  check('服务健康', true);

  // 2. 新建会话
  let sid;
  try { sid = await newSession(); check('新建会话', true, sid.slice(0, 8)); }
  catch (e) { check('新建会话', false, e.message); return; }

  // 3. 会话列表包含
  const ls = await api('GET', '/api/sessions');
  check('会话列表', ls.status === 200 && Array.isArray(ls.data?.sessions) && ls.data.sessions.some((s) => s.id === sid));

  // 4. 会话详情 busy=false
  const det = await api('GET', `/api/sessions/${sid}`);
  check('会话详情 busy=false', det.status === 200 && det.data?.session?.busy === false);

  const tag = `REGRESSION${Date.now().toString().slice(-6)}`;

  // 5. 发消息主链路（acquire → claude 回复 → release）
  if (!SKIP_CHAT) {
    const send = await api('POST', `/api/sessions/${sid}/messages`, { prompt: `Reply with the word OK. Tag: ${tag}`, attachments: [] });
    check('发消息 200', send.status === 200, `HTTP ${send.status}`);
    if (send.status === 200) {
      const busy1 = await api('GET', `/api/sessions/${sid}`);
      check('发消息后 busy=true（锁生效）', busy1.data?.session?.busy === true);
      const reply = await waitAssistant(sid, 120000);
      check('claude 回复落盘', !!reply, reply ? `回复 ${reply.text.length} 字` : '超时 120s 无回复');
      const busy2 = await api('GET', `/api/sessions/${sid}`);
      check('回复后 busy=false（锁释放）', busy2.data?.session?.busy === false);
    }
  } else {
    console.log('  （跳过发消息主链路）');
  }

  // 6. 搜索（搜唯一 tag）
  if (!SKIP_CHAT) {
    const s = await api('GET', `/api/search?q=${tag}`);
    check('搜索命中', s.status === 200 && Array.isArray(s.data?.results) && s.data.results.length > 0, `命中 ${s.data?.results?.length ?? 0}`);
  } else {
    console.log('  （跳过搜索——无真实消息可搜）');
  }

  // 7. 统计（全局 + 单会话）
  const st = await api('GET', '/api/stats');
  check('全局统计', st.status === 200 && st.data?.totals && typeof st.data.totals.messages === 'number');
  const sts = await api('GET', `/api/sessions/${sid}/stats`);
  check('单会话统计', sts.status === 200 && sts.data?.stats);

  // 8. 导出（单会话 JSON / 全部 zip）
  const ex = await api('GET', `/api/sessions/${sid}/export`);
  check('单会话导出 JSON', ex.status === 200 && ex.ct.includes('json'), ex.ct || `HTTP ${ex.status}`);
  const exa = await api('GET', '/api/sessions/export-all');
  check('全部导出 zip', exa.status === 200 && exa.ct.includes('zip'), exa.ct || `HTTP ${exa.status}`);

  // 9. cancel：对空会话 cancel → 200 + busy 仍 false（幂等释放）
  //    ⚠ 不制造真实 busy（不发消息冷启动 claude）——主链路的 acquire→回复→release 已覆盖真实锁；
  //    并发冷启动多个 claude 会让全量回归偶发探测不到 jsonl（8-27 实测）
  const c1 = await newSession();
  const can = await api('POST', `/api/sessions/${c1}/cancel`);
  const cb = await api('GET', `/api/sessions/${c1}`);
  check('cancel 幂等释放', can.status === 200 && cb.data?.session?.busy === false);

  // 10. force-stop：对空会话 force-stop → 200 + busy 仍 false（幂等释放）
  const f1 = await newSession();
  const fs = await api('POST', `/api/sessions/${f1}/force-stop`);
  const fb = await api('GET', `/api/sessions/${f1}`);
  check('force-stop 幂等释放', fs.status === 200 && fb.data?.session?.busy === false);

  // 11. 清理测试会话（含可能残留的 c1/f1 pty）
  for (const id of [sid, c1, f1]) {
    if (id) { try { await api('DELETE', `/api/sessions/${id}`); } catch { /* 忽略 */ } }
  }
  check('测试会话清理', true);

  // 汇总
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`=== 结果: ${results.length - failed.length}/${results.length} PASS${failed.length ? `，${failed.length} FAIL` : ''} ===`);
  for (const f of failed) console.log(`  ❌ ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('回归脚本异常:', e); process.exit(2); });
