import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import PermCard from './PermCard.jsx'; // 权限体系 P1-3：Claude 权限请求卡片（显示在输入框上方）
import MediaPicker from './MediaPicker.jsx';
import RefImagePicker from './RefImagePicker.jsx';
import SkillBar from './SkillBar.jsx';
import { uploadToMedia } from '../utils/upload.js';
import { readConfirmMedia } from '../utils/mediaConfirm.js';
import { api } from '../api.js';

/**
 * 输入区：Enter 发送 / Shift+Enter 换行；生成中可预打字。
 * 附件（图片/视频/文档）：拖拽 / 粘贴图片 / 📎媒体库选择 → 统一上传管线 → 附件条。
 * 引用：quote 非空时输入框上方显示引用栏；发送时父级拼成 markdown 引用块。
 */
const Composer = forwardRef(function Composer({
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
  onGenSend,
  permPending,
  onPermRespond,
}, ref) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 技能包：生图 / 生视频
  const [skill, setSkill] = useState(null);
  const [genOpts, setGenOpts] = useState({ model: '', ratio: '9:16', duration: undefined, resolution: undefined, refMode: '' });
  const [mediaCfg, setMediaCfg] = useState(null);
  const [refPickerOpen, setRefPickerOpen] = useState(false); // @ 补全参考图面板
  const [refInsertPos, setRefInsertPos] = useState(null); // 插入 @imageN 后光标恢复位置

  useEffect(() => {
    api
      .mediaConfig()
      .then((cfg) => setMediaCfg(cfg))
      .catch(() => setMediaCfg(null));
  }, []);

  // 切换技能 → 默认选中该技能第一个模型
  const handleSkillChange = (sk) => {
    setSkill(sk);
    setRefPickerOpen(false); // 切技能关 @ 面板
    if (sk) {
      setGenOpts((o) => {
        const next = { ...o };
        // image/video 技能切模型到该技能第一个
        if (sk === 'image' || sk === 'video') {
          const list = sk === 'image' ? mediaCfg?.imageModels || [] : mediaCfg?.videoModels || [];
          next.model = list[0]?.id || o.model;
        }
        // F2：切到生视频重置时长/分辨率，防跨技能遗留越界（如 2.0 的 4K 切回 2.5 无 4K → 提交失败）
        if (sk === 'video') {
          next.duration = undefined;
          next.resolution = undefined;
        }
        return next;
      });
    }
  };
  const submit = () => {
    // 技能模式：走生成 API，不触发 claude 回复
    if (skill && onGenSend) {
      if (streaming) return; // 聊天流式中不能技能生成：占位 streaming:true 会被流式增量污染
      if (uploading) return; // F3：上传中不触发（防参考图漏带 + 附件清空后上传完成"复活"）
      const t = value.trim();
      if (!t) return;
      const opts = { skill, prompt: t, model: genOpts.model, ratio: genOpts.ratio, resolution: genOpts.resolution };
      if (skill === 'video') {
        // duration ?? min：滑块显示与提交保持一致（初始未拖 = 用该模型最低时长）
        const cur = (mediaCfg?.videoModels || []).find((m) => m.id === genOpts.model);
        opts.duration = genOpts.duration ?? cur?.durationRange?.min;
        // 参考图：附件里的图片按顺序作为参考（上传/媒体库两个入口天然都有）
        let imgs = attachments.filter((a) => a.kind === 'image');
        // F1：显式选「无」(none) 时不发参考图；''（未选）挂图才默认参考素材
        if (imgs.length && genOpts.refMode !== 'none') {
          if (genOpts.refMode === 'first') imgs = imgs.slice(0, 1); // 首帧只用第 1 张
          else if (genOpts.refMode === 'firstlast') imgs = [imgs[0], imgs[imgs.length - 1]].filter(Boolean); // F4：首帧 + 末帧
          else imgs = imgs.slice(0, 8); // 参考素材上限 8
          opts.refMode = genOpts.refMode || 'ref'; // 挂了图但没选方式 → 默认参考素材
          opts.refImages = imgs.map((a) => a.id);
        }
      }
      // 生成前确认（设置→功能页开关，默认关）：防误触白白消耗 API 额度
      if (readConfirmMedia()) {
        const what = skill === 'video' ? '🎬 视频' : '🖼 图片';
        const lines = [
          `即将生成${what}`,
          `模型：${genOpts.model}`,
          `分辨率：${genOpts.resolution || '默认'}`,
        ];
        if (skill === 'video') lines.push(`时长：${opts.duration || '默认'}s`);
        if (!window.confirm(lines.join('\n') + '\n\n确认生成？')) return; // 取消=保留输入，可继续编辑
      }
      onGenSend(opts);
      onChange('');
      if (taRef.current) taRef.current.style.height = 'auto';
      onAttachmentsChange([]); // 生视频提交后清空附件（与普通发送一致）
      return;
    }
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
      if (ok.length) onAttachmentsChange((prev) => [...prev, ...ok]); // F3：函数式更新，防交叉上传覆盖丢附件
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

  // 暴露 addFiles 给父级（聊天区拖放转发用）：稳定引用，始终调最新
  useImperativeHandle(ref, () => ({ addFiles: (files) => addFilesRef.current(files) }), []);

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

  // @ 补全：生视频技能下，光标前是 @ 时弹参考图面板（onKeyUp 读稳定光标；打开后保持直到选图/Esc/点外/切技能）
  const handleKeyUp = (e) => {
    if (skill !== 'video') return;
    const ta = taRef.current;
    if (!ta) return;
    if (value[ta.selectionStart - 1] === '@') setRefPickerOpen(true);
  };

  // 面板引用"已挂的图"：插入 @imageN（N=该图在附件的 index+1），图已在附件，不加附件
  const handleRefSelect = (media, index) => {
    const ta = taRef.current;
    const pos = ta ? ta.selectionStart : value.length;
    // 实测抓 bug：光标前是刚输入的 @（触发面板的那个）→ 替换它（插入到 @ 位置并跳过 @），避免 @@image1 / 残留 @
    const replaceAt = pos > 0 && value[pos - 1] === '@';
    const start = replaceAt ? pos - 1 : pos;
    const insert = `@image${index + 1} `;
    const next = value.slice(0, start) + insert + value.slice(start + (replaceAt ? 1 : 0));
    onChange(next);
    setRefInsertPos(start + insert.length); // 光标恢复位置
  };

  // 插入后恢复光标到插入文本后（React 受控输入框光标复位经典坑）
  useEffect(() => {
    if (refInsertPos == null) return;
    const ta = taRef.current;
    if (ta) ta.setSelectionRange(refInsertPos, refInsertPos);
    setRefInsertPos(null);
  }, [refInsertPos, value]);

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
      {skill === 'video' && (
        <RefImagePicker
          open={refPickerOpen}
          onClose={() => setRefPickerOpen(false)}
          onSelect={handleRefSelect}
          attachedImages={attachments.filter((a) => a.kind === 'image')}
        />
      )}

      {Array.isArray(permPending) && permPending.length > 0 && (
        <div className="perm-cards">
          {permPending.map((p, index) => (
            <PermCard key={p.id} perm={p} autoFocus={index === 0} onRespond={(a) => onPermRespond?.(p.id, a)} />
          ))}
        </div>
      )}

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

      {skill === 'video' && attachments.filter((a) => a.kind === 'image').length > 0 && (
        <div className="composer-refnote">
          📌 图片将作为参考图
          {genOpts.refMode === 'first'
            ? '（首帧只用第 1 张）'
            : genOpts.refMode === 'firstlast'
              ? '（首帧 + 末帧）'
              : genOpts.refMode === 'none'
                ? '（无参考，图片将忽略）'
                : '（参考素材）'}
        </div>
      )}

      <div className="composer-row">
        <button className="composer-attach-btn" title="从媒体库选择" onClick={() => setPickerOpen(true)}>📎</button>
        <textarea
          ref={taRef}
          className="composer-input"
          placeholder={
            disabled
              ? '先新建一个会话'
              : skill === 'image'
                ? '描述要生成的画面，Enter 生成…'
                : skill === 'video'
                  ? '描述镜头，Enter 生成视频…'
                  : streaming
                    ? '生成中，可预打字…（结束后发送）'
                    : '输入消息，Enter 发送，Shift+Enter 换行'
          }
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onPaste={handlePaste}
          rows={1}
          disabled={disabled}
        />
        {streaming && !skill ? (
          <button className="stop-btn" onClick={onStop}>■ 停止</button>
        ) : (
          <button
            className="send-btn"
            onClick={submit}
            disabled={
              disabled ||
              uploading ||
              streaming || // F7：技能模式 streaming 中禁用（防按钮可点但静默无效）
              (skill ? !value.trim() : !value.trim() && !attachments.length)
            }
          >
            {uploading ? '上传中…' : skill ? (skill === 'video' ? '生成视频' : '生成') : '发送'}
          </button>
        )}
      </div>

      <SkillBar
        skill={skill}
        onSkillChange={handleSkillChange}
        opts={genOpts}
        onOptsChange={setGenOpts}
        mediaCfg={mediaCfg}
      />

      {uploadError && <div className="composer-upload-error">{uploadError}</div>}

      <MediaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(sel) => onAttachmentsChange([...attachments, ...sel])}
      />
    </div>
  );
});
export default Composer;
