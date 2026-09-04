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
                    <span className="media-log-prompt" title={record.prompt}>
                      {record.prompt || '（无提示词）'}
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
    </section>
  );
}
