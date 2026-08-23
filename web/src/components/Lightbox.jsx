import { useEffect, useState } from 'react';

/**
 * Lightbox — 全屏查看图片原图 / 视频大播放。
 * 点遮罩 / ✕ / ESC 关闭；打开时锁背景滚动；大图加载显示占位；带下载按钮。
 */
export default function Lightbox({ media, onClose }) {
  const [loading, setLoading] = useState(true);

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

  if (!media) return null;
  const url = `/api/media/${media.id}`;

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-box" onClick={(e) => e.stopPropagation()}>
        {media.kind === 'image' ? (
          <>
            {loading && <div className="lightbox-loading">⏳ 加载原图…</div>}
            <img
              className="lightbox-media"
              src={url}
              alt={media.name || media.id}
              onLoad={() => setLoading(false)}
              style={loading ? { display: 'none' } : undefined}
            />
          </>
        ) : (
          <video className="lightbox-media" src={url} controls autoPlay />
        )}
        <div className="lightbox-toolbar">
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
