/**
 * SSE 流式客户端：fetch + ReadableStream 逐帧解析。
 * 后端帧格式：`event: <name>\ndata: <json>\n\n`
 * 事件：start / text_delta / assistant / done / error
 */
export class StreamClient {
  /**
   * @param {object} opts
   * @param {(event: string, data: any) => void} opts.onEvent
   * @param {(err: Error) => void} opts.onError
   * @param {AbortSignal} [opts.signal]
   */
  constructor({ onEvent, onError, signal }) {
    this.onEvent = onEvent;
    this.onError = onError;
    this.signal = signal;
  }

  async send(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.signal,
    });

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = (await res.json()).error ?? msg;
      } catch {
        // 响应非 JSON
      }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      // \n\n 为帧边界；可能一帧跨多个 chunk，留残余继续拼
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        this.#parseFrame(frame);
      }
    }
  }

  #parseFrame(frame) {
    let event = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (!data) return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    this.onEvent(event, parsed);
  }
}
