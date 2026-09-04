import { useEffect, useState } from 'react';
import { api } from '../api.js';

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function formatParams(record) {
  const parts = [];
  if (record.resolution) parts.push(record.resolution);
  if (record.duration != null) parts.push(`${record.duration}s`);
  if (record.ratio) parts.push(record.ratio);
  return parts.join(' · ') || '—';
}

function formatFile(record) {
  const name = record.fileName || (record.mediaId ? '文件在媒体库' : '—');
  return record.sizeMb != null ? `${name} · ${record.sizeMb}MB` : name;
}

export default function MediaLedger() {
  const [enabled, setEnabled] = useState(true);
  const [records, setRecords] = useState([]);
  const [softMax, setSoftMax] = useState(5000);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  const [detail, setDetail] = useState(null); // 点击提示词打开的全文弹窗
  const [copiedId, setCopiedId] = useState(''); // 刚复制成功的记录 id（短暂"已复制"反馈）

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.mediaLog();
      setEnabled(data.enabled ?? true);
      setRecords(Array.isArray(data.records) ? data.records : []);
      setSoftMax(Number(data.softMax) || 5000);
    } catch (e) {
      setError(e.message || '台账读取失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const toggleEnabled = async () => {
    const previous = enabled;
    const next = !previous;
    setEnabled(next);
    setChanging(true);
    setError('');
    try {
      await api.mediaLogEnabled(next);
    } catch (e) {
      setEnabled(previous);
      setError(e.message || '台账开关更新失败');
    } finally {
      setChanging(false);
    }
  };

  const clearRecords = async () => {
    if (!records.length || !window.confirm('确定清空全部台账记录？媒体文件会保留。')) return;
    setChanging(true);
    setError('');
    try {
      await api.mediaLogDelete({ all: true });
      setRecords([]);
      await refresh();
    } catch (e) {
      setError(e.message || '清空台账失败');
    } finally {
      setChanging(false);
    }
  };

  /** 复制提示词：优先 Clipboard API；非 https/localhost 环境降级 execCommand */
  const copyPrompt = async (record) => {
    const text = record?.prompt || '';
    const showCopied = () => {
      setCopiedId(record.id);
      setTimeout(() => setCopiedId(''), 1500);
    };
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showCopied();
        return;
      }
      throw new Error('clipboard 不可用');
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showCopied();
      } catch {
        // 复制失败静默（弹窗里仍可手动选中）
      }
    }
  };

  return (
    <section className="media-log-panel" aria-label="媒体生成台账">
      <div className="media-log-toolbar">
        <label className="media-log-toggle" title="关闭后不再记录新的生成，历史记录保留">
          <input type="checkbox" checked={enabled} disabled={changing} onChange={toggleEnabled} />
          记录生成台账
        </label>
        <span className="skin-hint">
          共 {records.length} 条{records.length >= softMax ? '（已达软上限，建议清理）' : ''}
        </span>
        <button type="button" className="skin-btn" onClick={refresh} disabled={loading || changing}>
          刷新
        </button>
        <button type="button" className="skin-btn danger" onClick={clearRecords} disabled={!records.length || changing}>
          清空记录
        </button>
      </div>

      {error && <div className="media-log-error" role="alert">{error}</div>}
      {loading ? (
        <div className="skin-hint media-log-state">加载中…</div>
      ) : records.length === 0 ? (
        <div className="skin-hint media-log-state">暂无台账记录，生成图片或视频后会自动记录。</div>
      ) : (
        <div className="media-log-table-wrap">
          <table className="media-log-table">
            <thead>
              <tr>
                <th>时间</th><th>类型</th><th>模型</th><th>提示词</th>
                <th>参数</th><th>结果</th><th>文件</th><th>成本</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td className="media-log-time">{formatTime(record.time)}</td>
                  <td>
                    <span className={`media-log-kind ${record.type}`}>
                      {record.type === 'image' ? '图片' : '视频'}
                    </span>
                  </td>
                  <td className="media-log-model" title={record.model}>{record.model || '—'}</td>
                  <td>
                    <span
                      className="media-log-prompt"
                      title={record.prompt || ''}
                      role={record.prompt ? 'button' : undefined}
                      tabIndex={record.prompt ? 0 : undefined}
                      aria-label={record.prompt ? '查看完整提示词' : undefined}
                      onClick={record.prompt ? () => setDetail(record) : undefined}
                      onKeyDown={record.prompt ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setDetail(record);
                        }
                      } : undefined}
                    >
                      {record.prompt || '（无提示词）'}
                      {record.prompt && (
                        <button
                          type="button"
                          className={`media-log-copy${copiedId === record.id ? ' copied' : ''}`}
                          title={copiedId === record.id ? '已复制' : '复制提示词'}
                          onClick={(e) => {
                            e.stopPropagation();
                            copyPrompt(record);
                          }}
                        >
                          {copiedId === record.id ? '✓' : '📋'}
                        </button>
                      )}
                    </span>
                  </td>
                  <td className="media-log-params">{formatParams(record)}</td>
                  <td>
                    <span className={`media-log-result ${record.result}`} title={record.error || ''}>
                      {record.result === 'success' ? '成功' : '失败'}
                    </span>
                  </td>
                  <td className="media-log-file" title={record.fileName || ''}>{formatFile(record)}</td>
                  <td>—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="skin-modal" onClick={() => setDetail(null)}>
          <div className="skin-modal-box media-log-modal" onClick={(e) => e.stopPropagation()}>
            <div className="skin-modal-header">
              <span className="skin-modal-title">
                {detail.type === 'image' ? '图片' : '视频'}提示词 · {formatTime(detail.time)}
              </span>
              <button type="button" className="skin-btn" onClick={() => setDetail(null)}>×</button>
            </div>
            <pre className="media-log-modal-prompt">{detail.prompt || '（无提示词）'}</pre>
            <div className="media-log-modal-foot">
              <button type="button" className="skin-btn" onClick={() => copyPrompt(detail)}>
                {copiedId === detail.id ? '✓ 已复制' : '📋 复制提示词'}
              </button>
              <button type="button" className="skin-btn" onClick={() => setDetail(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
