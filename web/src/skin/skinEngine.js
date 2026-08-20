/**
 * skinEngine.js — 移植自 dsh-dream-skin 的核心能力
 * =================================================
 * 在 claude-web 里复刻 dream-skin 的完整功能：
 *   1. 8 套主题（SKINS 数据来自 dream-skin，MIT）
 *   2. 自设背景图片 / URL / 渐变 + 透明度 + 模糊
 *   3. 强调色 override
 *   4. localStorage 持久化（皮肤选择 + 壁纸设置）
 *   5. 主题切换订阅通知（供 React UI 实时刷新）
 *
 * 实现原理：把主题的 --dsw-alias-* / --dsw-specific-* 设计令牌
 * 写入 <html> 的 CSS 变量，claude-web 的样式通过 var() 映射消费。
 */

import { SKINS } from './SKINS.js';

/* ============ localStorage 键 ============ */
const STORAGE_SKIN = 'dsw-dream-skin:skin';
const STORAGE_WALLPAPER = 'dsw-dream-skin:wallpaper'; // dataURL (image)
const STORAGE_BLUR = 'dsw-dream-skin:wallpaper-blur';
const STORAGE_KIND = 'dsw-dream-skin:wallpaper-kind'; // image | url | gradient
const STORAGE_URL = 'dsw-dream-skin:wallpaper-url';
const STORAGE_GRADIENT = 'dsw-dream-skin:wallpaper-gradient';
const STORAGE_SIDEBAR_OPACITY = 'dsw-dream-skin:sidebar-opacity';
const STORAGE_COMPOSER_OPACITY = 'dsw-dream-skin:composer-opacity';
const STORAGE_CHAT_OPACITY = 'dsw-dream-skin:chat-opacity';
const STORAGE_ASSISTANT_OPACITY = 'dsw-dream-skin:assistant-opacity';
const STORAGE_USER_OPACITY = 'dsw-dream-skin:user-opacity';
const STORAGE_CODE_OPACITY = 'dsw-dream-skin:code-opacity';
const STORAGE_FLUID_HUE = 'dsw-dream-skin:fluid-hue';
const STORAGE_FLUID_PRESET = 'dsw-dream-skin:fluid-preset';
const STORAGE_FLUID_SPEED = 'dsw-dream-skin:fluid-speed';
const STORAGE_FLUID_SWIRL = 'dsw-dream-skin:fluid-swirl';
const STORAGE_FLUID_SAT = 'dsw-dream-skin:fluid-saturation';
const STORAGE_FLUID_BRIGHT = 'dsw-dream-skin:fluid-brightness';
const STORAGE_FLUID_COLORS = 'dsw-dream-skin:fluid-colors';
const STORAGE_TEXT_COLOR = 'dsw-dream-skin:text-color';

const DEFAULT_SKIN = 'system';        // 无自定义皮肤 → 跟随系统/内置
const DEFAULT_BLUR = 0;
const DEFAULT_SIDEBAR_OPACITY = 0.95;  // 侧栏
const DEFAULT_COMPOSER_OPACITY = 0.82; // 输入区
const DEFAULT_CHAT_OPACITY = 0.8;      // 聊天区
const DEFAULT_ASSISTANT_OPACITY = 0.85; // AI 气泡
const DEFAULT_USER_OPACITY = 0.9;       // 用户气泡
const DEFAULT_CODE_OPACITY = 1;         // 代码块（默认实色，可调低）

/** 无皮肤 token 时的兜底基色。 */
const BUILTIN_BASE = {
  light: 'rgb(255, 255, 255)',
  dark: 'rgb(21, 21, 23)',
};

/* ============ 工具函数 ============ */
function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* localStorage 满/禁用时静默 */
  }
}

/** 把颜色字符串（#hex / rgb() / rgba()）转成 rgba()。 */
function toRgba(color, alpha) {
  if (!color) return `rgba(21,21,23,${alpha})`;
  const a = alpha ?? 1;
  let m = color.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  m = color.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const s = m[1];
    const n = parseInt(s[0] + s[0] + s[1] + s[1] + s[2] + s[2], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  m = color.match(/^rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*\)$/);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  m = color.match(/^rgba\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)[,\s]*([\d.]+)?\s*\)$/);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${m[4] ?? a})`;
  return color;
}

/** 解析令牌值：可能直接是字符串，也可能是 {light, dark}。 */
function toCssValue(val, scheme) {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val[scheme] ?? val.dark;
  }
  return val;
}

/* ============ 状态 ============ */
let currentSkinId = readStorage(STORAGE_SKIN) || DEFAULT_SKIN;
if (!SKINS.some((s) => s.id === currentSkinId)) currentSkinId = DEFAULT_SKIN;
let overrides = []; // [{ source, tokens }]
const listeners = new Set();

/* ============ 主题 ============ */
function resolveScheme() {
  const skin = SKINS.find((s) => s.id === currentSkinId);
  if (skin) return skin.colorScheme;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

function applyTheme() {
  const root = document.documentElement;
  const scheme = resolveScheme();
  const merged = {};
  const skin = SKINS.find((s) => s.id === currentSkinId);
  if (skin) Object.assign(merged, skin.tokens);
  for (const ov of overrides) Object.assign(merged, ov.tokens);
  for (const [k, v] of Object.entries(merged)) {
    const css = toCssValue(v, scheme);
    if (css !== undefined && css !== null) root.style.setProperty(k, css);
  }
  // 清除残留：移除 documentElement 上"旧主题有、当前 merged 没有"的 --dsw-* 变量
  // （否则切主题后旧色值会残留，覆盖新主题）
  const keep = new Set(Object.keys(merged));
  for (const k of Array.from(root.style)) {
    if (k.startsWith('--dsw-') && !keep.has(k)) root.style.removeProperty(k);
  }
  root.dataset.dsDarkTheme = scheme === 'dark' ? 'true' : 'false';
  root.dataset.dsActiveSkin = currentSkinId;
}

function notify() {
  for (const fn of listeners) fn();
}

/** 当前皮肤的基础背景色（供壁纸 wash 用）。 */
function resolveBase(scheme) {
  const skin = SKINS.find((s) => s.id === currentSkinId);
  if (skin && skin.tokens['--dsw-alias-bg-base']) {
    return toCssValue(skin.tokens['--dsw-alias-bg-base'], scheme);
  }
  return BUILTIN_BASE[scheme] ?? BUILTIN_BASE.dark;
}

/* ============ 壁纸 ============ */
let wallpaperEl = null;
let wallpaperOverrideDispose = null;

function readWallpaperKind() {
  return readStorage(STORAGE_KIND) || 'image'; // 默认按 image 处理（dataURL）
}
/** 读取 0..1 的透明度，非法/缺失时用默认值。 */
function readAlpha(key, def) {
  const raw = readStorage(key);
  if (raw === null || raw === undefined || raw === '') return def;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : def;
}
function readSidebarOpacity() { return readAlpha(STORAGE_SIDEBAR_OPACITY, DEFAULT_SIDEBAR_OPACITY); }
function readComposerOpacity() { return readAlpha(STORAGE_COMPOSER_OPACITY, DEFAULT_COMPOSER_OPACITY); }
function readChatOpacity() { return readAlpha(STORAGE_CHAT_OPACITY, DEFAULT_CHAT_OPACITY); }
function readAssistantOpacity() { return readAlpha(STORAGE_ASSISTANT_OPACITY, DEFAULT_ASSISTANT_OPACITY); }
function readUserOpacity() { return readAlpha(STORAGE_USER_OPACITY, DEFAULT_USER_OPACITY); }
function readCodeOpacity() { return readAlpha(STORAGE_CODE_OPACITY, DEFAULT_CODE_OPACITY); }
function wallpaperBackgroundCss() {
  const kind = readWallpaperKind();
  if (kind === 'gradient') {
    const grad = readStorage(STORAGE_GRADIENT);
    return grad || null;
  }
  if (kind === 'url') {
    const url = readStorage(STORAGE_URL);
    return url ? `url("${url}")` : null;
  }
  const data = readStorage(STORAGE_WALLPAPER);
  return data ? `url("${data}")` : null;
}

let _applyingWallpaper = false;
function applyWallpaper() {
  if (_applyingWallpaper) return;
  _applyingWallpaper = true;
  try {
    const kind = readWallpaperKind();
    // 流体背景：由 WebGL 组件（FluidCanvas）渲染，这里只负责面板 wash
    if (kind === 'fluid') {
      teardownWallpaper();
      shadeTokens();
      return;
    }
    const bg = wallpaperBackgroundCss();
    if (!bg) {
      teardownWallpaper();
      return;
    }
    if (wallpaperEl === null || !document.body.contains(wallpaperEl)) {
      wallpaperEl = document.createElement('div');
      wallpaperEl.id = 'dream-skin-wallpaper';
      wallpaperEl.style.cssText =
        'position:fixed;inset:0;z-index:-1;pointer-events:none;background-size:cover;background-position:center;background-repeat:no-repeat;';
      document.body.prepend(wallpaperEl);
    }
    const blur = Number(readStorage(STORAGE_BLUR)) || 0;
    wallpaperEl.style.backgroundImage = bg;
    wallpaperEl.style.filter = blur > 0 ? `blur(${blur}px)` : 'none';
    shadeTokens();
  } finally {
    _applyingWallpaper = false;
  }
}

/**
 * 用壁纸 wash 覆盖各区域的透明度。
 * 底层（body）不 wash —— 用皮肤实色；各区域（侧栏/输入区/聊天区/气泡/代码块）
 * 通过独立 alpha 半透明，让壁纸透过来。
 */
function shadeTokens() {
  const scheme = resolveScheme();
  const bgColor = resolveBase(scheme);
  const sidebarAlpha = readSidebarOpacity();
  // 会话条目跟随侧栏透明度：hover 略淡一档，active 略亮一档保持区分
  const itemHoverAlpha = Math.min(Math.max(sidebarAlpha - 0.08, 0.2), 1);
  const itemActiveAlpha = Math.min(sidebarAlpha + 0.05, 1);
  const overrides = {
    '--dsw-specific-sidebar-fill': { light: toRgba(bgColor, sidebarAlpha), dark: toRgba(bgColor, sidebarAlpha) },
    '--dsw-specific-sidebar-item-hover': { light: toRgba(bgColor, itemHoverAlpha), dark: toRgba(bgColor, itemHoverAlpha) },
    '--dsw-specific-sidebar-item-active': { light: toRgba(bgColor, itemActiveAlpha), dark: toRgba(bgColor, itemActiveAlpha) },
    '--dsw-specific-composer-bg': { light: toRgba(bgColor, readComposerOpacity()), dark: toRgba(bgColor, readComposerOpacity()) },
    '--dsw-specific-chat-bg': { light: toRgba(bgColor, readChatOpacity()), dark: toRgba(bgColor, readChatOpacity()) },
    '--dsw-specific-assistant-bg': { light: toRgba(bgColor, readAssistantOpacity()), dark: toRgba(bgColor, readAssistantOpacity()) },
    '--dsw-specific-user-bg': { light: toRgba(bgColor, readUserOpacity()), dark: toRgba(bgColor, readUserOpacity()) },
    '--dsw-specific-code-bg': { light: toRgba(bgColor, readCodeOpacity()), dark: toRgba(bgColor, readCodeOpacity()) },
  };
  wallpaperOverrideDispose?.();
  wallpaperOverrideDispose = overrideTokens('dream-skin:wallpaper', overrides);
}

function teardownWallpaper() {
  wallpaperOverrideDispose?.();
  wallpaperOverrideDispose = null;
  if (wallpaperEl && wallpaperEl.parentNode) wallpaperEl.parentNode.removeChild(wallpaperEl);
  wallpaperEl = null;
}

/* ============ 强调色 ============ */
let accentOverrideDispose = null;
function applyAccent(accent) {
  accentOverrideDispose?.();
  if (!accent) return;
  accentOverrideDispose = overrideTokens('dream-skin:accent', {
    '--dsw-alias-brand-primary': { light: accent, dark: accent },
    '--dsw-alias-state-business-primary': { light: accent, dark: accent },
    '--dsw-alias-button-primary-hover': accent,
  });
}

/* ============ 字体颜色 ============ */
let textColorOverrideDispose = null;
function applyTextColor(color) {
  textColorOverrideDispose?.();
  if (!color) return;
  textColorOverrideDispose = overrideTokens('dream-skin:text', {
    '--dsw-alias-label-primary': { light: color, dark: color },
  });
}

/* ============ 对外 API ============ */
function overrideTokens(source, tokens) {
  overrides = overrides.filter((o) => o.source !== source);
  overrides.push({ source, tokens });
  applyTheme();
  return () => {
    overrides = overrides.filter((o) => o.source !== source);
    // 清除该 source 设置过的 CSS 变量，避免残留（如"恢复主题色"后文字色不变）
    for (const k of Object.keys(tokens)) {
      document.documentElement.style.removeProperty(k);
    }
    applyTheme();
  };
}

export const skinEngine = {
  /** 8 套内置主题。 */
  skins: SKINS,
  get currentSkinId() {
    return currentSkinId;
  },
  get scheme() {
    return resolveScheme();
  },

  /* ---- 主题 ---- */
  setSkin(id) {
    if (id !== DEFAULT_SKIN && !SKINS.some((s) => s.id === id)) return;
    currentSkinId = id;
    writeStorage(STORAGE_SKIN, id === DEFAULT_SKIN ? null : id);
    applyTheme();
    notify();
  },
  getTheme() {
    return { preference: currentSkinId, scheme: resolveScheme() };
  },
  /** 注册自定义主题（供"主题包"导入扩展）。 */
  register(skinDef) {
    if (skinDef?.id && skinDef?.tokens) {
      // 直接 push 到 SKINS（运行时扩展）
      if (!SKINS.some((s) => s.id === skinDef.id)) {
        SKINS.push(skinDef);
        applyTheme();
      }
      return () => {
        const i = SKINS.findIndex((s) => s.id === skinDef.id);
        if (i >= 0) SKINS.splice(i, 1);
        applyTheme();
      };
    }
    return () => {};
  },
  /** 令牌覆盖层（壁纸 wash、强调色用）。返回清理函数。 */
  overrideTokens,

  /* ---- 壁纸 ---- */
  wallpaper: {
    /** 当前背景图 CSS（url(...) 或渐变），无则 null。 */
    get backgroundCss() {
      return wallpaperBackgroundCss();
    },
    get kind() {
      return readWallpaperKind();
    },
    /** 当前渐变的 css（kind=gradient 时），用于设置里显示选中态。 */
    get gradientCss() {
      return readWallpaperKind() === 'gradient' ? readStorage(STORAGE_GRADIENT) : null;
    },
    /** 上传的图片 dataURL（kind=image 时），用于设置里显示缩略图；无则 null。 */
    get imageDataUrl() {
      return readWallpaperKind() === 'image' ? readStorage(STORAGE_WALLPAPER) : null;
    },
    /** 是否已上传过图片（无论当前是否在用）。 */
    get hasImage() {
      return !!readStorage(STORAGE_WALLPAPER);
    },
    /** 用回上次上传的图片（切到渐变/流体后再切回，无需重新上传）。 */
    reuseImage() {
      if (!readStorage(STORAGE_WALLPAPER)) return;
      writeStorage(STORAGE_KIND, 'image');
      applyWallpaper();
      notify();
    },
    get blur() {
      return Number(readStorage(STORAGE_BLUR)) || DEFAULT_BLUR;
    },
    /** 本地图片（dataURL）。 */
    setImage(dataUrl) {
      writeStorage(STORAGE_KIND, 'image');
      writeStorage(STORAGE_WALLPAPER, dataUrl);
      applyWallpaper();
      notify();
    },
    /** 远程 URL。 */
    setUrl(url) {
      writeStorage(STORAGE_KIND, 'url');
      writeStorage(STORAGE_URL, url || null);
      applyWallpaper();
      notify();
    },
    /** CSS 渐变。 */
    setGradient(grad) {
      writeStorage(STORAGE_KIND, 'gradient');
      writeStorage(STORAGE_GRADIENT, grad || null);
      applyWallpaper();
      notify();
    },
    setBlur(v) {
      writeStorage(STORAGE_BLUR, String(v));
      // 与其他滑块保持一致：统一走 applyWallpaper 重算（含 filter 应用）
      applyWallpaper();
      notify();
    },
    /** 流体背景：渐变 + 色相流动。 */
    setFluid() {
      writeStorage(STORAGE_KIND, 'fluid');
      applyWallpaper();
      notify();
    },
    /* ---- 各区域独立透明度 ---- */
    get sidebarOpacity() { return readSidebarOpacity(); },
    get composerOpacity() { return readComposerOpacity(); },
    get chatOpacity() { return readChatOpacity(); },
    setSidebarOpacity(v) {
      writeStorage(STORAGE_SIDEBAR_OPACITY, String(v));
      applyWallpaper();
      notify();
    },
    setComposerOpacity(v) {
      writeStorage(STORAGE_COMPOSER_OPACITY, String(v));
      applyWallpaper();
      notify();
    },
    setChatOpacity(v) {
      writeStorage(STORAGE_CHAT_OPACITY, String(v));
      applyWallpaper();
      notify();
    },
    get assistantOpacity() { return readAssistantOpacity(); },
    get userOpacity() { return readUserOpacity(); },
    get codeOpacity() { return readCodeOpacity(); },
    setAssistantOpacity(v) {
      writeStorage(STORAGE_ASSISTANT_OPACITY, String(v));
      applyWallpaper();
      notify();
    },
    setUserOpacity(v) {
      writeStorage(STORAGE_USER_OPACITY, String(v));
      applyWallpaper();
      notify();
    },
    setCodeOpacity(v) {
      writeStorage(STORAGE_CODE_OPACITY, String(v));
      applyWallpaper();
      notify();
    },
    clear() {
      writeStorage(STORAGE_KIND, null);
      writeStorage(STORAGE_WALLPAPER, null);
      writeStorage(STORAGE_URL, null);
      writeStorage(STORAGE_GRADIENT, null);
      teardownWallpaper();
      notify();
    },
  },

  /* ---- 强调色 ---- */
  accent: {
    apply(accent) {
      applyAccent(accent);
      notify();
    },
    clear() {
      applyAccent(null);
      notify();
    },
  },

  /* ---- 字体颜色（主文字，可恢复主题色） ---- */
  textColor: {
    get value() {
      return readStorage(STORAGE_TEXT_COLOR) || '';
    },
    apply(color) {
      writeStorage(STORAGE_TEXT_COLOR, color);
      applyTextColor(color);
      notify();
    },
    clear() {
      writeStorage(STORAGE_TEXT_COLOR, null);
      applyTextColor(null);
      notify();
    },
  },

  /* ---- 流体配置（色相 + 预设） ---- */
  fluid: {
    get hue() {
      const v = Number(readStorage(STORAGE_FLUID_HUE));
      return Number.isFinite(v) ? Math.max(0, Math.min(360, v)) : 215;
    },
    get preset() {
      return readStorage(STORAGE_FLUID_PRESET) || 'ocean';
    },
    setHue(v) {
      writeStorage(STORAGE_FLUID_HUE, String(v));
      notify();
    },
    setPreset(name) {
      writeStorage(STORAGE_FLUID_PRESET, name);
      notify();
    },
    /** 流动速度（0~100，默认 50）。 */
    get speed() {
      const v = Number(readStorage(STORAGE_FLUID_SPEED));
      return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 50;
    },
    setSpeed(v) {
      writeStorage(STORAGE_FLUID_SPEED, String(v));
      notify();
    },
    /** 漩涡感（0~40，默认 12）。 */
    get swirl() {
      const v = Number(readStorage(STORAGE_FLUID_SWIRL));
      return Number.isFinite(v) ? Math.max(0, Math.min(40, v)) : 12;
    },
    setSwirl(v) {
      writeStorage(STORAGE_FLUID_SWIRL, String(v));
      notify();
    },
    /** 饱和度（0~100，默认 75）。 */
    get saturation() {
      const v = Number(readStorage(STORAGE_FLUID_SAT));
      return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 75;
    },
    setSaturation(v) {
      writeStorage(STORAGE_FLUID_SAT, String(v));
      notify();
    },
    /** 亮度（0~100，默认 70）。 */
    get brightness() {
      const v = Number(readStorage(STORAGE_FLUID_BRIGHT));
      return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 70;
    },
    setBrightness(v) {
      writeStorage(STORAGE_FLUID_BRIGHT, String(v));
      notify();
    },
    /** 色彩数量（1/2/3，默认 3）。 */
    get colorCount() {
      const v = Number(readStorage(STORAGE_FLUID_COLORS));
      return v === 1 || v === 2 || v === 3 ? v : 3;
    },
    setColorCount(v) {
      writeStorage(STORAGE_FLUID_COLORS, String(v));
      notify();
    },
  },

  /* ---- 一键恢复默认：清空全部皮肤设置，刷新页面回初始状态 ---- */
  resetAll() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('dsw-dream-skin:')) localStorage.removeItem(k);
      }
    } catch {
      /* localStorage 禁用时忽略 */
    }
    // 刷新页面让所有皮肤状态（主题/壁纸/透明度/磨砂/强调色/流体）回到默认
    window.location.reload();
  },

  /* ---- 订阅：UI 变化时调用，React 组件用它刷新 ---- */
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** 初始化：恢复已保存的皮肤 + 壁纸 + 字体颜色。 */
  init() {
    const saved = readStorage(STORAGE_SKIN);
    if (saved && SKINS.some((s) => s.id === saved)) currentSkinId = saved;
    applyTheme();
    applyWallpaper();
    const savedText = readStorage(STORAGE_TEXT_COLOR);
    if (savedText) applyTextColor(savedText);
    // 跟随系统深色模式变化
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (currentSkinId === DEFAULT_SKIN) applyTheme();
      });
    } catch {
      /* ignore */
    }
  },
};
