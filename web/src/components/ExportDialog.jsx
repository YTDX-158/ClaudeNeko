import { useState } from 'react';

/**
 * 统一导出面板（v1.6.0 导出整合）：
 * 任何"导出对话"入口弹它，选形式 + 是否含思考。
 * - 形式由调用方传入 formats（如 [{value:'txt',label:'文本(.txt)'},{value:'json',label:'数据(.json)'}]）
 * - 含思考勾选读写全局键 neko-export-thinking（与侧栏批量导出一致）
 * - onExport(format, includeThinking)：调用方按 format 执行实际导出
 */
export default function ExportDialog({ title, scopeLabel, formats = [], onExport, onClose }) {
  const [format, setFormat] = useState(formats[0]?.value ?? 'txt');
  const [includeThinking, setIncludeThinking] = useState(() => {
    try {
      return localStorage.getItem('neko-export-thinking') === '1';
    } catch {
      return false;
    }
  });

  const toggleThinking = (checked) => {
    setIncludeThinking(checked);
    try {
      localStorage.setItem('neko-export-thinking', checked ? '1' : '0');
    } catch {
      // 隐私模式等，忽略
    }
  };

  const handleConfirm = () => {
    onExport?.(format, includeThinking);
    onClose?.();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="export-title">{title}</h3>
        {scopeLabel && <p className="export-scope">{scopeLabel}</p>}
        <div className="export-formats">
          {formats.map((f) => (
            <label key={f.value} className="export-format-opt">
              <input type="radio" name="export-format" checked={format === f.value} onChange={() => setFormat(f.value)} />
              <span>{f.label}</span>
            </label>
          ))}
        </div>
        {formats.some((f) => f.value === 'txt') && (
          <label className="export-thinking-opt">
            <input type="checkbox" checked={includeThinking} onChange={(e) => toggleThinking(e.target.checked)} />
            <span>包含思考过程（仅文本形式生效）</span>
          </label>
        )}
        <div className="export-actions">
          <button className="export-btn primary" onClick={handleConfirm}>
            导出
          </button>
          <button className="export-btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
