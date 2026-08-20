import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Jimp } from 'jimp';

/**
 * vision.js — 图片转文字描述（给纯文本主模型"看图"）
 * 面向市场：多后端视觉链（BYOK，任意 OpenAI 兼容视觉 API）。
 * 配置（~/.claude/settings.json env 或环境变量）：
 *   VISION_API_KEY / VISION_MODEL  → 第一后端（必需）
 *   VISION_2_API_KEY / VISION_2_MODEL 等 → 第二/三后端（可选，按序回退）
 *   VISION_BASE_URL（默认火山方舟）
 */

const DEF_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const MAX_VISION_BYTES = 500 * 1024; // 超过 500KB 先压缩，避免视觉 API 对超大图超时
const MAX_DIM = 1024;

/** 收集所有配置的视觉后端（按序：VISION_ → VISION_2_ → VISION_3_…）。 */
function readVisionBackends() {
  let env = {};
  try {
    env = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).env || {};
  } catch {
    // 无 settings.json
  }
  const backends = [];
  const read = (prefix) => {
    const key = process.env[`${prefix}API_KEY`] || env[`${prefix}API_KEY`];
    const model = process.env[`${prefix}MODEL`] || env[`${prefix}MODEL`];
    if (key && model) {
      backends.push({
        baseUrl: process.env[`${prefix}BASE_URL`] || env[`${prefix}BASE_URL`] || DEF_BASE_URL,
        apiKey: key,
        model,
      });
    }
  };
  read('VISION_');
  for (let i = 2; i <= 5; i++) read(`VISION_${i}_`);
  return backends;
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
    return { ok: false, error: '未配置视觉 API（请在 ~/.claude/settings.json 加 VISION_API_KEY / VISION_MODEL）' };
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
