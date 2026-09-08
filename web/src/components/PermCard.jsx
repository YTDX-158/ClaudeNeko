import { useId, useState } from 'react';
import { canPersistPermissionForHost, permissionCardCopy, runPermissionResponse } from '../permissionUi.js';

/**
 * 权限审批卡片：显示在聊天区（Claude 请求权限时弹出），三个档位。
 * @param {{ perm: {id:string, tool_name:string, summary?:string, dangerous?:boolean, alwaysScope?:string}, onRespond:(action:'once'|'always'|'deny')=>Promise<boolean> }} props
 */
export default function PermCard({ perm, onRespond, autoFocus = false }) {
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const copy = permissionCardCopy(perm);
  const canPersist = canPersistPermissionForHost(globalThis.location?.hostname);
  const act = async (action) => {
    if (busy) return false;
    return runPermissionResponse(onRespond, action, setBusy);
  };
  return (
    <div
      className="perm-card"
      role="alertdialog"
      aria-live="assertive"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <div className="perm-card-head" id={titleId}>🔐 Claude 请求权限</div>
      <div className="perm-card-msg" id={descriptionId}>
        Claude 想<b> {copy.label} </b>
        <span className="perm-card-hint">——要不要让它继续？</span>
        <div className="perm-card-summary">{copy.summary}</div>
        {copy.riskText && <div className="perm-card-risk">{copy.riskText}</div>}
        {canPersist && <div className="perm-card-scope">{copy.alwaysText}</div>}
      </div>
      <div className="perm-card-actions">
        <button className="skin-btn perm-btn-once" disabled={busy} autoFocus={autoFocus} onClick={() => act('once')}>只此一次</button>
        {canPersist && <button className="skin-btn perm-btn-always" disabled={busy} onClick={() => act('always')}>以后都行</button>}
        <button className="skin-btn perm-btn-deny" disabled={busy} onClick={() => act('deny')}>不行</button>
      </div>
    </div>
  );
}
