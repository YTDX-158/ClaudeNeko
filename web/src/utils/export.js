/**
 * export.js — 导出聊天记录为 .txt
 * 纯前端实现：拼文本 + Blob 下载，不涉及后端。
 */

/** 把消息数组拼成聊天记录文本（你/AI + 时间 + 内容）。 */
export function messagesToText(messages) {
  return (messages ?? [])
    .map((m) => {
      const role = m.role === 'user' ? '🙋 你' : '🤖 AI';
      const time = m.ts ? new Date(m.ts).toLocaleString() : '';
      return `${role}${time ? `（${time}）` : ''}：\n${m.text ?? ''}`;
    })
    .join('\n\n');
}

/** 单个会话 → 带标题/时间的完整文本。 */
export function exportSessionText(session, messages) {
  const header = `【会话】${session?.title ?? '新会话'}\n【时间】${
    session?.updatedAt ? new Date(session.updatedAt).toLocaleString() : ''
  }\n\n`;
  return header + messagesToText(messages) + '\n\n--- 会话结束 ---\n';
}

/** 触发浏览器下载 .txt 文件。 */
export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
