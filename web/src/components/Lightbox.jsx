import { useEffect, useRef, useState } from 'react';

/**
 * Lightbox — 全屏查看图片原图 / 视频大播放。
 * 点遮罩 / ✕ / ESC 关闭；打开时锁背景滚动；大图加载显示占位；带下载按钮。
 *
 * 9-20 新增缩放（用户反馈：手机上图片/视频不能放大）：
 *   · 双指捏合 → 缩放（pinch）
 *   · 双击       → 1x ⇄ 2.5x 切换
 *   · 放大后单指拖动 → 平移
 *   · 桌面滚轮   → 缩放
 *   ⚠️ 手写手势（不引库）—— 项目零依赖倾向，连 zip 都是手写 STORE 模式。
 *   ⚠️ 视频不接管手势：它有原生播放器控件，抢手势会打架 → 只对图片启用。
 */

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const DOUBLE_TAP_SCALE = 2.5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

export default function Lightbox({ media, onClose }) {
  const [loading, setLoading] = useState(true);
  // 变换：s=缩放，x/y=平移（px）。图片与视频共用一套状态，视频恒为初始值。
  const [tf, setTf] = useState({ s: 1, x: 0, y: 0 });
  const g = useRef({ mode: null, dist: 0, scale: 1, sx: 0, sy: 0, lastTap: 0 });

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 换文件时复位缩放（否则上一张的放大状态会带过来）
  useEffect(() => {
    setTf({ s: 1, x: 0, y: 0 });
    setLoading(true);
  }, [media?.id]);

  if (!media) return null;
  const url = `/api/media/${media.id}`;
  const isImage = media.kind === 'image';
  const zoomed = tf.s > 1;

  const reset = () => setTf({ s: 1, x: 0, y: 0 });

  const onTouchStart = (e) => {
    if (!isImage) return;
    if (e.touches.length === 2) {
      g.current.mode = 'pinch';
      g.current.dist = touchDist(e.touches);
      g.current.scale = tf.s;
      return;
    }
    if (e.touches.length === 1) {
      const now = Date.now();
      if (now - g.current.lastTap < 300) {
        // 双击：放大 / 复位
        zoomed ? reset() : setTf({ s: DOUBLE_TAP_SCALE, x: 0, y: 0 });
        g.current.lastTap = 0;
        return;
      }
      g.current.lastTap = now;
      g.current.mode = 'pan';
      g.current.sx = e.touches[0].clientX - tf.x;
      g.current.sy = e.touches[0].clientY - tf.y;
    }
  };

  const onTouchMove = (e) => {
    if (!isImage) return;
    const m = g.current.mode;
    if (m === 'pinch' && e.touches.length === 2) {
      e.preventDefault();
      const ratio = touchDist(e.touches) / (g.current.dist || 1);
      setTf((p) => ({ ...p, s: clamp(g.current.scale * ratio, MIN_SCALE, MAX_SCALE) }));
    } else if (m === 'pan' && e.touches.length === 1 && zoomed) {
      e.preventDefault();
      setTf((p) => ({ ...p, x: e.touches[0].clientX - g.current.sx, y: e.touches[0].clientY - g.current.sy }));
    }
  };

  const onTouchEnd = (e) => {
    if (!isImage) return;
    if (e.touches.length === 0) g.current.mode = null;
    // 缩回 1x 时把平移归零，免得图片停在画面外
    setTf((p) => (p.s <= MIN_SCALE + 0.01 ? { s: 1, x: 0, y: 0 } : p));
  };

  const onWheel = (e) => {
    if (!isImage) return;
    const next = clamp(tf.s * (e.deltaY < 0 ? 1.15 : 0.87), MIN_SCALE, MAX_SCALE);
    setTf((p) => (next <= MIN_SCALE + 0.01 ? { s: 1, x: 0, y: 0 } : { ...p, s: next }));
  };

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-box" onClick={(e) => e.stopPropagation()}>
        {isImage ? (
          <>
            {loading && <div className="lightbox-loading">⏳ 加载原图…</div>}
            <img
              className="lightbox-media"
              src={url}
              alt={media.name || media.id}
              onLoad={() => setLoading(false)}
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
              onWheel={onWheel}
              onDoubleClick={zoomed ? reset : () => setTf({ s: DOUBLE_TAP_SCALE, x: 0, y: 0 })}
              style={{
                ...(loading ? { display: 'none' } : null),
                transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.s})`,
                cursor: zoomed ? 'grab' : 'zoom-in',
                // 放大后允许拖出边界（不做边界钳制，避免复杂化；缩回 1x 会自动归位）
                touchAction: zoomed ? 'none' : 'pan-y',
                transition: g.current.mode ? 'none' : 'transform .16s ease-out',
              }}
            />
          </>
        ) : (
          <video className="lightbox-media" src={url} controls autoPlay />
        )}
        <div className="lightbox-toolbar">
          {isImage && zoomed && (
            <button className="lightbox-btn" onClick={reset} title="复位缩放">
              ⤢ 复位
            </button>
          )}
          <a className="lightbox-btn" href={`${url}/download`} download title="下载到本地">
            ⬇ 下载
          </a>
          <button className="lightbox-btn" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
