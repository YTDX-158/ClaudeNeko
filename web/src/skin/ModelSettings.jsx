// ModelSettings.jsx — 设置中心「模型配置」分区
// ============================================
// 三个 tab：对话模型 / 生图 / 生视频
// - 对话模型：当前配置 + 档案（切换/存/删）+ 表单（供应商/模型/key）+ 测试连通
// - 生图/生视频：模型条目列表（每项完整接入）+ 增删改 + 可达性测试
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

  const doSave = async () => {
    if (!baseUrl || !model || !key) { setMsg({ type: 'err', text: '需要 baseUrl + 模型 + key' }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.setConfig({ baseUrl, model, authToken: key });
      onModelChanged?.(); // 保存后刷新右上角全局模型显示
      setMsg({ type: 'ok', text: '已保存（全局默认），新会话/重启后生效' });
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

  const doSaveProfile = async () => {
    if (!baseUrl || !model || !key) { setMsg({ type: 'err', text: '需要 baseUrl + 模型 + key' }); return; }
    const name = prompt('档案名称（如 deepseek-flash）:', model.replace(/[^a-zA-Z0-9-]/g, '-'));
    if (!name) return;
    setBusy(true);
    try {
      await api.saveProfile({ name, provider: prov, baseUrl, model, authToken: key });
      setMsg({ type: 'ok', text: `档案「${name}」已保存` });
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
          <Btn onClick={doSave} disabled={busy}>💾 保存并应用</Btn>
          <Btn onClick={doTest} disabled={busy}>🧪 测试连通</Btn>
          <Btn onClick={doSaveProfile} disabled={busy}>📚 存为档案</Btn>
        </div>
        {msg && <div className="skin-hint" style={{ color: msg.type === 'ok' ? '#2ecc71' : '#e74c3c', marginTop: 8 }}>{msg.text}</div>}
      </div>
    </div>
  );
}

// ---------------- 生图/生视频 模型条目 ----------------
function MediaConfig({ kind, title }) {
  const [items, setItems] = useState(null);
  const [form, setForm] = useState({ id: null, name: '', provider: '', baseUrl: '', model: '', apiKey: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = () => {
    api.getMediaConfig(kind).then((r) => setItems(r.items)).catch(() => setItems([]));
  };
  useEffect(() => { load(); }, [kind]);

  const resetForm = () => setForm({ id: null, name: '', provider: '', baseUrl: '', model: '', apiKey: '' });

  const doSave = async () => {
    const { id, name, provider, baseUrl, model, apiKey } = form;
    if (!name || !baseUrl || !model || !apiKey) { setMsg({ type: 'err', text: '需要 name + baseUrl + 模型 + key' }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.saveMediaItem({ kind, id: id || undefined, name, provider: provider || 'custom', baseUrl, model, apiKey });
      setMsg({ type: 'ok', text: id ? '条目已更新' : '条目已添加' });
      resetForm(); load();
    } catch (e) { setMsg({ type: 'err', text: e.message || '保存失败' }); }
    setBusy(false);
  };

  const doDelete = async (id) => {
    if (!confirm('删除该模型条目？')) return;
    setBusy(true);
    try { await api.deleteMediaItem(kind, id); load(); } catch (e) { setMsg({ type: 'err', text: e.message }); }
    setBusy(false);
  };

  const doTest = async (item) => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.testMedia({ baseUrl: item.baseUrl });
      setMsg(r.ok ? { type: 'ok', text: `「${item.name}」${r.note}（HTTP ${r.httpStatus}）` } : { type: 'err', text: `「${item.name}」不可达：${r.error}` });
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
    setBusy(false);
  };

  return (
    <div className="skin-section">
      {items && items.length > 0 && (
        <div className="skin-card">
          <div className="skin-label">📦 {title}模型条目（每个模型可独立 API）</div>
          {items.map((it) => (
            <div key={it.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <b>{it.name}</b>
                <span style={{ fontSize: 12, color: '#888' }}>{it.model} · {it.provider} · key {it.apiKey}</span>
                <Btn onClick={() => setForm({ id: it.id, name: it.name, provider: it.provider, baseUrl: it.baseUrl, model: it.model, apiKey: '' })} disabled={busy}>编辑</Btn>
                <Btn onClick={() => doTest(it)} disabled={busy}>测试</Btn>
                <Btn onClick={() => doDelete(it.id)} disabled={busy}>删除</Btn>
              </div>
              <div style={{ fontSize: 12, color: '#bbb', wordBreak: 'break-all' }}>{it.baseUrl}</div>
            </div>
          ))}
        </div>
      )}
      {items && items.length === 0 && <div className="skin-hint">还没有{title}模型条目（默认用 VISION_API_KEY）</div>}

      <div className="skin-card">
        <div className="skin-label">{form.id ? `✏️ 编辑 ${title}条目` : `➕ 新增 ${title}模型条目`}</div>
        <div className="skin-row"><span className="skin-label">名称</span><input className="skin-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 Seedance 2.5" /></div>
        <div className="skin-row"><span className="skin-label">供应商</span><input className="skin-input" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} placeholder="如 volcengine / 中转名" /></div>
        <div className="skin-row"><span className="skin-label">baseUrl</span><input className="skin-input" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="API 端点" /></div>
        <div className="skin-row"><span className="skin-label">模型</span><input className="skin-input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="模型名" /></div>
        <div className="skin-row"><span className="skin-label">API Key</span><input className="skin-input" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={form.id ? '留空=不改' : 'sk-…'} /></div>
        <div style={{ marginTop: 8 }}>
          <Btn onClick={doSave} disabled={busy}>{form.id ? '💾 保存修改' : '➕ 添加'}</Btn>
          {form.id && <Btn onClick={resetForm} disabled={busy}>取消</Btn>}
        </div>
        {msg && <div className="skin-hint" style={{ color: msg.type === 'ok' ? '#2ecc71' : '#e74c3c', marginTop: 8 }}>{msg.text}</div>}
      </div>
    </div>
  );
}

// ---------------- 主组件：三个 tab ----------------
export default function ModelSettings({ onModelChanged }) {
  const [tab, setTab] = useState('chat');
  const TABS = [
    { id: 'chat', label: '💬 对话模型' },
    { id: 'image', label: '🖼 生图' },
    { id: 'video', label: '🎬 生视频' },
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
    </div>
  );
}
