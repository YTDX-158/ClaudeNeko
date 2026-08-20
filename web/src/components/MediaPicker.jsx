import { useEffect, useState } from 'react';

/**
 * MediaPicker.jsx — 媒体库选择器（从媒体库多选文件附加到消息）
 * 返回选中的附件快照 [{ id, name, kind }]。
 */
export default function MediaPicker({ open, onClose, onSelect }) {
  const [media, setMedia] = useState([]);
  const [selected, setSelected] = useState([]);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    fetch('/api/media')
      .then((r) => r.json())
      .then((d) => setMedia(d.media || []))
      .catch(() => setMedia([]));
  }, [open]);

  if (!open) return null;

  const toggle = (m) => {
    setSelected((prev) =>
      prev.some((x) => x.id === m.id)
        ? prev.filter((x) => x.id !== m.id)
        : [...prev, { id: m.id, name: m.originalName, kind: m.kind }],
    );
  };

  return (
    <div className="skin-modal" onClick={onClose}>
      <div className="skin-modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="skin-modal-header">
          <span className="skin-modal-title">从媒体库选择（已选 {selected.length}）</span>
          <button className="skin-close" onClick={onClose} title="关闭">✕</button>
        </div>

        <div className="media-grid">
          {media.length === 0 && <div className="skin-hint">媒体库为空，先到媒体库上传一些文件</div>}
          {media.map((m) => (
            <div
              key={m.id}
              className={`media-card${selected.some((x) => x.id === m.id) ? ' selected' : ''}`}
              onClick={() => toggle(m)}
              title="点击选择/取消"
            >
              <div className="media-preview">
                {m.kind === 'image' && <img src={`/api/media/${m.id}`} alt={m.originalName} loading="lazy" />}
                {m.kind === 'video' && <div className="media-doc-icon">🎬</div>}
                {m.kind === 'document' && <div className="media-doc-icon">📄</div>}
                {m.kind === 'audio' && <div className="media-doc-icon">🎵</div>}
              </div>
              <div className="media-card-info">
                <span className="media-name" title={m.originalName}>{m.originalName}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="media-picker-actions">
          <button
            className="skin-btn"
            disabled={!selected.length}
            onClick={() => {
              onSelect(selected);
              onClose();
            }}
          >
            附加（{selected.length}）
          </button>
        </div>
      </div>
    </div>
  );
}
