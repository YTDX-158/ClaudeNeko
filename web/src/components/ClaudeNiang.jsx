/**
 * ClaudeNiang.jsx — claude娘 挂件（移植自朋友 1.3，与小猫 CatMascot 平级共存）
 *  - claude娘 拟人形象（珊瑚橙学者，透明 PNG），独立 .claude-niang 容器（不占小猫 .cat-mascot）
 *  - 点击 → 冒气泡（颜文字 → DeepSeek 余额 两段式）；**点击优先级最高**：任意时刻点击都先完整播完，
 *    结束后再恢复当前状态气泡（思考中/回答中/打字中）
 *  - 状态气泡：thinking「正在努力思考ing...」/ responding「想出来了！」/ typing「偷窥ing...」
 *  - 挂件交互：拖拽移动（简单拖，同小猫）/ 滚轮缩放 / 右键水平镜像
 *  - ⚠ 性能（8-29 手机卡顿修复）：拖拽用 React state 简单拖（去吸附/Q弹/DOM 直改 left-top）；
 *    组件 memo 化（父级重渲染不带动）+ status 节流（打字中气泡不闪烁）；图片已 1026→320px 减肥 86%
 */
import { memo, useEffect, useRef, useState } from 'react';
import { skinEngine } from '../skin/skinEngine.js';
import claudeNiang from '../assets/claude-niang-widget-transparent.png';
import { KAOMOJI } from '../utils/kaomoji.js';

// 共享颜文字 + claude娘 专属"思考中"（点击气泡用）
const BUBBLES = [...KAOMOJI, '✦ 思考中…'];

// 状态气泡文字：思考中 / 回答中 / 打字中
const STATUS_TEXT = {
  thinking: '正在努力思考ing...',
  responding: '想出来了！',
  typing: '偷窥ing...',
};

const EMOJI_MS = 1200; // 阶段1：颜文字停留时长
const BALANCE_MS = 2500; // 阶段2：余额停留时长（气泡总时长 = 两段之和）
const BASE_W = 150; // 图片显示宽度
const MIN_W = 70;
const MAX_W = 320;
const DRAG_THRESHOLD = 6; // 位移超过 6px 算拖拽，否则算点击（同小猫）

// 持久化键（沿用 dsw-dream-skin: 前缀，一键恢复默认会一并清掉）
const NIANG_POS_KEY = 'dsw-dream-skin:niang-pos';
const NIANG_SIZE_KEY = 'dsw-dream-skin:niang-size';
const NIANG_FLIP_KEY = 'dsw-dream-skin:niang-flip';

// 初始组合位：右下角（底部留出输入框区域）
const EDGE_RIGHT = 26;
const EDGE_BOTTOM = 96;

function readStore(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* localStorage 满/禁用时静默 */
  }
}

/** 初始位置：有记录用记录，无则右下角组合位。 */
function loadPos() {
  try {
    const raw = localStorage.getItem(NIANG_POS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y };
    }
  } catch {
    /* 解析失败回落默认 */
  }
  return {
    x: Math.max(0, window.innerWidth - BASE_W - EDGE_RIGHT),
    y: Math.max(0, window.innerHeight - BASE_W - EDGE_BOTTOM),
  };
}

/** 位置钳制在视口内（w/h = 当前挂件宽高）。 */
function clampPos(x, y, w, h) {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w)),
    y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - h)),
  };
}

function ClaudeNiang({ status = 'idle' }) {
  const [bubble, setBubble] = useState(null);
  const [size, setSize] = useState(BASE_W);
  const [flip, setFlip] = useState(false);
  const [pos, setPos] = useState(loadPos); // 简单拖拽位置（state，同小猫）
  const [visible, setVisible] = useState(() => skinEngine.niangVisible); // 功能页开关（默认关）
  const wrapRef = useRef(null);
  const sizeRef = useRef(BASE_W); // clamp 用的当前宽（size 变化同步）
  const dragRef = useRef(null); // { startX, startY, origX, origY }
  const draggedRef = useRef(false); // 本次按下是否真拖过（区分点击/拖拽）
  const bubbleTimerRef = useRef(null); // 气泡两阶段定时器（颜文字 → 余额）
  const statusRef = useRef('idle'); // 最新 status，供点击流程收尾时恢复状态气泡
  const lastStatusRef = useRef({ st: null, ts: 0 }); // status 节流：防打字中气泡闪烁
  const clickingRef = useRef(false); // 点击流程进行中（颜文字 → 余额），状态气泡让位

  useEffect(() => { sizeRef.current = size; }, [size]);

  // 窗口变化时把 claude娘 clamp 回可视区（同小猫：防缩小窗口后跑出界）
  useEffect(() => {
    const onResize = () => {
      const s = sizeRef.current;
      setPos((p) => clampPos(p.x, p.y, s, s));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 功能页「claude娘」开关实时生效（关掉整个隐藏）
  useEffect(() => {
    const unsub = skinEngine.subscribe(() => setVisible(skinEngine.niangVisible));
    return unsub;
  }, []);

  // 打开/挂载时还原位置、大小、镜像：有记录用记录，无记录回落初始组合位（右下角）
  useEffect(() => {
    if (!visible) return;
    setPos(loadPos());
    const savedSize = Number(readStore(NIANG_SIZE_KEY));
    if (savedSize >= MIN_W && savedSize <= MAX_W) setSize(savedSize);
    if (readStore(NIANG_FLIP_KEY) === 'true') setFlip(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // 点击流程收尾：颜文字 → 余额 两段播完后，让位给当前状态气泡（若存在）
  const finishClick = () => {
    clickingRef.current = false;
    const st = statusRef.current;
    setBubble(st === 'idle' ? null : STATUS_TEXT[st]);
  };

  // 点一下冒气泡：先随机颜文字，稍后换成 DeepSeek 余额，最后回到状态气泡/清空。
  // 点击永远是最高优先级，点击流程进行中再点会重新开始完整两段。
  const popBubble = () => {
    clickingRef.current = true;
    const pick = BUBBLES[Math.floor(Math.random() * BUBBLES.length)];
    setBubble(pick);
    window.clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = window.setTimeout(async () => {
      let text = '余额查询失败';
      try {
        const res = await fetch('/api/balance');
        const data = await res.json();
        if (data.ok && data.total_balance != null) {
          text = `余额 ¥${Number(data.total_balance).toFixed(2)}`;
        }
      } catch {
        // 网络/解析异常 → 保持"余额查询失败"
      }
      setBubble(text);
      bubbleTimerRef.current = window.setTimeout(finishClick, BALANCE_MS);
    }, EMOJI_MS);
  };

  // —— 简单拖拽（同小猫：state 位置 + 钳制 + 位移阈值区分点击） ——
  const handlePointerDown = (e) => {
    if (e.button !== 0) return; // 仅左键拖动
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    draggedRef.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const handlePointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!draggedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return; // 阈值内算点击
    draggedRef.current = true;
    const s = sizeRef.current;
    setPos(clampPos(d.origX + dx, d.origY + dy, s, s));
  };

  const handlePointerUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // 指针可能已丢失，忽略
    }
    if (draggedRef.current) {
      const s = sizeRef.current;
      const final = clampPos(d.origX + (e.clientX - d.startX), d.origY + (e.clientY - d.startY), s, s);
      setPos(final);
      writeStore(NIANG_POS_KEY, JSON.stringify(final)); // 记住位置
    }
    draggedRef.current = false;
  };

  // 组件卸载时清掉气泡定时器，避免卸载后 setState
  useEffect(() => {
    return () => window.clearTimeout(bubbleTimerRef.current);
  }, []);

  // 状态驱动气泡：thinking/responding/typing 常驻显示对应文字，回到 idle 清空。
  // 节流：状态快速切换（打字中）<300ms 不重复 setBubble（防闪烁）；点击流程中让位。
  useEffect(() => {
    statusRef.current = status;
    if (clickingRef.current) return; // 点击流程进行中，让位给点击气泡
    const now = Date.now();
    if (status === lastStatusRef.current.st && now - lastStatusRef.current.ts < 300) return;
    lastStatusRef.current = { st: status, ts: now };
    window.clearTimeout(bubbleTimerRef.current);
    setBubble(status === 'idle' ? null : STATUS_TEXT[status]);
  }, [status]);

  // —— 滚轮缩放（原生 addEventListener + passive:false，避免滚轮时页面跟着滚） ——
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      setSize((s) => {
        const next = Math.min(MAX_W, Math.max(MIN_W, s + (e.deltaY < 0 ? 10 : -10)));
        writeStore(NIANG_SIZE_KEY, String(next)); // 记住缩放
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [visible]);

  const handleContextMenu = (e) => {
    e.preventDefault();
    setFlip((f) => {
      writeStore(NIANG_FLIP_KEY, f ? 'false' : 'true'); // 记住镜像
      return !f;
    });
  };

  const handleClick = () => {
    if (draggedRef.current) {
      draggedRef.current = false; // 拖动后的 click 忽略
      return;
    }
    popBubble();
  };

  if (!visible) return null;

  // 气泡字号随文字长度自适应：长文字（状态提示）缩小字号，保证不溢出素材思考气泡
  const bubbleLen = bubble ? bubble.length : 0;
  const bubbleFont = Math.max(size * 0.042, Math.min(size * 0.075, (size * 0.68) / Math.max(bubbleLen, 6) / 0.6));

  return (
    <div
      className="claude-niang"
      ref={wrapRef}
      role="button"
      tabIndex={0}
      title="点我看余额 · 拖拽移动 · 滚轮缩放 · 右键镜像"
      style={{ left: pos.x, top: pos.y }}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          popBubble();
        }
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => (dragRef.current = null)}
      onContextMenu={handleContextMenu}
    >
      <div className="claude-niang-body">
        {bubble && (
          <div
            className="claude-niang-bubble"
            style={{
              opacity: 0.95, // 固定清晰（不再跟用户气泡透明度，避免被调低连累文字变淡）
              // 素材像素分析：思考气泡中心 = 图片 (40.5%, 26.9%)，镜像后翻到右侧
              left: flip ? '59.5%' : '40.5%',
              width: 'max-content', // 宽度随文字自适应，限制在椭圆内
              maxWidth: size * 0.68,
              height: size * 0.45,
              fontSize: bubbleFont, // 字号随文字长度自适应
            }}
          >
            <span className="claude-niang-bubble-text">{bubble}</span>
          </div>
        )}
        <img
          className="claude-niang-img"
          src={claudeNiang}
          alt="claude娘"
          draggable={false}
          style={{ width: size, transform: flip ? 'scaleX(-1)' : undefined }}
        />
      </div>
    </div>
  );
}

export default memo(ClaudeNiang);
