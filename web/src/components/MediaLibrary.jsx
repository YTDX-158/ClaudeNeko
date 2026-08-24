import { useEffect, useRef, useState } from 'react';
import { uploadToMedia } from '../utils/upload.js';
import { api } from '../api.js';
import Lightbox from './Lightbox.jsx';

const KINDS = [
  { id: 'all', label: '全部' },
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
  { id: 'document', label: '文档' },
  { id: 'audio', label: '音频' },
];

/**
 * MediaLibrary.jsx — 媒体库（全屏面板）
 * 上传 / 网格展示（图片/视频/文档/音频分类）/ 预览 / 下载 / 删除。
 * 走 /api/media（后端 uuid 存储 + magic bytes 校验 + Range 支持）。
 */
export default function MediaLibrary({ open, onClose }) {
  const [media, setMedia] = useState([]);
  const [kind, setKind] = useState('all');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [view, setView] = useState(null); // Lightbox 大图查看
  const [manageMode, setManageMode] = useState(false); // 多选模式
  const [selected, setSelected] = useState(new Set()); // 选中的媒体 id
  const fileRef = useRef(null);

  const refresh = () => {
    setLoading(true);
    fetch('/api/media')
      .then((r) => r.json())
      .then((d) => setMedia(d.media || []))
      .catch(() => setMedia([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  if (!open) return null;

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setUploading(true);
    setUploadError(null);
    const results = await Promise.all(files.map((f) => uploadToMedia(f).catch(() => null)));
    if (results.some((r) => !r)) setUploadError('部分文件上传失败（类型不支持或超过 50MB）');
    refresh();
    setUploading(false);
  };

  const handleDelete = async (id) => {
    if (!window.confirm('确定删除这个文件？')) return;
    try {
      await fetch(`/api/media/${id}`, { method: 'DELETE' });
    } catch {}
    refresh();
  };

  // 媒体批量管理
  const toggleSelected = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => (prev.size === filtered.length ? new Set() : new Set(filtered.map((m) => m.id))));
  };
  const handleBatchDelete = async () => {
    if (!selected.size) return;
    if (!window.confirm(`确定删除选中的 ${selected.size} 个文件？此操作不可撤销。`)) return;
    await Promise.all([...selected].map((id) => fetch(`/api/media/${id}`, { method: 'DELETE' }).catch(() => {})));
    setSelected(new Set());
    setManageMode(false);
    refresh();
  };
  const handleBatchDownload = async () => {
    if (!selected.size) return;
    try {
      await api.exportMediaZip([...selected]);
    } catch {
      // 下载失败静默
    }
  };

  const filtered = kind === 'all' ? media : media.filter((m) => m.kind === kind);

  return (
    <div className="skin-modal" onClick={onClose}>
      <div className="skin-modal-box media-box" onClick={(e) => e.stopPropagation()}>
        <div className="skin-modal-header">
          <span className="skin-modal-title">媒体库（{media.length}）</span>
          <div className="media-actions">
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={handleUpload}
              accept="image/*,video/*,application/pdf,audio/mpeg"
            />
            <button className="skin-btn" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? '上传中…' : '↑ 上传'}
            </button>
            <button
              className={`skin-btn${manageMode ? ' active' : ''}`}
              onClick={() => { setManageMode((v) => !v); setSelected(new Set()); }}
              title={manageMode ? '退出批量管理' : '批量管理（多选删除/下载）'}
            >
              {manageMode ? '✓ 完成' : '☑ 管理'}
            </button>
            <button className="skin-close" onClick={onClose} title="关闭">✕</button>
          </div>
        </div>

        {uploadError && <div className="composer-upload-error">{uploadError}</div>}

        <div className="media-tabs">
          {KINDS.map((k) => (
            <button
              key={k.id}
              className={`media-tab${kind === k.id ? ' active' : ''}`}
              onClick={() => setKind(k.id)}
            >
              {k.label}
            </button>
          ))}
        </div>

        <div className="media-grid">
          {loading && <div className="skin-hint">加载中…</div>}
          {!loading && filtered.length === 0 && <div className="skin-hint">暂无{kind === 'all' ? '' : `「${kind}」`}文件</div>}

          {!loading &&
            filtered.map((m) => (
              <div
                key={m.id}
                className={`media-card${selected.has(m.id) ? ' selected' : ''}`}
                onClick={() => manageMode && toggleSelected(m.id)}
              >
                {manageMode && (
                  <span
                    className={`media-check${selected.has(m.id) ? ' checked' : ''}`}
                    onClick={(e) => { e.stopPropagation(); toggleSelected(m.id); }}
                  >
                    {selected.has(m.id) ? '✓' : ''}
                  </span>
                )}
                <div
                  className="media-preview"
                  onClick={() => !manageMode && (m.kind === 'image' || m.kind === 'video') && setView(m)}
                  style={{ cursor: m.kind === 'image' || m.kind === 'video' ? 'zoom-in' : 'default' }}
                >
                  {m.kind === 'image' && <img src={`/api/media/${m.id}`} alt={m.originalName} loading="lazy" />}
                  {m.kind === 'video' && <video src={`/api/media/${m.id}`} controls preload="metadata" />}
                  {m.kind === 'document' && <div className="media-doc-icon">📄</div>}
                  {m.kind === 'audio' && <div className="media-doc-icon">🎵</div>}
                </div>
                <div className="media-card-info">
                  <span className="media-name" title={m.originalName}>{m.originalName}</span>
                  <span className="media-meta">{m.kind} · {(m.size / 1024).toFixed(0)}KB</span>
                </div>
                <div className="media-card-actions">
                  {m.kind === 'document' && (
                    <a className="media-btn" href={`/api/media/${m.id}`} target="_blank" rel="noopener noreferrer">预览</a>
                  )}
                  <a className="media-btn" href={`/api/media/${m.id}/download`} download>下载</a>
                  {!manageMode && (
                    <button className="media-btn danger" onClick={() => handleDelete(m.id)}>删除</button>
                  )}
                </div>
              </div>
            ))}
        </div>

        {/* 媒体批量操作条（管理模式下显示） */}
        {manageMode && (
          <div className="media-batch-bar">
            <span className="media-batch-info">已选 {selected.size} 项</span>
            <button className="batch-btn" onClick={toggleAll}>
              {selected.size === filtered.length ? '取消全选' : '全选'}
            </button>
            <button className="batch-btn" onClick={handleBatchDownload} disabled={selected.size === 0}>
              下载 zip
            </button>
            <button className="batch-btn danger" onClick={handleBatchDelete} disabled={selected.size === 0}>
              删除
            </button>
          </div>
        )}
        {view && <Lightbox media={view} onClose={() => setView(null)} />}
      </div>
    </div>
  );
}
