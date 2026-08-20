/**
 * SSE 帧写入工具（node:http 用）。
 */

/** 写 SSE 响应头。 */
export function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/**
 * 写一条 SSE 帧。
 * @param {import('node:http').ServerResponse} res
 * @param {string} event
 * @param {unknown} data
 */
export function writeSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
