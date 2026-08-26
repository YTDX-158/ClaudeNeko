import { useEffect, useRef } from 'react';

/**
 * RefImagePicker.jsx — 生视频 @ 补全：只引用"已经挂在输入框附件里"的图片。
 * 输入 @ 弹小浮层显示附件图，点一张 → onSelect(media, index)（父级插入 @imageN，N=index+1）。
 * 不加载媒体库（v1.8.3 简化：要新图先挂图再 @）。没挂图时显示引导提示。
 */
export default function RefImagePicker({ open, onClose, onSelect, attachedImages = [] }) {
  const panelRef = useRef(null);

  // Esc / 点外关闭（监听 cleanup）
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const onDocMouse = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocMouse);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocMouse);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="ref-picker" ref={panelRef}>
      <div className="ref-picker-title">引用已挂的图（@imageN 对应第 N 张）</div>
      {attachedImages.length === 0 ? (
        <div className="ref-picker-empty">先挂图（拖入或 📎 媒体库选），再 @ 引用</div>
      ) : (
        <div className="ref-picker-grid">
          {attachedImages.map((m, i) => (
            <img
              key={m.id}
              className="ref-picker-img"
              src={`/api/media/${m.id}`}
              alt={m.name}
              loading="lazy"
              title={`@image${i + 1} · ${m.name}`}
              onClick={() => {
                onSelect(m, i);
                onClose();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
