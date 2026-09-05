import { useState } from 'react';

// 权限体系 P1-3：把 claude 工具名翻译成人话（小白能看懂 Claude 想干嘛）
const TOOL_LABELS = {
  Read: '读取文件',
  Write: '写入文件',
  Edit: '修改文件',
  MultiEdit: '批量修改文件',
  Bash: '运行命令',
  WebFetch: '访问网页',
  WebSearch: '搜索网页',
  Glob: '查找文件',
  Grep: '搜索文件内容',
  LS: '查看目录',
  Task: '执行子任务',
  Agent: '启动子代理',
};

/**
 * 权限审批卡片：显示在聊天区（Claude 请求权限时弹出），三个档位。
 * @param {{ perm: {id:string, tool_name:string, hasInput?:boolean}, onRespond:(action:'once'|'always'|'deny')=>void }} props
 */
export default function PermCard({ perm, onRespond }) {
  const [busy, setBusy] = useState(false);
  const label = TOOL_LABELS[perm?.tool_name] || perm?.tool_name || '执行操作';
  const act = (a) => {
    setBusy(true);
    onRespond?.(a);
  };
  return (
    <div className="perm-card">
      <div className="perm-card-head">🔐 Claude 请求权限</div>
      <div className="perm-card-msg">
        Claude 想<b> {label} </b>
        {perm?.hasInput ? '（附操作参数）' : ''}
        <span className="perm-card-hint">——要不要让它继续？</span>
      </div>
      <div className="perm-card-actions">
        <button className="skin-btn perm-btn-once" disabled={busy} onClick={() => act('once')}>只此一次</button>
        <button className="skin-btn perm-btn-always" disabled={busy} onClick={() => act('always')}>以后都行</button>
        <button className="skin-btn perm-btn-deny" disabled={busy} onClick={() => act('deny')}>不行</button>
      </div>
    </div>
  );
}
