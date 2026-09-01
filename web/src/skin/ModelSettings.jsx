// ModelSettings.jsx — 设置中心「模型配置」分区
// ============================================
// 四个 tab：对话模型 / 生图 / 生视频 / 视觉理解
// - 对话模型：当前配置 + 档案（切换/存/删）+ 表单（供应商/模型/key）+ 测试连通
// - 生图/生视频：固定预设清单（baseUrl 预填火山 + key），填什么生成时用什么；没配生成时提示
// - 视觉理解：独立配置项（baseUrl + key + model），AI 看附件用
// 复用 SkinSettings 的 skin-* 样式类。

import { useEffect, useState } from 'react';
import { api } from '../api.js';

// 供应商模板（切换时自动带出 baseUrl；模型档为预设，可自定义输入）
const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', models: ['deepseek-v4-flash[1m]', 'deepseek-v4-pro[1m]'] },
  { id: 'qwen', label: '通义(Qwen)', baseUrl: 'https://dashscope.aliyuncs.com/api/v2/apps/anthropic', models: [] },
  { id: 'volcengine', label: '豆包(火山)', baseUrl: '', models: [] },
  { id: 'custom', label: '自定义', baseUrl: '', models: [] },
];

function Btn({ onClick, children, disabled, title }) {
  return (
    <button className="skin-btn" onClick={onClick} disabled={disabled} title={title} style={{ marginRight: 6 }}>
      {children}
    </button>
  );
}

// ---------------- 对话模型配置 ----------------
function ChatConfig({ onModelChanged }) {
  const [cur, setCur] = useState(null); // 当前生效配置（脱敏）
  const [profiles, setProfiles] = useState(null); // { profiles: [], current }
  const [prov, setProv] = useState('deepseek');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { type: 'ok'|'err', text }

  const load = () => {
    api.getConfig().then((r) => setCur(r)).catch(() => setCur(null));
    api.getProfiles().then((r) => setProfiles(r)).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const onProv = (id) => {
    setProv(id);
    const p = PROVIDERS.find((x) => x.id === id);
    if (p?.baseUrl) setBaseUrl(p.baseUrl);
    if (p?.models?.length && !model) setModel(p.models[0]);
  };
  const provModels = PROVIDERS.find((p) => p.id === prov)?.models || []; // 当前供应商预设模型档（下拉用）

  // 存为档案并应用（原「保存并应用」升级：存档案 + 立即生效 + 重启 pty，一个请求原子完成）
  const doSaveApply = async () => {
    if (!baseUrl || !model || !key) { setMsg({ type: 'err', text: '需要 baseUrl + 模型 + key' }); return; }
    const name = prompt('档案名称（如 deepseek-flash）:', model.replace(/[^a-zA-Z0-9-]/g, '-'));
    if (!name) return;
    if (profiles?.profiles?.includes(name) && !confirm(`档案「${name}」已存在，覆盖？`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.saveApplyProfile({ name, provider: prov, baseUrl, model, authToken: key });
      onModelChanged?.(); // 生效了 → 刷新右上角全局模型显示
      setMsg({ type: 'ok', text: `已保存「${r.applied}」并应用（全局默认）` });
      load();
    } catch (e) { setMsg({ type: 'err', text: e.message || '保存失败' }); }
    setBusy(false);
  };

  const doTest = async () => {
    if (!baseUrl || !model || !key) { setMsg({ type: 'err', text: '需要 baseUrl + 模型 + key' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await api.testConfig({ baseUrl, model, authToken: key });
      setMsg(r.ok ? { type: 'ok', text: `连通成功（${r.latencyMs}ms）` } : { type: 'err', text: `连通失败：${r.error}` });
    } catch (e) { setMsg({ type: 'err', text: e.message || '测试失败' }); }
    setBusy(false);
  };

  // 存为档案（只存不应用，以后可到档案列表点「应用」切换）
  const doSaveProfile = async () => {
    if (!baseUrl || !model || !key) { setMsg({ type: 'err', text: '需要 baseUrl + 模型 + key' }); return; }
    const name = prompt('档案名称（如 deepseek-flash）:', model.replace(/[^a-zA-Z0-9-]/g, '-'));
    if (!name) return;
    if (profiles?.profiles?.includes(name) && !confirm(`档案「${name}」已存在，覆盖？`)) return;
    setBusy(true);
    try {
      await api.saveProfile({ name, provider: prov, baseUrl, model, authToken: key });
      setMsg({ type: 'ok', text: `档案「${name}」已保存（未应用）` });
      load();
    } catch (e) { setMsg({ type: 'err', text: e.message || '保存失败' }); }
    setBusy(false);
  };

  // 当前生效配置存为档案（卡片区：把正在用的这套一键存档，不应用不重启）
  const doSaveCurrent = async () => {
    if (!cur?.configured) { setMsg({ type: 'err', text: '当前未配置对话模型，无法存为档案' }); return; }
    const defaultName = (cur?.model || '').replace(/[^a-zA-Z0-9-]/g, '-') || 'current';
    const name = prompt('档案名称:', defaultName);
    if (!name) return;
    if (profiles?.profiles?.includes(name) && !confirm(`档案「${name}」已存在，覆盖？`)) return;
    setBusy(true); setMsg(null);
    try {
      await api.saveCurrentProfile({ name });
      setMsg({ type: 'ok', text: `当前生效配置已存为档案「${name}」` });
      load();
    } catch (e) { setMsg({ type: 'err', text: e.message || '保存失败' }); }
    setBusy(false);
  };

  const doApply = async (name) => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.applyProfile({ name });
      onModelChanged?.(); // 应用档案后刷新全局模型显示
      setMsg({ type: 'ok', text: `已应用「${r.applied}」（全局默认）` });
      load();
    } catch (e) { setMsg({ type: 'err', text: e.message || '应用失败' }); }
    setBusy(false);
  };

  const doDelete = async (name) => {
    if (!confirm(`删除档案「${name}」？`)) return;
    setBusy(true);
    try { await api.deleteProfile(name); load(); } catch (e) { setMsg({ type: 'err', text: e.message }); }
    setBusy(false);
  };

  return (
    <div className="skin-section">
      {/* 当前配置卡片 */}
      <div className="skin-card">
        <div className="skin-label">📌 当前生效配置</div>
        {cur ? (
          <div style={{ fontSize: 13, color: '#888' }}>
            供应商 {cur.provider || '—'} · 模型 <b>{cur.model || '—'}</b> · key {cur.keyMask || '—'} ·{' '}
            {cur.configured ? <span style={{ color: '#2ecc71' }}>✅ 已配置</span> : <span style={{ color: '#e74c3c' }}>❌ 未配置</span>}
            <div style={{ marginTop: 4 }}>baseUrl: {cur.baseUrl || '—'}</div>
            <div style={{ marginTop: 8 }}>
              <Btn onClick={doSaveCurrent} disabled={busy} title="把当前正在生效的配置一键存成档案（不用重填）">📚 将当前生效配置存为档案</Btn>
            </div>
          </div>
        ) : (
          <div className="skin-hint">加载中…</div>
        )}
      </div>

      {/* 档案列表 */}
      {profiles && profiles.profiles.length > 0 && (
        <div className="skin-card">
          <div className="skin-label">📚 我的档案（切换=写入全局默认）</div>
          {profiles.profiles.map((name) => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontWeight: profiles.current === name ? 700 : 400, color: profiles.current === name ? '#2ecc71' : 'inherit' }}>
                {profiles.current === name ? '● ' : '○ '}{name}
              </span>
              <Btn onClick={() => doApply(name)} disabled={busy}>应用</Btn>
              <Btn onClick={() => doDelete(name)} disabled={busy}>删除</Btn>
            </div>
          ))}
        </div>
      )}

      {/* 表单 */}
      <div className="skin-card">
        <div className="skin-label">✏️ 配置 / 切换模型</div>
        <div className="skin-row">
          <span className="skin-label">供应商</span>
          <select className="skin-input" value={prov} onChange={(e) => onProv(e.target.value)}>
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        <div className="skin-row">
          <span className="skin-label">模型档</span>
          <select
            className="skin-input"
            value={provModels.includes(model) ? model : '__custom'}
            onChange={(e) => setModel(e.target.value === '__custom' ? '' : e.target.value)}
          >
            {provModels.map((m) => <option key={m} value={m}>{m}</option>)}
            <option value="__custom">✏️ 自定义…</option>
          </select>
        </div>
        {!provModels.includes(model) && model && (
          <div className="skin-row">
            <span className="skin-label">模型名</span>
            <input className="skin-input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="手输模型名" />
          </div>
        )}
        <div className="skin-row">
          <span className="skin-label">baseUrl</span>
          <input className="skin-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Anthropic 兼容端点，不以 / 结尾" />
        </div>
        <div className="skin-row">
          <span className="skin-label">API Key</span>
          <input className="skin-input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-…" />
        </div>
        <div style={{ marginTop: 8 }}>
          <Btn onClick={doSaveApply} disabled={busy}>💾 存为档案并应用</Btn>
          <Btn onClick={doTest} disabled={busy}>🧪 测试连通</Btn>
          <Btn onClick={doSaveProfile} disabled={busy}>📚 存为档案</Btn>
        </div>
        {msg && <div className="skin-hint" style={{ color: msg.type === 'ok' ? '#2ecc71' : '#e74c3c', marginTop: 8 }}>{msg.text}</div>}
      </div>
    </div>
  );
}

// ---------------- 生图/生视频 预设清单 ----------------
function MediaConfig({ kind, title }) {
  const [rows, setRows] = useState(null); // [{id,label,baseUrl,apiKey(掩码),baseUrlDraft,keyDraft}]
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = () => {
    api.getMediaConfig().then((r) => {
      const list = r[kind] || [];
      setRows(list.map((it) => ({ ...it, baseUrlDraft: it.baseUrl || '', keyDraft: '' })));
    }).catch(() => setRows([]));
  };
  useEffect(() => { load(); }, [kind]);

  const patchRow = (id, patch) => setRows((prev) => (prev || []).map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const doSave = async (row) => {
    if (!row.keyDraft.trim()) { setMsg({ type: 'err', text: 'API key 不能为空' }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.saveMediaItem({ kind, model: row.id, baseUrl: row.baseUrlDraft.trim() || undefined, apiKey: row.keyDraft.trim() });
      setMsg({ type: 'ok', text: `「${row.label}」已保存` });
      load();
    } catch (e) { setMsg({ type: 'err', text: e.message || '保存失败' }); }
    setBusy(false);
  };

  const doDelete = async (row) => {
    if (!confirm(`清除「${row.label}」配置？`)) return;
    setBusy(true); setMsg(null);
    try { await api.deleteMediaItem(kind, row.id); load(); } catch (e) { setMsg({ type: 'err', text: e.message }); }
    setBusy(false);
  };

  const doTest = async (row) => {
    const baseUrl = row.baseUrlDraft.trim();
    if (!baseUrl) { setMsg({ type: 'err', text: '先填 baseUrl 再测试' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await api.testMedia({ baseUrl });
      setMsg(r.ok ? { type: 'ok', text: `「${row.label}」${r.note}（HTTP ${r.httpStatus}）` } : { type: 'err', text: `「${row.label}」不可达：${r.error}` });
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
    setBusy(false);
  };

  if (!rows) return <div className="skin-hint">加载中…</div>;
  return (
    <div className="skin-section">
      <div className="skin-hint" style={{ marginBottom: 8 }}>填 baseUrl + key，生成时就用填的；没填的模型生成时会提示去配置。</div>
      {rows.map((row) => (
        <div key={row.id} className="skin-card" style={{ marginBottom: 8, padding: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            {row.label}{' '}
            {row.apiKey
              ? <span style={{ color: '#2ecc71', fontSize: 12, fontWeight: 400 }}>✅ 已配置 {row.apiKey}</span>
              : <span style={{ color: '#e74c3c', fontSize: 12, fontWeight: 400 }}>未配置</span>}
          </div>
          <div className="skin-row">
            <span className="skin-label">baseUrl</span>
            <input className="skin-input" value={row.baseUrlDraft} onChange={(e) => patchRow(row.id, { baseUrlDraft: e.target.value })} placeholder="留空=火山默认" />
          </div>
          <div className="skin-row">
            <span className="skin-label">API Key</span>
            <input className="skin-input" type="password" value={row.keyDraft} onChange={(e) => patchRow(row.id, { keyDraft: e.target.value })} placeholder={row.apiKey ? '已配置，重填覆盖' : 'sk-…'} />
          </div>
          <div style={{ marginTop: 6 }}>
            <Btn onClick={() => doSave(row)} disabled={busy}>💾 保存</Btn>
            <Btn onClick={() => doTest(row)} disabled={busy}>🧪 测试连通</Btn>
            {row.apiKey && <Btn onClick={() => doDelete(row)} disabled={busy}>🗑 清除配置</Btn>}
          </div>
        </div>
      ))}
      {msg && <div className="skin-hint" style={{ color: msg.type === 'ok' ? '#2ecc71' : '#e74c3c', marginTop: 8 }}>{msg.text}</div>}
    </div>
  );
}

// ---------------- 视觉理解（独立配置项） ----------------
function VisionConfig() {
  const [form, setForm] = useState({ baseUrl: '', apiKey: '', model: '' });
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = () => {
    api.getMediaConfig().then((r) => {
      const v = r.vision || {};
      setHasKey(!!v.apiKey);
      setForm({ baseUrl: v.baseUrl || '', apiKey: '', model: v.model || '' });
    }).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const doSave = async () => {
    if (!form.apiKey.trim()) { setMsg({ type: 'err', text: 'API key 不能为空' }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.saveMediaItem({ kind: 'vision', baseUrl: form.baseUrl.trim() || undefined, apiKey: form.apiKey.trim(), model: form.model.trim() || undefined });
      setMsg({ type: 'ok', text: '视觉理解已保存' });
      load();
    } catch (e) { setMsg({ type: 'err', text: e.message || '保存失败' }); }
    setBusy(false);
  };

  const doDelete = async () => {
    if (!confirm('清除视觉理解配置？')) return;
    setBusy(true); setMsg(null);
    try { await api.deleteMediaItem('vision', ''); load(); } catch (e) { setMsg({ type: 'err', text: e.message }); }
    setBusy(false);
  };

  return (
    <div className="skin-section">
      <div className="skin-card">
        <div className="skin-label">
          🤖 视觉理解（AI 读图/读视频/读文档用，跟生成模型分开）
          {hasKey && <span style={{ color: '#2ecc71', fontSize: 12, marginLeft: 8 }}>✅ 已配置</span>}
        </div>
        <div className="skin-row">
          <span className="skin-label">baseUrl</span>
          <input className="skin-input" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="留空=火山默认" />
        </div>
        <div className="skin-row">
          <span className="skin-label">API Key</span>
          <input className="skin-input" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={hasKey ? '已配置，重填覆盖' : 'sk-…'} />
        </div>
        <div className="skin-row">
          <span className="skin-label">模型</span>
          <input className="skin-input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="如 doubao-1-5-vision-pro" />
        </div>
        <div style={{ marginTop: 8 }}>
          <Btn onClick={doSave} disabled={busy}>💾 保存</Btn>
          {hasKey && <Btn onClick={doDelete} disabled={busy}>🗑 清除配置</Btn>}
        </div>
        {msg && <div className="skin-hint" style={{ color: msg.type === 'ok' ? '#2ecc71' : '#e74c3c', marginTop: 8 }}>{msg.text}</div>}
      </div>
    </div>
  );
}

// ---------------- 主组件：四个 tab ----------------
export default function ModelSettings({ onModelChanged }) {
  const [tab, setTab] = useState('chat');
  const TABS = [
    { id: 'chat', label: '💬 对话模型' },
    { id: 'image', label: '🖼 生图' },
    { id: 'video', label: '🎬 生视频' },
    { id: 'vision', label: '🤖 视觉理解' },
  ];
  return (
    <div className="skin-section">
      <div className="skin-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} className={`skin-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === 'chat' && <ChatConfig onModelChanged={onModelChanged} />}
      {tab === 'image' && <MediaConfig kind="image" title="生图" />}
      {tab === 'video' && <MediaConfig kind="video" title="生视频" />}
      {tab === 'vision' && <VisionConfig />}
    </div>
  );
}
