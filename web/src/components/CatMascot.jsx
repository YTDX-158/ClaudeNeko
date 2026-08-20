/**
 * CatMascot.jsx — 粒子猫猫（Aqua 鲸鱼的猫版）
 *  - 一只坐姿猫（SVG 剪影，跟随主题色），**可拖拽**（位置 localStorage 记住，限制在窗口内）
 *  - 背景淡粒子：光点漂浮，纯 CSS 动画（背景装饰，不随猫移动）
 *  - 点击猫（拖动位移 <6px）→ 猫头正上方冒气泡（2 秒），随机猫咪颜文字，气泡消失前不可再点
 *  - 气泡固定清晰（0.95 不透明），字符颜色同步正文
 */
import { useEffect, useRef, useState } from 'react';

const CAT_KAOMOJI = [
  '(=^･ω･^=)', 'ฅ^•ﻌ•^ฅ', '(=^‥^=)', '(=｀ω´=)', '(=^-ω-^=)',
  '(=ＴェＴ=)', '(=ↀωↀ=)', '(=^◡^=)', '(=^･ｪ･^=)', '(=•ω•=)',
  '(=^･ᴥ･^=)', '(^・ω・^)', 'ฅ(^・ω・^ฅ)', 'ฅ(=•̫•=)ฅ', '( ฅ•ᴥ•ฅ )',
  '(=＾● ⋏ ●＾=)', '(^≖ω≖^)', '/ᐠ｡ꞈ｡ᐟ\\', 'ᓚᘏᗢ', '(=^♡ω♡^=)',
];

const BUBBLE_MS = 2000;
const DRAG_THRESHOLD = 6; // 位移超过 6px 算拖拽，否则算点击
const CAT_POS_KEY = 'dsw-dream-skin:cat-pos';
const CAT_W = 116; // 可点区域约 116px 宽（含内边距）
const CAT_H = 100;

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
  // 默认：右下角（原输入框上方附近）
  return {
    x: Math.max(0, window.innerWidth - CAT_W - 26),
    y: Math.max(0, window.innerHeight - CAT_H - 96),
  };
}

function clampPos(x, y) {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - CAT_W)),
    y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - CAT_H)),
  };
}

export default function CatMascot() {
  const [bubble, setBubble] = useState(null);
  const [locked, setLocked] = useState(false);
  const [pos, setPos] = useState(loadPos);
  const dragRef = useRef(null); // { startX, startY, origX, origY, moved }

  // 窗口变化时把猫 clamp 回可视区（避免缩小窗口后猫跑出界）
  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p.x, p.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
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
    const pick = CAT_KAOMOJI[Math.floor(Math.random() * CAT_KAOMOJI.length)];
    setBubble(pick);
    setLocked(true);
    setTimeout(() => {
      setBubble(null);
      setLocked(false);
    }, BUBBLE_MS);
  };

  return (
    <>
      {/* 背景淡粒子（纯背景装饰，不随猫移动） */}
      <div className="cat-particles" aria-hidden="true">
        {Array.from({ length: 12 }).map((_, i) => (
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
        ))}
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
        <svg viewBox="0 0 120 100" width="88" height="74" fill="currentColor">
          {/* 尾巴绕到身前 */}
          <path
            d="M84 60 Q102 52 99 40 Q98 33 90 34"
            stroke="currentColor"
            strokeWidth="5"
            fill="none"
            strokeLinecap="round"
          />
          {/* 身体 */}
          <ellipse cx="60" cy="72" rx="30" ry="24" />
          {/* 前腿 */}
          <ellipse cx="46" cy="94" rx="8" ry="7" />
          <ellipse cx="74" cy="94" rx="8" ry="7" />
          {/* 头 */}
          <circle cx="60" cy="38" r="22" />
          {/* 耳朵 */}
          <path d="M42 24 L45 7 L58 20 Z" />
          <path d="M78 24 L75 7 L62 20 Z" />
          {/* 眼睛（背景色镂空） */}
          <circle cx="53" cy="38" r="2.6" fill="var(--bg)" />
          <circle cx="67" cy="38" r="2.6" fill="var(--bg)" />
          {/* 胡须 */}
          <path
            d="M38 42 L23 40 M38 46 L24 48 M82 42 L97 40 M82 46 L96 48"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          {/* 嘴 */}
          <path d="M58 46 Q60 49 62 46" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </svg>
      </div>
    </>
  );
}
