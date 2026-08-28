import https from 'node:https';
import crypto from 'node:crypto';
import { Jimp } from 'jimp';

/**
 * vision.js — 图片转文字描述（给纯文本主模型"看图"）
 * 视觉理解配置只认「设置→模型配置→视觉理解」（mediaConfig.vision 注入），
 * 不再读 env（VISION_ 系列已退役）。没配 → 提示去配置页填写。
 */

const DEF_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const MAX_VISION_BYTES = 500 * 1024; // 超过 500KB 先压缩，避免视觉 API 对超大图超时
const MAX_DIM = 1024;

/** 视觉理解配置注入点（server.js 装配时喂 mediaConfig.getVision） */
let visionConfigProvider = null;
export function setVisionConfigProvider(fn) {
  visionConfigProvider = fn;
}

/** 收集视觉后端：只读配置页的 vision（无 env 兜底，填什么用什么）。 */
function readVisionBackends() {
  const v = visionConfigProvider ? visionConfigProvider() : null;
  if (!v || !v.apiKey) return [];
  return [{ baseUrl: v.baseUrl || DEF_BASE_URL, apiKey: v.apiKey, model: v.model }];
}

// 转译结果缓存（按"模型:图片哈希"隔离，不同模型不串结果）
const cache = new Map();

function hashImage(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 大图压缩：缩到最长边 1024 + JPEG q85（视觉 API 处理小图快很多）。 */
async function maybeCompress(buf, mime) {
  if (buf.length <= MAX_VISION_BYTES) return { buf, mime };
  try {
    const image = await Jimp.read(buf);
    image.scaleToFit({ w: MAX_DIM, h: MAX_DIM });
    const out = await image.getBuffer('image/jpeg', { quality: 85 });
    return { buf: out, mime: 'image/jpeg' };
  } catch {
    return { buf, mime };
  }
}

/** 单个后端调用（含缓存）。 */
function callBackend(cfg, cb, cm, cacheKey) {
  if (cache.has(cacheKey)) return Promise.resolve({ ok: true, text: cache.get(cacheKey) });
  const base64 = cb.toString('base64');
  const payload = JSON.stringify({
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '请详细描述这张图片的内容（主体、颜色、画面布局、画面里的文字、关键细节、风格）' },
          { type: 'image_url', image_url: { url: `data:${cm || 'image/png'};base64,${base64}` } },
        ],
      },
    ],
  });
  return new Promise((resolve) => {
    const req = https.request(
      cfg.baseUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 180000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            const text = j.choices?.[0]?.message?.content || '';
            if (text) {
              cache.set(cacheKey, text);
              resolve({ ok: true, text });
            } else {
              resolve({ ok: false, error: `模型 ${cfg.model} 无返回（${j.error?.message || '未知'}）` });
            }
          } catch {
            resolve({ ok: false, error: `模型 ${cfg.model} 响应解析失败` });
          }
        });
      },
    );
    req.on('error', (e) => resolve({ ok: false, error: `${cfg.model} 请求失败：${e.message}` }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: `${cfg.model} 超时` });
    });
    req.write(payload);
    req.end();
  });
}

/**
 * 图片转描述（多后端按序回退：第一个成功的用，全失败返回最后错误）。
 */
export async function describeImage(buf, mime) {
  const backends = readVisionBackends();
  if (!backends.length) {
    return { ok: false, error: '未配置视觉理解 key（请到 设置→模型配置→视觉理解 填写 baseUrl / API key / 模型）' };
  }
  const { buf: cb, mime: cm } = await maybeCompress(buf, mime);
  const h = hashImage(cb);
  let lastErr = '';
  for (const cfg of backends) {
    const r = await callBackend(cfg, cb, cm, `${cfg.model}:${h}`);
    if (r.ok) return r;
    lastErr = r.error || lastErr;
  }
  return { ok: false, error: lastErr || '所有视觉后端均失败' };
}
