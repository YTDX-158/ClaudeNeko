// mediaGen.js — 生成媒体服务（Seedream 生图 / Seedance 生视频 / 下载视频+转录）
// BYOK：DOUBAO_API_KEY 由 settings 注入（env 或 ~/.claude/settings.json），不硬编码；
// 模型可用性由运行时动态判定（失败=当前 key 未开通），不写死 available。
// 生成结果经 saveMedia 存入媒体库，前端用 /api/media/{id} 展示。
import fs from 'node:fs';
import { saveMedia, getMedia, getMediaPath } from './mediaStore.js';
import { transcribeAudio } from './mediaUnderstand.js';

const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const TASK_TTL = 10 * 60 * 1000; // 任务 10 分钟清理，防内存泄漏
const MAX_ACTIVE = 1; // 并发：同时只允许一个生成任务，防超并发烧额度

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {{ doubaoKey:string, imageModels:any[], videoModels:any[], ratios:string[], imageSizes:object, downloadBlacklist:string[], transcribeEnabled:boolean }} cfg
 */
/** 生图尺寸计算：目标像素档 × 比例 → clamp 边长≤4096 + 校验≥下限（Seedream 5.0）。
 *  标签是档位不是精确像素：非 1:1 的 4K = 该比例下 clamped 的最大合法尺寸。 */
function calcImageSize(ratio, resolution) {
  const TARGET = { '2K': 3686400, '3K': 8294400, '4K': 16777216 };
  const MAX_SIDE = 4096;
  const MIN_PIXELS = 3686400;
  const [a, b] = String(ratio || '1:1').split(':').map(Number);
  if (!a || !b) return '1920x1920';
  const target = TARGET[String(resolution || '2K')] || TARGET['2K'];
  let w = Math.sqrt((target * a) / b);
  let h = Math.sqrt((target * b) / a);
  const clamp = () => {
    const s = Math.min(1, MAX_SIDE / Math.max(w, h));
    w = Math.round(w * s);
    h = Math.round(h * s);
  };
  clamp();
  if (w * h < MIN_PIXELS) {
    const up = Math.sqrt(MIN_PIXELS / (w * h));
    w = Math.round(w * up);
    h = Math.round(h * up);
    clamp();
  }
  if (w % 2) w -= 1;
  if (h % 2) h -= 1;
  // 偶数化可能让像素略低于下限（差极小）：给短边 +2 达标
  if (w * h < MIN_PIXELS) {
    if (w <= h) w += 2;
    else h += 2;
  }
  return `${w}x${h}`;
}

export function createMediaService(cfg) {
  const { doubaoKey, imageModels, videoModels, ratios, imageResolutions, downloadBlacklist, transcribeEnabled } = cfg;
  const tasks = new Map(); // taskId -> {status, mediaId?, error?, ts}
  let active = 0;
  let seq = 0;

  const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${doubaoKey}` });

  async function arkFetch(path, opts) {
    const res = await fetch(`${ARK_BASE}${path}`, opts);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = j?.error || {};
      throw new ApiError(e.code || `HTTP_${res.status}`, e.message || `请求失败（HTTP ${res.status}）`);
    }
    return j;
  }

  function requireKey() {
    if (!doubaoKey) {
      throw new ApiError('NO_KEY', '未配置生成 key（DOUBAO_API_KEY），请在 ~/.claude/settings.json 的 env 或环境变量里配置');
    }
  }
  const isImageModel = (id) => imageModels.some((m) => m.id === id);
  const isVideoModel = (id) => videoModels.some((m) => m.id === id);
  const isValidRatio = (r) => ratios.includes(r);

  /** 下载任意 URL → 存媒体库 → 返回 mediaId（供生成结果 / 下载视频共用） */
  async function downloadToMedia(url, ext) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    } catch {
      throw new ApiError('DOWNLOAD_FAIL', '下载失败（网络错误或超时）');
    }
    if (!res.ok) throw new ApiError('DOWNLOAD_FAIL', `下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new ApiError('DOWNLOAD_FAIL', '下载内容为空');
    const r = saveMedia(buf, `gen_${Date.now()}.${ext}`);
    if (!r?.ok || !r.media?.id) throw new ApiError('SAVE_FAIL', '媒体保存失败');
    return r.media.id;
  }

  // ---- 生图（同步，2-5s）----
  async function generateImage({ prompt, model, ratio, resolution }) {
    requireKey();
    if (!isImageModel(model)) throw new ApiError('MODEL_UNAVAILABLE', `当前 key 未开通此模型：${model}`);
    if (!isValidRatio(ratio)) throw new ApiError('INVALID_RATIO', `比例不支持：${ratio}`);
    const size = calcImageSize(ratio, resolution);
    const j = await arkFetch('/images/generations', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model, prompt, size, watermark: false }),
    });
    const item = (j?.data || [])[0];
    if (!item) throw new ApiError('NO_RESULT', '生图无返回');
    let mediaId;
    if (item.b64_json) {
      const r = saveMedia(Buffer.from(item.b64_json, 'base64'), `gen_${Date.now()}.png`);
      if (!r?.ok) throw new ApiError('SAVE_FAIL', '图片保存失败');
      mediaId = r.media.id;
    } else if (item.url) {
      mediaId = await downloadToMedia(item.url, 'png');
    } else {
      throw new ApiError('NO_RESULT', '生图返回格式异常');
    }
    return { mediaId };
  }

  // ---- 生视频（异步任务，前端轮询）----
  async function generateVideo({ prompt, model, ratio, duration, resolution }) {
    requireKey();
    if (!isVideoModel(model)) throw new ApiError('MODEL_UNAVAILABLE', `当前 key 未开通此模型：${model}`);
    if (!isValidRatio(ratio)) throw new ApiError('INVALID_RATIO', `比例不支持：${ratio}`);
    const m = videoModels.find((x) => x.id === model);
    if (duration && !m.durations.includes(Number(duration))) {
      throw new ApiError('INVALID_DURATION', `该模型不支持时长 ${duration}s`);
    }
    if (resolution && !m.resolutions.includes(String(resolution))) {
      throw new ApiError('INVALID_RESOLUTION', `该模型不支持分辨率 ${resolution}`);
    }
    if (active >= MAX_ACTIVE) throw new ApiError('BUSY', '已有生成任务进行中，请稍候');
    active += 1;
    const body = {
      model,
      content: [{ type: 'text', text: prompt }],
      watermark: false,
      resolution: resolution || '720P',
      aspect_ratio: ratio,
    };
    if (duration) body.duration = Number(duration);
    try {
      const j = await arkFetch('/contents/generations/tasks', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
      const taskId = j?.id;
      if (!taskId) throw new ApiError('NO_TASK', '任务提交无返回 id');
      tasks.set(taskId, { status: 'running', ts: Date.now() });
      return { taskId };
    } catch (e) {
      active = Math.max(0, active - 1);
      throw e;
    }
  }

  /** 查询视频任务状态（前端每 3-5s 轮询） */
  async function queryTask(taskId) {
    const t = tasks.get(taskId);
    if (!t) return { status: 'not_found' };
    if (t.status !== 'running') return t; // done/error 直接返回缓存结果
    try {
      const j = await arkFetch(`/contents/generations/tasks/${taskId}`, { headers: headers() });
      const st = j?.status || '';
      if (st === 'succeeded') {
        const url = extractVideoUrl(j);
        let mediaId = null;
        if (url) mediaId = await downloadToMedia(url, 'mp4');
        t.status = 'done';
        t.mediaId = mediaId;
        t.ts = Date.now();
        active = Math.max(0, active - 1);
      } else if (st === 'failed' || st === 'cancelled') {
        t.status = 'error';
        t.error = j?.error?.message || `生成${st}`;
        t.ts = Date.now();
        active = Math.max(0, active - 1);
      }
    } catch (e) {
      t.error = e.message;
    }
    return t;
  }

  // ---- 下载视频（可选转录）----
  async function download({ url, transcribe }) {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      throw new ApiError('INVALID_URL', '链接格式不对，请粘贴完整视频链接');
    }
    if (downloadBlacklist.some((d) => host === d || host.endsWith(`.${d}`))) {
      throw new ApiError('BLOCKED', `域名被限制下载：${host}`);
    }
    const mediaId = await downloadToMedia(url, 'mp4');
    let transcript;
    if (transcribe) {
      if (!transcribeEnabled) {
        throw new ApiError('TRANSCRIBE_DISABLED', '转录未开启');
      }
      const rec = getMedia(mediaId);
      const buf = fs.readFileSync(getMediaPath(rec));
      const r = await transcribeAudio(buf); // faster-whisper 直接解码音轨（PyAV 读内容不依赖扩展名）
      if (!r.ok) throw new ApiError('TRANSCRIBE_FAIL', r.error);
      transcript = r.text;
    }
    return { mediaId, transcript };
  }

  function extractVideoUrl(d) {
    const content = d?.content || {};
    if (typeof content === 'object') {
      if (content.video_url) return content.video_url;
      const v = content.videos || [];
      if (v[0]?.url) return v[0].url;
    }
    return '';
  }

  /** 前端渲染选项用：模型全列（可用性运行时判定），含比例/时长/是否配了 key */
  function getConfig() {
    return { imageModels, videoModels, imageResolutions, ratios, hasKey: !!doubaoKey, transcribeEnabled };
  }

  // 任务 TTL 清理（后台定时，防 tasks Map 无限膨胀）
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, t] of tasks) if (now - t.ts > TASK_TTL) tasks.delete(id);
  }, 5 * 60 * 1000);
  if (timer.unref) timer.unref();

  return { generateImage, generateVideo, queryTask, download, getConfig };
}
