import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Jimp } from 'jimp';

/**
 * vision.js — 图片转文字描述（给纯文本模型"看图"）
 * 思路参照 dsh-vision-proxy：视觉模型把图片转成文字，喂给纯文本主模型。
 * BYOK：VISION_BASE_URL / VISION_API_KEY / VISION_MODEL（环境变量或 ~/.claude/settings.json env）。
 */

function readVisionConfig() {
  let env = {};
  try {
    env = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).env || {};
  } catch {
    // 无 settings.json 用默认
  }
  return {
    baseUrl:
      process.env.VISION_BASE_URL || env.VISION_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    apiKey: process.env.VISION_API_KEY || env.VISION_API_KEY || '',
    model: process.env.VISION_MODEL || env.VISION_MODEL || '',
  };
}

// 转译结果缓存（同一张图不重复调视觉 API，省 token）
const cache = new Map();

function hashImage(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 把图片 buffer 转成文字描述。
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
const MAX_VISION_BYTES = 500 * 1024; // 超过 500KB 先压缩，避免豆包视觉对超大图超时
const MAX_DIM = 1024;

/** 大图压缩：缩到最长边 1536 + JPEG q85（视觉 API 处理小图快很多）。 */
async function maybeCompress(buf, mime) {
  if (buf.length <= MAX_VISION_BYTES) return { buf, mime };
  try {
    const image = await Jimp.read(buf);
    image.scaleToFit({ w: MAX_DIM, h: MAX_DIM });
    const out = await image.getBuffer('image/jpeg', { quality: 85 });
    return { buf: out, mime: 'image/jpeg' };
  } catch {
    return { buf, mime }; // 压缩失败用原图
  }
}

export async function describeImage(buf, mime) {
  const cfg = readVisionConfig();
  if (!cfg.apiKey || !cfg.model) {
    return { ok: false, error: '未配置视觉 API（请在 ~/.claude/settings.json 加 VISION_API_KEY / VISION_MODEL）' };
  }

  const { buf: cb, mime: cm } = await maybeCompress(buf, mime);
  const h = hashImage(cb);
  const cacheKey = `${cfg.model}:${h}`; // 缓存按模型隔离，避免不同模型串结果
  if (cache.has(cacheKey)) return { ok: true, text: cache.get(cacheKey) };

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
              resolve({ ok: false, error: `视觉 API 无返回（${j.error?.message || '未知'}）` });
            }
          } catch {
            resolve({ ok: false, error: '视觉 API 响应解析失败' });
          }
        });
      },
    );
    req.on('error', (e) => resolve({ ok: false, error: `视觉 API 请求失败：${e.message}` }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: '视觉 API 超时' });
    });
    req.write(payload);
    req.end();
  });
}
