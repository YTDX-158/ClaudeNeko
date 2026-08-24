/**
 * export.js — 导出聊天记录为 .txt
 * 纯前端实现：拼文本 + Blob 下载，不涉及后端。
 */

/** 把消息数组拼成聊天记录文本（你/AI + 时间 + 内容）。
 *  @param {object} opts includeThinking=true 时把 AI 思考过程单独成段导出（默认不导出）。 */
export function messagesToText(messages, { includeThinking = false } = {}) {
  return (messages ?? [])
    .map((m) => {
      const role = m.role === 'user' ? '🙋 你' : '🤖 AI';
      const time = m.ts ? new Date(m.ts).toLocaleString() : '';
      // 纯附件消息导出附件名，避免内容为空
      const atts = m.attachments?.length
        ? `\n[附件: ${m.attachments.map((a) => a.name || a.id).join(', ')}]`
        : '';
      // AI 思考过程：可选导出，正文前独立一段（默认不导出，避免打扰）
      const think = includeThinking && m.thinking
        ? `🧠 [思考过程]\n${m.thinking}\n\n`
        : '';
      return `${role}${time ? `（${time}）` : ''}：\n${think}${m.text ?? ''}${atts}`;
    })
    .join('\n\n');
}

/** 单个会话 → 带标题/时间的完整文本。 */
export function exportSessionText(session, messages, opts) {
  const header = `【会话】${session?.title ?? '新会话'}\n【时间】${
    session?.updatedAt ? new Date(session.updatedAt).toLocaleString() : ''
  }\n\n`;
  return header + messagesToText(messages, opts) + '\n\n--- 会话结束 ---\n';
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
