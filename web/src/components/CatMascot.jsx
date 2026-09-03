/**
 * CatMascot.jsx — 粒子小猫（品牌吉祥物，9-02 起换成图标同款粒子小猫高清 PNG）
 *  - 主体 = assets/cat-mascot-particle.png（GPT 粒子小猫透明图裁边瘦身版，62×75px 显示）
 *  - 背景淡粒子：光点漂浮，纯 CSS 动画（背景装饰，不随猫移动）
 *  - **可拖拽**（位置 localStorage 记住，限制在窗口内）
 *  - 点击猫（拖动位移 <6px）→ 猫头正上方冒气泡（2 秒），随机猫咪颜文字，气泡消失前不可再点
 *  - 气泡固定清晰（0.95 不透明），字符颜色同步正文
 *  - ⚠ img 必须 draggable={false} + -webkit-user-drag:none，否则浏览器原生拖图会和指针拖拽打架
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { skinEngine } from '../skin/skinEngine.js';
import { KAOMOJI } from '../utils/kaomoji.js';
import catMascot from '../assets/cat-mascot-particle.png';

const BUBBLE_MS = 2000;
const DRAG_THRESHOLD = 6; // 位移超过 6px 算拖拽，否则算点击
const CAT_POS_KEY = 'dsw-dream-skin:cat-pos';
const CAT_W = 62; // 粒子小猫 img 显示宽（CSS .cat-mascot-img 高 75、按比例宽 ≈62）
const CAT_H = 75;

// 初始组合位：猫在 claude娘 正上方（claude娘 初始右下角，见 ClaudeNiang.jsx / styles.css）
const NIANG_W = 150; // claude娘 初始宽（正方形，高=宽）
const NIANG_RIGHT = 26; // claude娘 距视口右边距
const NIANG_BOTTOM = 96; // claude娘 距视口底边距
const MASCOT_GAP = 12; // 猫与 claude娘 的垂直间距（"稍微高一点别重叠"）

function loadPos() {
  try {
    const raw = localStorage.getItem(CAT_POS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y };
    }
  } catch {
    // 忽略，用默认
  }
  // 默认：claude娘 正上方、水平居中（组合位，右下角）
  const niangX = Math.max(0, window.innerWidth - NIANG_W - NIANG_RIGHT);
  const niangY = Math.max(0, window.innerHeight - NIANG_W - NIANG_BOTTOM);
  return {
    x: Math.max(0, niangX + (NIANG_W - CAT_W) / 2),
    y: Math.max(0, niangY - CAT_H - MASCOT_GAP),
  };
}

function clampPos(x, y) {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - CAT_W)),
    y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - CAT_H)),
  };
}

function CatMascot() {
  const [bubble, setBubble] = useState(null);
  const [locked, setLocked] = useState(false);
  const [pos, setPos] = useState(loadPos);
  const [visible, setVisible] = useState(() => skinEngine.catVisible);
  const dragRef = useRef(null); // { startX, startY, origX, origY, moved }
  const bubbleTimerRef = useRef(null); // 气泡消失定时器（卸载时清理）

  // 背景淡粒子：纯静态装饰（9-03 性能对齐 claude娘）——useMemo 固定一次，
  // 拖拽高频 setPos / 父组件重渲染都不再连带重建 12 个粒子 span
  const particles = useMemo(
    () =>
      Array.from({ length: 12 }).map((_, i) => (
        <span
          key={i}
          className="cat-particle"
          style={{
            left: `${(i * 8.3) % 95 + 2}%`,
            top: `${(i * 13.7) % 88 + 5}%`,
            animationDelay: `${(i * 0.7) % 6}s`,
            animationDuration: `${6 + (i % 4)}s`,
          }}
        />
      )),
    []
  );

  // 设置里「猫猫」开关实时生效（关掉后连粒子一起消失）
  useEffect(() => {
    const unsub = skinEngine.subscribe(() => setVisible(skinEngine.catVisible));
    return unsub;
  }, []);

  // 重新打开（visible false→true）时重新读位置：关闭时记录已被 skinEngine 清掉 →
  // loadPos 回落初始组合位；若是首次挂载有记录则仍是记录位（刷新保留）
  useEffect(() => {
    if (visible) setPos(loadPos());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // 窗口变化时把猫 clamp 回可视区（避免缩小窗口后猫跑出界）
  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p.x, p.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 卸载时清掉气泡定时器，避免卸载后 setState
  useEffect(() => {
    return () => window.clearTimeout(bubbleTimerRef.current);
  }, []);

  const handlePointerDown = (e) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) d.moved = true;
    if (d.moved) setPos(clampPos(d.origX + dx, d.origY + dy));
  };

  const handlePointerUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 指针可能已丢失，忽略
    }
    if (d.moved) {
      // 拖拽完成：记住位置
      const final = clampPos(d.origX + (e.clientX - d.startX), d.origY + (e.clientY - d.startY));
      setPos(final);
      try {
        localStorage.setItem(CAT_POS_KEY, JSON.stringify(final));
      } catch {
        // localStorage 满/禁用，忽略
      }
    } else {
      // 位移很小，视为点击：冒气泡
      handleBubble();
    }
  };

  const handleBubble = () => {
    if (locked) return;
    const pick = KAOMOJI[Math.floor(Math.random() * KAOMOJI.length)];
    setBubble(pick);
    setLocked(true);
    window.clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = window.setTimeout(() => {
      setBubble(null);
      setLocked(false);
    }, BUBBLE_MS);
  };

  if (!visible) return null;

  return (
    <>
      {/* 背景淡粒子（纯背景装饰，不随猫移动） */}
      <div className="cat-particles" aria-hidden="true">
        {particles}
      </div>

      {/* 猫 + 气泡（可拖动；点击冒气泡） */}
      <div
        className="cat-mascot"
        style={{ left: pos.x, top: pos.y }}
        role="button"
        title="点我喵~（可拖动）"
        aria-hidden="true"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {bubble && (
          <div className="cat-bubble" style={{ opacity: 0.95 }}>
            <span className="cat-bubble-text">{bubble}</span>
            <span className="cat-bubble-tail" />
          </div>
        )}
        <img
          className="cat-mascot-img"
          src={catMascot}
          alt="粒子小猫"
          draggable={false}
        />
      </div>
    </>
  );
}

// 9-03 性能对齐 claude娘：memo 化——父级（聊天区）重渲染不带动小猫整棵重渲染
export default memo(CatMascot);
