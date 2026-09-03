/**
 * SkinSettings.jsx — 外观设置弹层（4 标签页重构）
 * 主题 / 背景 / 透明度 / 强调色，各归其页，避免一屏堆满。
 */
import { useEffect, useRef, useState } from 'react';
import { skinEngine } from './skinEngine.js';
import { api } from '../api.js';
import ModelSettings from './ModelSettings.jsx';
import { downloadText, exportSessionText } from '../utils/export.js';
import ExportDialog from '../components/ExportDialog.jsx';
import SkillsPanel from '../components/SkillsPanel.jsx';
import LogPanel from '../components/LogPanel.jsx';
import { EFFORT_LEVELS, readDefaultEffort, setDefaultEffort } from '../utils/effort.js';
import { readConfirmMedia, setConfirmMedia } from '../utils/mediaConfirm.js';

const ACCENTS = ['#74c0fc', '#34d399', '#4f83f2', '#f472b6', '#f59e0b', '#a78bfa', '#22d3ee', '#f87171'];
const GRADIENTS = [
  { label: '极光', css: 'linear-gradient(135deg, #022c22 0%, #065f46 60%, #0d9488 100%)' },
  { label: '暗夜', css: 'linear-gradient(135deg, #0f172a 0%, #1e293b 55%, #334155 100%)' },
  { label: '晚霞', css: 'linear-gradient(135deg, #431407 0%, #9a3412 55%, #f97316 100%)' },
  { label: '海洋', css: 'linear-gradient(135deg, #075985 0%, #0284c7 55%, #38bdf8 100%)' },
  { label: '森林', css: 'linear-gradient(135deg, #14532d 0%, #16a34a 55%, #4ade80 100%)' },
  { label: '樱花', css: 'linear-gradient(135deg, #831843 0%, #ec4899 55%, #fbcfe8 100%)' },
  { label: '琥珀', css: 'linear-gradient(135deg, #78350f 0%, #d97706 55%, #fbbf24 100%)' },
  { label: '雾灰', css: 'linear-gradient(135deg, #1f2937 0%, #374151 55%, #6b7280 100%)' },
];
const FLUID_PRESET_LIST = [
  { id: 'ocean', label: '海洋' },
  { id: 'aurora', label: '极光' },
  { id: 'ember', label: '火焰' },
  { id: 'neon', label: '霓虹' },
  { id: 'moon', label: '月光' },
];
const TABS = [
  { id: 'theme', label: '🎨 主题' },
  { id: 'background', label: '🖼 背景' },
  { id: 'opacity', label: '🔍 透明度' },
  { id: 'accent', label: '✨ 颜色' },
];

/** 一行滑块：label + range。 */
function SliderRow({ label, value, min = 0, max = 1, step = 0.05, onChange }) {
  return (
    <div className="skin-row">
      <label className="skin-label">{label}</label>
      <input
        type="range" min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export default function SkinSettings({ open, onClose, onModelChanged }) {
  const [, setTick] = useState(0);
  const [tab, setTab] = useState('theme');
  const [section, setSection] = useState('appearance'); // 一级分区：appearance(外观) | features(功能)
  const [accent, setAccent] = useState(() => localStorage.getItem('dsw-dream-skin:accent') || '');
  const [confirmReset, setConfirmReset] = useState(false);
  const [autostart, setAutostart] = useState(null); // null=加载中 / true|false=开关状态
  const [skillsOpen, setSkillsOpen] = useState(false); // 已装 Skills 查看面板
  const [logOpen, setLogOpen] = useState(false); // 日志面板
  const [defaultEffort, setDefEffort] = useState(readDefaultEffort); // 全局默认思考档位（省/标准/强力）
  const [confirmMedia, setConfirmMediaState] = useState(readConfirmMedia); // 生成图片/视频前确认（默认开）
  const [remote, setRemote] = useState(null); // null=加载中 / {enabled, publicUrl, pairCode}
  const [remoteBusy, setRemoteBusy] = useState(false); // 开关切换中（防连点）
  const [appVersion, setAppVersion] = useState(null); // 底部版本号（后端 /api/health 带，随 package.json 自动更新）

  // 打开设置时刷新默认档 / 生成确认开关：组件常驻挂载，运行期 localStorage 可能被改/清，避免显示启动时旧值
  useEffect(() => {
    if (open) {
      setDefEffort(readDefaultEffort());
      setConfirmMediaState(readConfirmMedia());
    }
  }, [open]);
  // 打开设置时拉版本号（9-03：底部版本 + 署名；拿不到就只显示署名，静默不报错）
  useEffect(() => {
    if (open) {
      api.health().then((r) => setAppVersion(r?.version || null)).catch(() => {});
    }
  }, [open]);
  const fileRef = useRef(null);

  // 打开设置时读取开机自启当前状态
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.getAutostart().then((r) => { if (!cancelled) setAutostart(r.enabled); }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  // 打开设置时读取远程访问状态（enabled/publicUrl/pairCode）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.remoteStatus().then((r) => { if (!cancelled) setRemote(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  const toggleAutostart = async () => {
    const next = !autostart;
    setAutostart(next); // 乐观更新
    try {
      const r = await api.setAutostart(next);
      if (r.enabled !== next) setAutostart(r.enabled);
    } catch {
      setAutostart(!next); // 失败回滚
    }
  };

  // 远程访问开关：开启=起代理+隧道+生成配对码；关闭=全停
  const toggleRemote = async () => {
    if (remoteBusy) return;
    const next = !(remote?.enabled ?? false);
    setRemoteBusy(true);
    try {
      const r = next ? await api.remoteOn() : await api.remoteOff();
      setRemote(r);
      // 开启动作但服务端实际没开起来（如代理端口被占）→ 给明确提示，不静默
      if (next && r.enabled === false) {
        // 服务端带回真实失败原因（9-02 教训：QQ 固定占 4001，曾把"端口被占"误导成"cloudflared 未装"）
        alert(r.error || '远程开启失败，请检查后重试');
      }
    } catch {
      // 网络/异常失败
      const e = (remote?.enabled ?? false) ? '关闭失败' : '开启失败，请稍后重试';
      alert(e);
    } finally {
      setRemoteBusy(false);
    }
  };

  // 重新生成配对码（换新码 = 旧设备全部失效，需重新配对；换码期间禁用防竞态）
  const regenerateCode = async () => {
    if (remoteBusy) return;
    setRemoteBusy(true);
    try {
      const r = await api.remoteRegenerateCode();
      setRemote((prev) => ({ ...prev, pairCode: r.pairCode }));
    } catch {
      alert('换码失败，请重试');
    } finally {
      setRemoteBusy(false);
    }
  };

  // 一键恢复默认（按管辖范围分开，footer 按钮按一级分区分流）
  // - 外观：清外观设置 → 刷新回出厂
  // - 功能：清猫娘/思考档位 + 关自启/远程（服务端，幂等）→ 全部落定后刷新，让开关显示真实状态
  const handleReset = async () => {
    setConfirmReset(false);
    if (section === 'appearance') {
      skinEngine.resetAll('appearance');
      window.location.reload();
      return;
    }
    skinEngine.resetAll('functions'); // 清猫娘开关（localStorage）
    setDefaultEffort(null);            // 思考档位回标准
    const results = await Promise.allSettled([api.setAutostart(false), api.remoteOff()]);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) alert('恢复功能默认：开机自启/远程访问关闭失败，请检查后重试');
    window.location.reload();
  };

  // 导出全部会话：统一面板选 txt/zip（含思考勾选）
  const [exportAllOpen, setExportAllOpen] = useState(false);
  const handleExportAllDialog = async (format, includeThinking) => {
    if (format === 'zip') {
      // 数据备份：全部会话打包 zip（后端 export-all，含完整数据）
      const a = document.createElement('a');
      a.href = '/api/sessions/export-all';
      a.download = '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    }
    try {
      const { sessions } = await api.listSessions();
      const parts = [];
      for (const s of sessions) {
        const { messages } = await api.listMessages(s.id);
        parts.push(exportSessionText(s, messages, { includeThinking }));
      }
      const d = new Date();
      const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      downloadText(`ClaudeNeko-全部会话-${date}.txt`, parts.join('\n\n'));
    } catch {
      // 导出失败静默
    }
  };

  useEffect(() => {
    if (!open) return;
    const unsub = skinEngine.subscribe(() => setTick((t) => t + 1));
    return unsub;
  }, [open]);

  if (!open) return null;

  const current = skinEngine.currentSkinId;
  const wallpaperSet = skinEngine.wallpaper.backgroundCss !== null;
  const wp = skinEngine.wallpaper;

  const onPickFile = (e) => {
    const file = e.target.files?.[0];
    // 读完后重置 input 值：否则再次选择同一文件不触发 change 事件
    e.target.value = '';
    if (!file) return;
    // localStorage 存 dataURL 有 ~5MB 上限，超限会静默失败，提前拦截并提示
    if (file.size > 4 * 1024 * 1024) {
      alert('图片太大（>4MB），浏览器本地存不下，请换小一点的图');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => skinEngine.wallpaper.setImage(reader.result);
    reader.readAsDataURL(file);
  };

  return (
    <div className="skin-modal" onClick={onClose}>
      <div className="skin-modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="skin-modal-header">
          <span className="skin-modal-title">{section === 'appearance' ? '外观 / Theme' : section === 'features' ? '功能 / Features' : '模型配置 / Model'}</span>
          <button className="skin-close" onClick={onClose} title="关闭">✕</button>
        </div>

        {/* 一级分区：外观 | 功能（左侧竖排） */}
        <div className="skin-layout">
          <div className="skin-nav" role="navigation">
            <button
              className={`skin-nav-btn${section === 'appearance' ? ' active' : ''}`}
              onClick={() => setSection('appearance')}
            >
              外观
            </button>
            <button
              className={`skin-nav-btn${section === 'features' ? ' active' : ''}`}
              onClick={() => setSection('features')}
            >
              功能
            </button>
            <button
              className={`skin-nav-btn${section === 'model' ? ' active' : ''}`}
              onClick={() => setSection('model')}
            >
              模型配置
            </button>
          </div>
          <div className="skin-main">
          {section === 'appearance' ? (
            <>
            <div className="skin-tabs" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  className={`skin-tab${tab === t.id ? ' active' : ''}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="skin-tab-body">
          {/* ============ 主题页 ============ */}
          {tab === 'theme' && (
            <div className="skin-section">
              <div className="skin-section-title">主题</div>
              <div className="skin-grid">
                <button
                  className={`skin-card ${current === 'system' ? 'active' : ''}`}
                  onClick={() => skinEngine.setSkin('system')}
                >
                  <span className="skin-swatch" style={{ background: 'linear-gradient(135deg,#1e293b 50%,#f1f5f9 50%)' }} />
                  <span>跟随系统</span>
                </button>
                {skinEngine.skins.map((s) => (
                  <button
                    key={s.id}
                    className={`skin-card ${current === s.id ? 'active' : ''}`}
                    onClick={() => skinEngine.setSkin(s.id)}
                    title={s.id}
                  >
                    <span
                      className="skin-swatch"
                      style={{
                        background: s.tokens['--dsw-alias-bg-base'],
                        boxShadow: `inset 0 0 0 2px ${s.tokens['--dsw-alias-border-l1']}, inset 0 0 0 6px ${s.tokens['--dsw-alias-brand-primary']}`,
                      }}
                    />
                    <span>{s.id}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ============ 背景页 ============ */}
          {tab === 'background' && (
            <div className="skin-section">
              <div className="skin-section-title">背景图片</div>
              <div className="skin-row">
                <button className="skin-btn" onClick={() => fileRef.current?.click()}>上传图片</button>
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickFile} />
                {skinEngine.wallpaper.hasImage && (
                  <button className="skin-btn" onClick={() => skinEngine.wallpaper.reuseImage()}>图片</button>
                )}
                <input
                  className="skin-input"
                  placeholder="粘贴图片 URL 后回车"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.target.value.trim()) {
                      skinEngine.wallpaper.setUrl(e.target.value.trim());
                      e.target.value = '';
                    }
                  }}
                />
                <button className="skin-btn" onClick={() => skinEngine.wallpaper.setFluid()}>流体</button>
                <button className="skin-btn danger" onClick={() => skinEngine.wallpaper.clear()}>清除</button>
              </div>

              {/* 渐变预设（点哪个用哪个） */}
              <div className="skin-section-title" style={{ marginTop: 12 }}>渐变</div>
              <div className="skin-row">
                {GRADIENTS.map((g) => (
                  <button
                    key={g.label}
                    className={`skin-btn${skinEngine.wallpaper.gradientCss === g.css ? ' active' : ''}`}
                    onClick={() => skinEngine.wallpaper.setGradient(g.css)}
                  >{g.label}</button>
                ))}
              </div>

              {/* 上传图片后的缩略图预览 */}
              {skinEngine.wallpaper.kind === 'image' && skinEngine.wallpaper.imageDataUrl && (
                <div className="skin-thumb-row">
                  <img className="skin-thumb" src={skinEngine.wallpaper.imageDataUrl} alt="当前背景图" />
                  <span className="skin-hint">当前背景图预览</span>
                </div>
              )}

              {skinEngine.wallpaper.kind === 'fluid' ? (
                <>
                  <div className="skin-section-title" style={{ marginTop: 12 }}>流体样式</div>
                  <div className="skin-row">
                    {FLUID_PRESET_LIST.map((p) => (
                      <button
                        key={p.id}
                        className={`skin-btn${skinEngine.fluid.preset === p.id ? ' active' : ''}`}
                        onClick={() => skinEngine.fluid.setPreset(p.id)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <SliderRow label="色相" value={skinEngine.fluid.hue} min={0} max={360} step={1} onChange={(v) => skinEngine.fluid.setHue(v)} />
                  <SliderRow label="速度" value={skinEngine.fluid.speed} min={0} max={100} step={1} onChange={(v) => skinEngine.fluid.setSpeed(v)} />
                  <SliderRow label="漩涡" value={skinEngine.fluid.swirl} min={0} max={40} step={1} onChange={(v) => skinEngine.fluid.setSwirl(v)} />
                  <SliderRow label="饱和度" value={skinEngine.fluid.saturation} min={0} max={100} step={1} onChange={(v) => skinEngine.fluid.setSaturation(v)} />
                  <SliderRow label="亮度" value={skinEngine.fluid.brightness} min={0} max={100} step={1} onChange={(v) => skinEngine.fluid.setBrightness(v)} />
                  <SliderRow label="色彩数" value={skinEngine.fluid.colorCount} min={1} max={3} step={1} onChange={(v) => skinEngine.fluid.setColorCount(v)} />
                </>
              ) : wallpaperSet ? (
                <SliderRow label="壁纸模糊" value={wp.blur} min={0} max={30} step={1} onChange={(v) => wp.setBlur(v)} />
              ) : (
                <div className="skin-hint">上传本地图片，或粘贴一张图片网址，或点「渐变 / 流体」试试。</div>
              )}
            </div>
          )}

          {/* ============ 透明度页 ============ */}
          {tab === 'opacity' && (
            <>
              <div className="skin-section">
                <div className="skin-section-title">面板</div>
                <SliderRow label="侧栏" value={wp.sidebarOpacity} onChange={(v) => wp.setSidebarOpacity(v)} />
                <SliderRow label="输入区" value={wp.composerOpacity} onChange={(v) => wp.setComposerOpacity(v)} />
                <SliderRow label="聊天区" value={wp.chatOpacity} onChange={(v) => wp.setChatOpacity(v)} />
              </div>
              <div className="skin-section">
                <div className="skin-section-title">消息</div>
                <SliderRow label="AI 气泡" value={wp.assistantOpacity} onChange={(v) => wp.setAssistantOpacity(v)} />
                <SliderRow label="用户气泡" value={wp.userOpacity} onChange={(v) => wp.setUserOpacity(v)} />
                <SliderRow label="代码块" value={wp.codeOpacity} onChange={(v) => wp.setCodeOpacity(v)} />
              </div>
            </>
          )}

          {/* ============ 强调色页 ============ */}
          {tab === 'accent' && (
            <>
              <div className="skin-section">
                <div className="skin-section-title">强调色</div>
                <div className="skin-row">
                  {ACCENTS.map((c) => (
                    <button
                      key={c}
                      className={`skin-accent ${accent === c ? 'active' : ''}`}
                      style={{ background: c }}
                      onClick={() => {
                        setAccent(c);
                        localStorage.setItem('dsw-dream-skin:accent', c);
                        skinEngine.accent.apply(c);
                      }}
                    />
                  ))}
                  <button
                    className="skin-btn"
                    onClick={() => {
                      setAccent('');
                      localStorage.removeItem('dsw-dream-skin:accent');
                      skinEngine.accent.clear();
                    }}
                  >默认</button>
                </div>
              </div>
              <div className="skin-section">
                <div className="skin-section-title">字体颜色</div>
                <div className="skin-row">
                  <input
                    type="color"
                    className="skin-color"
                    value={skinEngine.textColor.value || '#f9fafb'}
                    onChange={(e) => skinEngine.textColor.apply(e.target.value)}
                  />
                  <span className="skin-hint">主文字颜色（自由取色，覆盖主题文字色）</span>
                  <button
                    className="skin-btn"
                    onClick={() => skinEngine.textColor.clear()}
                  >恢复主题色</button>
                </div>
              </div>
            </>
          )}
            </div>
            </>
          ) : section === 'features' ? (
            <div className="skin-tab-body">
              <div className="skin-section">
                <div className="skin-section-title">功能</div>
                <div className="skin-row">
                  <span>默认思考档位（新建会话使用；对话中右上角可随时改）</span>
                </div>
                <div className="skin-row">
                  {EFFORT_LEVELS.map((lvl) => (
                    <button
                      key={String(lvl.id)}
                      className={`skin-btn${(defaultEffort ?? null) === (lvl.id ?? null) ? ' active' : ''}`}
                      title={lvl.tip}
                      onClick={() => {
                        setDefEffort(lvl.id);
                        setDefaultEffort(lvl.id);
                      }}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <div className="skin-row">
                  <span>开机自启（登录时后台启动服务，不用再点 neko://）</span>
                  <button
                    className={`skin-btn${autostart ? ' active' : ''}`}
                    onClick={toggleAutostart}
                    disabled={autostart === null}
                  >
                    {autostart === null ? '…' : autostart ? '开 ✓' : '关'}
                  </button>
                </div>
                <div className="skin-row">
                  <span>远程访问（手机/公网连接，需配对码；桌面本地不受影响）</span>
                  <button
                    className={`skin-btn${remote?.enabled ? ' active' : ''}`}
                    onClick={toggleRemote}
                    disabled={remote === null || remoteBusy}
                  >
                    {remote === null ? '…' : remoteBusy ? '…' : remote?.enabled ? '开 ✓' : '关'}
                  </button>
                </div>
                {remote?.enabled && (
                  <div className="skin-section" style={{ marginTop: 8 }}>
                    <div className="skin-hint">
                      手机浏览器打开公网地址，输入配对码即可（配对一次，之后免输）。
                    </div>
                    <div className="skin-hint" style={{ wordBreak: 'break-all' }}>
                      📱 {remote.publicUrl || '（未能获取公网地址：cloudflared 未找到/被拦截/网络不通，远程暂不可用）'}
                    </div>
                    <div className="skin-row">
                      <span>配对码：{remote.pairCode ?? '—'}</span>
                      <button className="skin-btn" onClick={regenerateCode} disabled={remoteBusy}>换码</button>
                    </div>
                  </div>
                )}
                <div className="skin-row">
                  <span>生成图片/视频前确认（防误触费钱，默认关）</span>
                  <button
                    className={`skin-btn${confirmMedia ? ' active' : ''}`}
                    onClick={() => {
                      const next = !confirmMedia;
                      setConfirmMediaState(next);
                      setConfirmMedia(next);
                    }}
                  >
                    {confirmMedia ? '开 ✓' : '关'}
                  </button>
                </div>
                <div className="skin-row">
                  <span>猫猫（右下角粒子猫，可拖动）</span>
                  <button
                    className={`skin-btn${skinEngine.catVisible ? ' active' : ''}`}
                    onClick={() => skinEngine.setCatVisible(!skinEngine.catVisible)}
                  >
                    {skinEngine.catVisible ? '开 ✓' : '关'}
                  </button>
                </div>
                <div className="skin-row">
                  <span>claude娘（挂件互动，默认关）</span>
                  <button
                    className={`skin-btn${skinEngine.niangVisible ? ' active' : ''}`}
                    onClick={() => skinEngine.setNiangVisible(!skinEngine.niangVisible)}
                  >
                    {skinEngine.niangVisible ? '开 ✓' : '关'}
                  </button>
                </div>
                <div className="skin-hint">
                  点击 claude娘 可查询 DeepSeek 官网 api 余额{' '}
                  <a href="https://platform.deepseek.com" target="_blank" rel="noopener noreferrer">🔗</a>
                </div>
                <div className="skin-row">
                  <span>导出全部会话（文本 / 数据备份，可勾选含思考）</span>
                  <button className="skin-btn" onClick={() => setExportAllOpen(true)}>导出</button>
                </div>
                <div className="skin-row">
                  <span>已装 Skills（查看全部技能）</span>
                  <button className="skin-btn" onClick={() => setSkillsOpen(true)}>查看</button>
                </div>
                <div className="skin-row">
                  <span>查看日志（server/log.txt，排雷用）</span>
                  <button className="skin-btn" onClick={() => setLogOpen(true)}>查看</button>
                </div>
                <div className="skin-hint">更多功能开关会陆续加到这里</div>
              </div>
            </div>
          ) : null}
          {section === 'model' && <ModelSettings onModelChanged={onModelChanged} />}
          </div>
        </div>

        <div className="skin-footer">
          {section !== 'model' && (
            <button
              className={`skin-btn danger${confirmReset ? ' active' : ''}`}
              onClick={() => {
                if (!confirmReset) {
                  setConfirmReset(true);
                  setTimeout(() => setConfirmReset(false), 2500);
                  return;
                }
                handleReset();
              }}
            >
              {confirmReset
                ? (section === 'appearance' ? '再点一次确认恢复外观默认' : '再点一次确认恢复功能默认（含关闭自启与远程）')
                : (section === 'appearance' ? '恢复外观默认' : '恢复功能默认')}
            </button>
          )}
        </div>
        <div className="skin-credit-wrap">
          {appVersion && <div className="skin-version">ClaudeNeko {appVersion}</div>}
          <div className="skin-credit">仰天大笑×孑孓羽然 共同开发</div>
        </div>
        <SkillsPanel open={skillsOpen} onClose={() => setSkillsOpen(false)} />
        <LogPanel open={logOpen} onClose={() => setLogOpen(false)} />
        {exportAllOpen && (
          <ExportDialog
            title="导出全部会话"
            scopeLabel="全部会话 · 文本或数据备份"
            formats={[
              { value: 'txt', label: '文本 (.txt)' },
              { value: 'zip', label: '数据备份 (.zip)' },
            ]}
            onExport={handleExportAllDialog}
            onClose={() => setExportAllOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
