/**
 * CatMascot.jsx — 粒子猫猫（Aqua 鲸鱼的猫版）
 *  - 一只坐姿猫（SVG 剪影，跟随主题色），停在输入框上方，轻微呼吸
 *  - 背景淡粒子：光点漂浮，纯 CSS 动画
 *  - 点击猫 → 猫头左上方冒气泡（2 秒），随机猫咪颜文字，气泡消失前不可再点
 *  - 气泡透明度同步"用户气泡"，字符颜色同步正文
 */
import { useState } from 'react';
import { skinEngine } from '../skin/skinEngine.js';

const CAT_KAOMOJI = [
  '(=^･ω･^=)', 'ฅ^•ﻌ•^ฅ', '(=^‥^=)', '(=｀ω´=)', '(=^-ω-^=)',
  '(=ＴェＴ=)', '(=ↀωↀ=)', '(=^◡^=)', '(=^･ｪ･^=)', '(=•ω•=)',
  '(=^･ᴥ･^=)', '(^・ω・^)', 'ฅ(^・ω・^ฅ)', 'ฅ(=•̫•=)ฅ', '( ฅ•ᴥ•ฅ )',
  '(=＾● ⋏ ●＾=)', '(^≖ω≖^)', '/ᐠ｡ꞈ｡ᐟ\\', 'ᓚᘏᗢ', '(=^♡ω♡^=)',
];

const BUBBLE_MS = 2000;

export default function CatMascot() {
  const [bubble, setBubble] = useState(null);
  const [locked, setLocked] = useState(false);

  const handleClick = () => {
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
      {/* 背景淡粒子 */}
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

      {/* 猫 + 气泡（点击交互） */}
      <div className="cat-mascot" role="button" title="点我喵~" onClick={handleClick} aria-hidden="true">
        {bubble && (
          <div className="cat-bubble" style={{ opacity: skinEngine.wallpaper.userOpacity }}>
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
