/**
 * SkinSettings.jsx — 外观设置弹层（4 标签页重构）
 * 主题 / 背景 / 透明度 / 强调色，各归其页，避免一屏堆满。
 */
import { useEffect, useRef, useState } from 'react';
import { skinEngine } from './skinEngine.js';
import { api } from '../api.js';

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

export default function SkinSettings({ open, onClose }) {
  const [, setTick] = useState(0);
  const [tab, setTab] = useState('theme');
  const [section, setSection] = useState('appearance'); // 一级分区：appearance(外观) | features(功能)
  const [accent, setAccent] = useState(() => localStorage.getItem('dsw-dream-skin:accent') || '');
  const [confirmReset, setConfirmReset] = useState(false);
  const [autostart, setAutostart] = useState(null); // null=加载中 / true|false=开关状态
  const fileRef = useRef(null);

  // 打开设置时读取开机自启当前状态
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.getAutostart().then((r) => { if (!cancelled) setAutostart(r.enabled); }).catch(() => {});
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
          <span className="skin-modal-title">{section === 'appearance' ? '外观 / Theme' : '功能 / Features'}</span>
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

              {/* 示例图 URL 快捷按钮（点一下直接换背景） */}
              <div className="skin-row" style={{ marginTop: 8 }}>
                <span className="skin-hint">示例图：</span>
                <button className="skin-btn" onClick={() => skinEngine.wallpaper.setUrl('https://picsum.photos/1920/1080')}>随机风景图</button>
                <button className="skin-btn" onClick={() => skinEngine.wallpaper.setUrl('https://picsum.photos/id/237/1920/1080')}>固定狗图</button>
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
                    <button className={`skin-btn${skinEngine.fluid.preset === 'ocean' ? ' active' : ''}`} onClick={() => skinEngine.fluid.setPreset('ocean')}>海洋</button>
                    <button className={`skin-btn${skinEngine.fluid.preset === 'aurora' ? ' active' : ''}`} onClick={() => skinEngine.fluid.setPreset('aurora')}>极光</button>
                    <button className={`skin-btn${skinEngine.fluid.preset === 'ember' ? ' active' : ''}`} onClick={() => skinEngine.fluid.setPreset('ember')}>火焰</button>
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
          ) : (
            <div className="skin-tab-body">
              <div className="skin-section">
                <div className="skin-section-title">功能</div>
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
                  <span>猫猫（右下角粒子猫，可拖动）</span>
                  <button
                    className={`skin-btn${skinEngine.catVisible ? ' active' : ''}`}
                    onClick={() => skinEngine.setCatVisible(!skinEngine.catVisible)}
                  >
                    {skinEngine.catVisible ? '开 ✓' : '关'}
                  </button>
                </div>
                <div className="skin-hint">更多功能开关会陆续加到这里</div>
              </div>
            </div>
          )}
          </div>
        </div>

        <div className="skin-footer">
          <button
            className={`skin-btn danger${confirmReset ? ' active' : ''}`}
            onClick={() => {
              if (!confirmReset) {
                setConfirmReset(true);
                setTimeout(() => setConfirmReset(false), 2500);
                return;
              }
              skinEngine.resetAll();
            }}
          >
            {confirmReset ? '再点一次确认恢复默认' : '一键恢复默认'}
          </button>
          <span>仰天大笑 × 孑孓羽然 共同开发 · 外观灵感源自 dsh-dream-skin / Aqua（MIT）</span>
        </div>
      </div>
    </div>
  );
}
