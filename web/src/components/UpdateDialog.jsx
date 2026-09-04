import { DOWNLOAD_URL, markSeen, markLater } from '../updateCheck.js';

/**
 * 版本更新提示弹窗（9-04）：
 * - info.version 纯版本串（如 '2.4.6'）——用于 markSeen 去重
 * - info.name/body 来自 GitHub Release（body 仅纯文本渲染，防注入）
 * - 下载地址硬编码 DOWNLOAD_URL，不信任远端返回
 */
export default function UpdateDialog({ info, onClose }) {
  const handleDownload = () => {
    window.open(DOWNLOAD_URL, '_blank', 'noopener');
    markSeen(info.version); // 已引导去下载，不再重复弹（下个新版本仍会提醒）
    onClose();
  };
  const handleSeen = () => {
    markSeen(info.version);
    onClose();
  };
  const handleLater = () => {
    markLater(); // 24h 内不再弹
    onClose();
  };

  return (
    <div className="skin-modal" onClick={onClose}>
      <div className="skin-modal-box update-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="skin-modal-header">
          <span className="skin-modal-title">📦 发现新版本 {info.name}</span>
          <button type="button" className="skin-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="update-dialog-body">
          {info.body ? (
            <pre className="update-dialog-notes">{info.body}</pre>
          ) : (
            <p className="skin-hint">请前往 GitHub 查看更新说明。</p>
          )}
        </div>
        <div className="update-dialog-foot">
          <button type="button" className="skin-btn primary" onClick={handleDownload}>⬇ 去下载</button>
          <button type="button" className="skin-btn" onClick={handleLater}>稍后再说</button>
          <button type="button" className="skin-btn" onClick={handleSeen}>知道了</button>
        </div>
      </div>
    </div>
  );
}
