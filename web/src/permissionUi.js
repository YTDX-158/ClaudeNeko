const SUMMARY_LIMIT = 200;

export function isActiveSocketEvent(candidateSocket, eventSid, activeSocket, activeSid) {
  return candidateSocket === activeSocket && eventSid === activeSid;
}

export function releaseClosedSnapshotIds(currentClosedIds, appliedClosedIds) {
  const next = new Set(currentClosedIds || []);
  for (const id of appliedClosedIds || []) next.delete(id);
  return next;
}

export function shouldTrackClosedPermission(pendingLoadCount) {
  return Number(pendingLoadCount) > 0;
}

export function canPersistPermissionForHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

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

function boundedText(value, limit = SUMMARY_LIMIT) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/** Merge REST snapshots with cards already received over WS, keeping one card per request. */
export function mergePendingPermissions(current = [], incoming = []) {
  const merged = new Map();
  for (const permission of [...current, ...incoming]) {
    if (permission?.id) merged.set(permission.id, permission);
  }
  return [...merged.values()];
}

/** Apply an authoritative REST snapshot without losing WS cards that arrived after the request began. */
export function reconcilePendingSnapshot(current, snapshot, idsAtRequestStart, closedIds) {
  const stillOpenSnapshot = (snapshot || []).filter((permission) => (
    permission?.id && !closedIds.has(permission.id)
  ));
  const arrivedDuringLoad = (current || []).filter((permission) => (
    permission?.id
    && !idsAtRequestStart.has(permission.id)
    && !closedIds.has(permission.id)
  ));
  return mergePendingPermissions(stillOpenSnapshot, arrivedDuringLoad);
}

/** Build privacy-safe copy. Deliberately never reads tool_input. */
export function permissionCardCopy(permission = {}) {
  const label = TOOL_LABELS[permission.tool_name] || boundedText(permission.tool_name, 60) || '执行操作';
  const summary = boundedText(permission.summary)
    || (permission.hasInput ? '操作包含参数，详情已隐藏。' : '后端未提供更多操作详情。');
  const dangerous = permission.dangerous === true
    || permission.risk === 'dangerous'
    || permission.riskLevel === 'dangerous';
  const scope = boundedText(
    permission.alwaysScope
      || permission.always_scope
      || permission.ruleSummary
      || permission.rule,
    120,
  );

  return {
    label,
    summary,
    riskText: dangerous ? '高风险操作：批准前请仔细核对影响。' : '',
    alwaysText: scope
      ? `选择“以后都行”会记住并自动批准：${scope}`
      : '选择“以后都行”会记住并自动批准同类操作，请确认你信任此授权范围。',
  };
}

/** Await an approval request and always restore local interactivity; errors propagate to the hook. */
export async function runPermissionResponse(onRespond, action, setBusy) {
  setBusy(true);
  try {
    return await onRespond?.(action);
  } finally {
    setBusy(false);
  }
}

/** Only close local cards after the server confirms that cancellation succeeded. */
export async function runPermissionCancel(cancelRequest, onSuccess) {
  const result = await cancelRequest();
  onSuccess?.(result);
  return result;
}
