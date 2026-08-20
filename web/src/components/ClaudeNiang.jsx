/**
 * ClaudeNiang.jsx — claude娘 挂件（移植自朋友 1.3，与小猫 CatMascot 平级共存）
 *  - claude娘 拟人形象（珊瑚橙学者，透明 PNG），独立 .claude-niang 容器（不占小猫 .cat-mascot）
 *  - 点击 → 冒气泡（颜文字 → DeepSeek 余额 两段式）；**点击优先级最高**：任意时刻点击都先完整播完，
 *    结束后再恢复当前状态气泡（思考中/回答中/打字中）
 *  - 状态气泡：thinking「正在努力思考ing...」/ responding「想出来了！」/ typing「偷窥ing...」
 *  - 挂件交互（只作用 claude娘）：拖拽移动（边缘自动吸附）/ 滚轮缩放 / 右键水平镜像 / 拖完 Q 弹
 */
import { useEffect, useRef, useState } from 'react';
import { skinEngine } from '../skin/skinEngine.js';
import claudeNiang from '../assets/claude-niang-widget-transparent.png';

const BUBBLES = [
  '(=^･ω･^=)', 'ฅ^•ﻌ•^ฅ', '(=^‥^=)', '(=｀ω´=)', '(=^-ω-^=)',
  '(=ＴェＴ=)', '(=ↀωↀ=)', '(=^◡^=)', '(=^･ｪ･^=)', '(=•ω•=)',
  '(=^･ᴥ･^=)', '(^・ω・^)', 'ฅ(^・ω・^ฅ)', 'ฅ(=•̫•=)ฅ', '( ฅ•ᴥ•ฅ )',
  '(=＾● ⋏ ●＾=)', '(^≖ω≖^)', 'ᓚᘏᗢ', '(=^♡ω♡^=)', '✦ 思考中…',
];

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
const SNAP = 48; // 距边缘小于此值触发吸附
const EDGE = 20; // 吸附后的贴边间距

export default function ClaudeNiang({ status = 'idle' }) {
  const [bubble, setBubble] = useState(null);
  const [size, setSize] = useState(BASE_W);
  const [flip, setFlip] = useState(false);
  const wrapRef = useRef(null); // 外层容器 .claude-niang
  const dragRef = useRef(null); // 拖动过程状态
  const draggedRef = useRef(false); // 本次按下是否真拖过（区分点击/拖拽）
  const bubbleTimerRef = useRef(null); // 气泡两阶段定时器（颜文字 → 余额）
  const statusRef = useRef('idle'); // 最新 status，供点击流程收尾时恢复状态气泡
  const clickingRef = useRef(false); // 点击流程进行中（颜文字 → 余额），状态气泡让位
  const [visible, setVisible] = useState(() => skinEngine.niangVisible); // 功能页开关（默认关）

  // 功能页「claude娘」开关实时生效（关掉整个隐藏）
  useEffect(() => {
    const unsub = skinEngine.subscribe(() => setVisible(skinEngine.niangVisible));
    return unsub;
  }, []);

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

  // —— 拖拽移动（边缘自动吸附） ——
  const handlePointerDown = (e) => {
    if (e.button !== 0) return; // 仅左键拖动
    const el = wrapRef.current;
    const parent = el.offsetParent;
    const pRect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
    const rect = el.getBoundingClientRect();
    // 首次拖动：把 right/bottom 定位固化为 left/top（相对父容器），之后才能自由移动
    if (!el.dataset.dragged) {
      el.style.left = `${rect.left - pRect.left}px`;
      el.style.top = `${rect.top - pRect.top}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.dataset.dragged = '1';
    }
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseLeft: parseFloat(el.style.left),
      baseTop: parseFloat(el.style.top),
    };
    draggedRef.current = false;
    el.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const handlePointerMove = (e) => {
    const el = wrapRef.current;
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!draggedRef.current && Math.abs(dx) + Math.abs(dy) < 4) return;
    draggedRef.current = true;
    el.style.left = `${d.baseLeft + dx}px`;
    el.style.top = `${d.baseTop + dy}px`;
  };

  const handlePointerUp = () => {
    const el = wrapRef.current;
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !draggedRef.current) return; // 纯点击交给 onClick
    // 拖完：边缘吸附 + Q 弹（viewport 坐标判断，算完转回父容器相对坐标）
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const parent = el.offsetParent;
    const pRect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
    let left = rect.left;
    let top = rect.top;
    if (left < SNAP) left = EDGE;
    else if (vw - (left + rect.width) < SNAP) left = vw - rect.width - EDGE;
    if (top < SNAP) top = EDGE;
    else if (vh - (top + rect.height) < SNAP) top = vh - rect.height - EDGE;
    el.style.left = `${left - pRect.left}px`;
    el.style.top = `${top - pRect.top}px`;
    const body = el.querySelector('.claude-niang-body');
    if (body) {
      body.classList.remove('claude-q-pop');
      void body.offsetWidth; // 强制重排以重触发动画
      body.classList.add('claude-q-pop');
    }
  };

  // 组件卸载时清掉气泡定时器，避免卸载后 setState
  useEffect(() => {
    return () => window.clearTimeout(bubbleTimerRef.current);
  }, []);

  // 状态驱动气泡：thinking/responding/typing 常驻显示对应文字，回到 idle 清空。
  // 点击流程进行中不覆盖（点击优先级最高），结束后由 finishClick 恢复当前状态气泡。
  useEffect(() => {
    statusRef.current = status;
    if (clickingRef.current) return; // 点击流程进行中，让位给点击气泡
    window.clearTimeout(bubbleTimerRef.current);
    setBubble(status === 'idle' ? null : STATUS_TEXT[status]);
  }, [status]);

  // —— 滚轮缩放（原生 addEventListener + passive:false，避免滚轮时页面跟着滚） ——
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      setSize((s) => Math.min(MAX_W, Math.max(MIN_W, s + (e.deltaY < 0 ? 10 : -10))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handleContextMenu = (e) => {
    e.preventDefault();
    setFlip((f) => !f);
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
