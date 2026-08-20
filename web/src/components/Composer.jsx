import { useEffect, useRef, useState } from 'react';
import MediaPicker from './MediaPicker.jsx';

/** 上传文件到媒体库，返回附件快照 { id, name, kind }；失败 reject（不会伪装成功）。 */
function uploadToMedia(file) {
  return fetch(`/api/media?name=${encodeURIComponent(file.name || 'pasted.png')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('上传失败'))))
    .then((m) => ({ id: m.id, name: m.originalName, kind: m.kind }));
}

/**
 * 输入区：Enter 发送 / Shift+Enter 换行；生成中可预打字。
 * 附件（图片/视频/文档）：拖拽 / 粘贴图片 / 📎媒体库选择 → 统一上传管线 → 附件条。
 * 引用：quote 非空时输入框上方显示引用栏；发送时父级拼成 markdown 引用块。
 */
export default function Composer({
  value,
  onChange,
  onSend,
  streaming,
  onStop,
  disabled,
  taRef,
  quote,
  onCancelQuote,
  attachments,
  onAttachmentsChange,
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);
  const dragCounter = useRef(0);

  const submit = () => {
    const t = value.trim();
    if ((!t && !attachments.length) || streaming || disabled || uploading) return;
    onChange('');
    if (taRef.current) taRef.current.style.height = 'auto';
    onSend(t, attachments);
    onAttachmentsChange([]);
  };

  const addFiles = async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setUploading(true);
    setUploadError(null);
    try {
      const results = await Promise.all(list.map((f) => uploadToMedia(f).catch(() => null)));
      const ok = results.filter(Boolean);
      if (ok.length) onAttachmentsChange([...attachments, ...ok]);
      if (ok.length < list.length) setUploadError('部分文件上传失败（类型不支持或超过 50MB）');
    } catch {
      setUploadError('上传失败，请重试');
    } finally {
      setUploading(false);
    }
  };

  // 让拖拽监听始终拿到最新的 addFiles（避免反复重绑监听）
  const addFilesRef = useRef(addFiles);
  useEffect(() => {
    addFilesRef.current = addFiles;
  }, [addFiles, attachments]);

  // 拖拽上传（dragCounter 防子元素嵌套闪烁）
  useEffect(() => {
    const container = document.querySelector('.composer');
    if (!container) return;
    const onDragEnter = (e) => { e.preventDefault(); dragCounter.current++; setDragging(true); };
    const onDragOver = (e) => e.preventDefault();
    const onDragLeave = (e) => {
      e.preventDefault();
      dragCounter.current--;
      if (dragCounter.current <= 0) { dragCounter.current = 0; setDragging(false); }
    };
    const onDrop = (e) => {
      e.preventDefault();
      dragCounter.current = 0;
      setDragging(false);
      addFilesRef.current(e.dataTransfer?.files);
    };
    container.addEventListener('dragenter', onDragEnter);
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('dragleave', onDragLeave);
    container.addEventListener('drop', onDrop);
    return () => {
      container.removeEventListener('dragenter', onDragEnter);
      container.removeEventListener('dragover', onDragOver);
      container.removeEventListener('dragleave', onDragLeave);
      container.removeEventListener('drop', onDrop);
    };
  }, []);

  // 粘贴图片（优先取剪贴板图片）
  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const img = Array.from(items).find((i) => i.type.startsWith('image/'));
    if (!img) return;
    e.preventDefault();
    const file = img.getAsFile();
    if (file) {
      const renamed = new File([file], `pasted_${Date.now()}.png`, { type: file.type });
      addFiles([renamed]);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const handleChange = (e) => {
    onChange(e.target.value);
  };

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, [value, taRef]);

  return (
    <div className="composer">
      {dragging && <div className="composer-drop-hint">松开上传到媒体库并附加</div>}

      {quote && (
        <div className="quote-bar">
          <span className="quote-role">{quote.role === 'user' ? '引用你的消息' : '引用 AI 回复'}</span>
          <span className="quote-text">{quote.text}</span>
          <button className="quote-close" onClick={onCancelQuote} title="取消引用" aria-label="取消引用">✕</button>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a) => (
            <span key={a.id} className="composer-attach">
              {a.kind === 'image' ? (
                <img className="thumb" src={`/api/media/${a.id}`} alt="" />
              ) : a.kind === 'video' ? (
                '🎬'
              ) : a.kind === 'audio' ? (
                '🎵'
              ) : (
                '📄'
              )}
              <span className="attach-name">{a.name}</span>
              <button
                className="attach-remove"
                title="移除"
                onClick={() => onAttachmentsChange(attachments.filter((x) => x.id !== a.id))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer-row">
        <button className="composer-attach-btn" title="从媒体库选择" onClick={() => setPickerOpen(true)}>📎</button>
        <textarea
          ref={taRef}
          className="composer-input"
          placeholder={disabled ? '先新建一个会话' : streaming ? '生成中，可预打字…（结束后发送）' : '输入消息，Enter 发送，Shift+Enter 换行'}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          disabled={disabled}
        />
        {streaming ? (
          <button className="stop-btn" onClick={onStop}>■ 停止</button>
        ) : (
          <button className="send-btn" onClick={submit} disabled={disabled || (!value.trim() && !attachments.length) || uploading}>
            {uploading ? '上传中…' : '发送'}
          </button>
        )}
      </div>

      {uploadError && <div className="composer-upload-error">{uploadError}</div>}

      <MediaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(sel) => onAttachmentsChange([...attachments, ...sel])}
      />
    </div>
  );
}
