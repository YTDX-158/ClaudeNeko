// mediaGen.js — 生成媒体服务（Seedream 生图 / Seedance 生视频 / 下载视频+转录）
// BYOK：DOUBAO_API_KEY 由 settings 注入（env 或 ~/.claude/settings.json），不硬编码；
// 模型可用性由运行时动态判定（失败=当前 key 未开通），不写死 available。
// 生成结果经 saveMedia 存入媒体库，前端用 /api/media/{id} 展示。
//
// v1.7.0 生视频「认领式兜底」：
//   - 任务从提交起由后端盯到完成自动落盘（关页/刷新/服务重启都不丢）
//   - 无固定放弃上限：火山说 running 就一直盯，只有火山明确失败才停
//   - 连续查询失败（断网/API 挂）→ 判"查询失败"（释放锁，可重新生成）
//   - running 超 6 小时强制停（防火山永不返回 → 永久 BUSY）
//   - 任务落盘 gen_tasks.json（原子写），启动时认领未完成任务
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveMedia, getMedia, getMediaPath } from './mediaStore.js';

const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const MAX_ACTIVE = 1; // 并发：同时只允许一个生成任务，防超并发烧额度

// ---- 生视频盯梢/兜底参数 ----
const WATCH_MS = 4000;             // 普通档盯梢间隔
const WATCH_MS_4K = 10000;         // 4K 盯梢放宽（生成久 + 查询限流保护）
const FAIL_LIMIT = 3;              // 连续查询失败次数 → 判"查询失败"
const MAX_RUN_MS = 6 * 60 * 60 * 1000;     // running 绝对上限：超 6h 强制停
const RECLAIM_MAX_AGE = 24 * 60 * 60 * 1000; // 启动只认领 24h 内的 running
const DONE_KEEP_MS = 10 * 60 * 1000;       // done 记录内存保留（给前端查进度）
const ERROR_KEEP_MS = 24 * 60 * 60 * 1000; // error 记录内存保留（证据+可重试窗口）
const CLEAN_MS = 5 * 60 * 1000;            // 低频清理间隔
const INSTANCE_ID = `i${process.pid}-${Date.now().toString(36)}`; // 本服务实例唯一 id

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {{ imageModels:any[], videoModels:any[], ratios:string[], imageResolutions:any[], transcribeEnabled:boolean, dataDir?:string, mediaConfig?:object, onTaskSettled?:Function }} cfg
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
  const { imageModels, videoModels, ratios, imageResolutions, transcribeEnabled, mediaConfig, onTaskSettled } = cfg;
  const tasks = new Map(); // taskId -> {status, mediaId?, error?, ts, resolution, failCount, claimedBy?, claimedAt?, lastWatchAt?}
  let active = 0;
  const dataDir = cfg.dataDir || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
  const tasksFile = path.join(dataDir, 'gen_tasks.json');

  // ---- 按模型取接入配置（预设式）：只认配置页填的 baseUrl/apiKey，没配直接抛「请去配置」----
  function resolveEndpoint(model, kind) {
    const conf = mediaConfig?.getConfig(kind, model);
    if (conf?.apiKey) return { baseUrl: conf.baseUrl || ARK_BASE, apiKey: conf.apiKey, model };
    throw new ApiError('MODEL_NOT_CONFIGURED', `模型「${model}」未配置，请到 设置→模型配置 填写 baseUrl / API key`);
  }

  async function arkFetch(path, opts) {
    // baseUrl 默认火山；apiKey 必传（生成路径 resolveEndpoint 已解析，无全局兜底）
    const baseUrl = opts?.baseUrl || ARK_BASE;
    const apiKey = opts.apiKey;
    const res = await fetch(`${baseUrl}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: opts.signal || AbortSignal.timeout(60000), // 防火山 API 挂起永久占资源
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = j?.error || {};
      throw new ApiError(e.code || `HTTP_${res.status}`, e.message || `请求失败（HTTP ${res.status}）`);
    }
    return j;
  }

  function requireKey(apiKey) {
    if (!apiKey) {
      throw new ApiError('NO_KEY', '未配置生成 key，请在设置→模型配置 填写');
    }
  }
  // 预设固定：配置里的模型必来自预设（老条目已迁移清除），按预设判断即可
  const isImageModel = (id) => imageModels.some((m) => m.id === id);
  const isVideoModel = (id) => videoModels.some((m) => m.id === id);
  const isValidRatio = (r) => ratios.includes(r);

  // ---- 任务落盘（gen_tasks.json，原子写；状态变化时调用） ----
  function persistTasks() {
    try {
      fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
      const tmp = `${tasksFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, tasks: Object.fromEntries(tasks) }, null, 2));
      fs.renameSync(tmp, tasksFile);
    } catch (e) {
      console.error('[mediaGen] 任务落盘失败:', e.message); // 写盘失败不阻塞主流程
    }
  }

  /** 启动认领：恢复 24h 内的 running 任务继续盯（重启不丢）。最多认领 1 个（并发锁 MAX_ACTIVE=1）。
   *  不做认领锁：单实例重启时旧进程必然已死，直接认领；双实例重复下载为已标注的可接受场景。 */
  function loadTasks() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    } catch {
      return; // 无文件/损坏 → 无任务可恢复
    }
    const now = Date.now();
    let claimed = 0;
    let removed = false;
    for (const [id, t] of Object.entries(data.tasks || {})) {
      if (!t || t.status !== 'running') continue; // 只认领 running（done/error 不盯）
      if (now - (t.ts || 0) > RECLAIM_MAX_AGE) {
        delete data.tasks[id]; // 超 24h 的 running 记录从文件清（防 gen_tasks.json 无界增长 L2）
        removed = true;
        continue;
      }
      if (claimed >= 1) continue; // 最多认领 1 个（并发锁 MAX_ACTIVE=1）
      t.claimedBy = INSTANCE_ID;
      t.claimedAt = now;
      t.failCount = 0;
      t.lockHeld = true; // 认领即持有并发锁（H1/H2：终态只释放一次）
      tasks.set(id, t);
      active = active + 1;
      claimed++;
      console.log(`[mediaGen] 启动认领未完成任务: ${id}（${t.model || '?'} ${t.resolution || ''}）`);
    }
    if (claimed || removed) persistTasks();
  }

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
    const ep = resolveEndpoint(model, 'image');
    requireKey(ep.apiKey);
    if (!isImageModel(model)) throw new ApiError('MODEL_UNAVAILABLE', `当前 key 未开通此模型：${model}`);
    if (!isValidRatio(ratio)) throw new ApiError('INVALID_RATIO', `比例不支持：${ratio}`);
    if (active >= MAX_ACTIVE) throw new ApiError('BUSY', '已有生成任务进行中，请稍候'); // 生图也走同一把并发锁（防堆叠烧额度）
    active += 1;
    try {
    const size = calcImageSize(ratio, resolution);
    const j = await arkFetch('/images/generations', {
      method: 'POST',
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey,
      body: JSON.stringify({ model: ep.model, prompt, size, watermark: false }),
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
    } finally {
      active = Math.max(0, active - 1);
    }
  }

  // ---- 参考图（复用附件版）：读本地媒体图 → base64 → content 按 role 排 ----
  /** 参考图参数防御 + 构造。实测确认（8-26）：2.5/2.0 都认 content+role 格式（base64 直传，无需公网 URL）。
   *  refMode：first(1图)/firstlast(2图)/ref(多图≤8)；总 base64 ≤58MB（防爆火山 64MB 请求体）。
   *  首帧模式省略 aspect_ratio（火山按首帧图自适应，不裁切）。返回图片块数组；无参考返回 null。 */
  function buildRefBlocks(refMode, refImages) {
    const MODES = ['first', 'firstlast', 'ref'];
    if (!MODES.includes(refMode) || !Array.isArray(refImages)) return null;
    let ids = refImages.filter((x) => typeof x === 'string');
    // M1：后端按 mode 限制张数（前端已截断，后端是唯一防线，防本地客户端绕过）
    if (refMode === 'first') ids = ids.slice(0, 1);
    else if (refMode === 'firstlast') ids = ids.slice(0, 2);
    else ids = ids.slice(0, 8);
    if (!ids.length) {
      // L4：明确选了参考方式但无有效图 → 报错而非静默降级纯文字（请求与结果不一致）
      throw new ApiError('REF_INVALID', '参考方式已选但未提供有效参考图');
    }
    let totalBase64 = 0;
    const blocks = [];
    for (let i = 0; i < ids.length; i++) {
      const rec = getMedia(ids[i]);
      if (!rec || rec.kind !== 'image' || !rec.fileName) {
        // L3：脏记录（缺 fileName）守卫，防 path.join 抛 TypeError → 500
        throw new ApiError('REF_INVALID', `参考图不存在或非图片：${ids[i]}`);
      }
      const buf = fs.readFileSync(getMediaPath(rec));
      const b64 = buf.toString('base64');
      totalBase64 += b64.length;
      if (totalBase64 > 58 * 1024 * 1024) {
        throw new ApiError('REF_TOO_LARGE', '参考图总大小超限（base64 约 58MB），请减少张数或换小图');
      }
      const role =
        refMode === 'first' ? 'first_frame'
        : refMode === 'firstlast' ? (i === 0 ? 'first_frame' : 'last_frame')
        : 'reference_image';
      blocks.push({ type: 'image_url', image_url: { url: `data:${rec.mime};base64,${b64}` }, role });
    }
    return blocks;
  }

  // ---- 生视频（异步任务：后端自轮询盯梢 + 前端轮询看进度）----
  async function generateVideo({ prompt, model, ratio, duration, resolution, refMode, refImages, sid }) {
    const ep = resolveEndpoint(model, 'video');
    requireKey(ep.apiKey);
    if (!isVideoModel(model)) throw new ApiError('MODEL_UNAVAILABLE', `当前 key 未开通此模型：${model}`);
    if (!isValidRatio(ratio)) throw new ApiError('INVALID_RATIO', `比例不支持：${ratio}`);
    const m = videoModels.find((x) => x.id === model);
    // 时长范围校验（Part② 滑块自由输入：档位表 durationRange，兼容旧 durations；空数组防 Infinity 绕过 L1）
    if (duration != null) {
      const ds = m.durations?.length ? m.durations : [4, 30];
      const dr = m.durationRange || { min: Math.min(...ds), max: Math.max(...ds) };
      const d = Number(duration);
      if (!Number.isFinite(d) || !Number.isInteger(d) || d < dr.min || d > dr.max) {
        throw new ApiError('INVALID_DURATION', `该模型时长需在 ${dr.min}~${dr.max}s 之间（整数秒）`);
      }
    }
    if (resolution && !m.resolutions.includes(String(resolution))) {
      throw new ApiError('INVALID_RESOLUTION', `该模型不支持分辨率 ${resolution}`);
    }
    if (active >= MAX_ACTIVE) throw new ApiError('BUSY', '已有生成任务进行中，请稍候');
    active += 1;
    const res = resolution || '720P'; // 存储口径与发送口径统一（4K 盯梢放宽判断依赖）
    const body = {
      model: ep.model,
      content: [{ type: 'text', text: prompt }],
      watermark: false,
      resolution: res,
      aspect_ratio: ratio,
    };
    if (duration != null) body.duration = Number(duration);
    let refBlocks = null;
    try {
      // 参考图（可选）：读媒体图 base64 直传；首帧/首尾帧模式省略 ratio 跟随图片比例
      // 放 try 内：buildRefBlocks 抛错（REF_INVALID/REF_TOO_LARGE）时 active 锁也要释放（实测抓到的泄漏 bug）
      refBlocks = buildRefBlocks(refMode, refImages);
      if (refBlocks) {
        body.content = [{ type: 'text', text: prompt }, ...refBlocks];
        if (refMode === 'first' || refMode === 'firstlast') delete body.aspect_ratio;
      }
      const j = await arkFetch('/contents/generations/tasks', {
        method: 'POST',
        baseUrl: ep.baseUrl,
        apiKey: ep.apiKey,
        // 参考图大请求体：超时放宽到 120s（数十 MB base64 上传要时间）
        signal: refBlocks ? AbortSignal.timeout(120000) : undefined,
        body: JSON.stringify(body),
      });
      const taskId = j?.id;
      if (!taskId) throw new ApiError('NO_TASK', '任务提交无返回 id');
      tasks.set(taskId, {
        status: 'running',
        ts: Date.now(),
        resolution: res,
        model,
        sid, // 任务归属会话（onTaskSettled 回填用）
        baseUrl: ep.baseUrl, // 查任务用提交时的 key/baseUrl（P1d：自定义条目任务不能用默认 key 查）
        apiKey: ep.apiKey,
        ratio,
        duration: duration != null ? Number(duration) : undefined,
        prompt,
        claimedBy: INSTANCE_ID,
        claimedAt: Date.now(),
        failCount: 0,
        lockHeld: true, // 并发锁由本任务持有（H1/H2：终态只释放一次）
      });
      persistTasks();
      return { taskId };
    } catch (e) {
      active = Math.max(0, active - 1);
      throw e;
    }
  }

  /** 每任务只释放一次并发锁（H1 双减 / H2 孤儿释放的守卫；cancelAll 会先把 lockHeld 置 false） */
  function releaseLock(t) {
    if (!t?.lockHeld) return;
    t.lockHeld = false;
    active = Math.max(0, active - 1);
  }

  /** 查询视频任务状态（前端轮询 + 后端盯梢共用）。
   *  H1 修复：在飞查询共享同一 Promise（t.querying）→ 前后端并发查询不会重复下载/双减。
   *  幂等：status!==running 直接返回缓存。 */
  function queryTask(taskId) {
    const t = tasks.get(taskId);
    if (!t) return Promise.resolve({ status: 'not_found' });
    if (t.querying) return t.querying; // 在飞查询共享，防并发重复下载（H1）
    t.querying = (async () => {
      if (t.status !== 'running') return t; // done/error 直接返回缓存结果
      // 绝对上限：火山永不返回时防永久 BUSY
      if (Date.now() - t.ts > MAX_RUN_MS) {
        t.status = 'error';
        t.error = '任务生成超时（超过 6 小时未完成），请重新生成';
        t.ts = Date.now();
        releaseLock(t);
        persistTasks();
        return t;
      }
      try {
        const j = await arkFetch(`/contents/generations/tasks/${taskId}`, { baseUrl: t.baseUrl, apiKey: t.apiKey });
        const st = j?.status || '';
        if (st === 'succeeded') {
          t.status = 'downloading'; // 先标记，防再次进入本分支
          const url = extractVideoUrl(j);
          if (!url) {
            // 顺手修 bug：火山说成功但没给地址 → 不能假装成功
            t.status = 'error';
            t.error = '生成成功但未返回视频地址，请重试';
            t.ts = Date.now();
            releaseLock(t);
            persistTasks();
            return t;
          }
          let mediaId = null;
          try {
            mediaId = await downloadToMedia(url, 'mp4');
          } catch (e) {
            // 生成成功但结果下载失败 → 直接判任务失败
            t.status = 'error';
            t.error = e.message;
            t.ts = Date.now();
            releaseLock(t);
            persistTasks();
            return t;
          }
          t.status = 'done';
          t.mediaId = mediaId;
          t.ts = Date.now();
          t.failCount = 0;
          releaseLock(t);
          persistTasks();
          onTaskSettled?.({ sid: t.sid, taskId, status: 'done', mediaId, model: t.model });
        } else if (st === 'failed' || st === 'cancelled') {
          t.status = 'error';
          t.error = j?.error?.message || `生成${st}`;
          t.ts = Date.now();
          releaseLock(t);
          persistTasks();
          onTaskSettled?.({ sid: t.sid, taskId, status: 'error', error: t.error, model: t.model });
        } else {
          t.failCount = 0; // 火山正常 running → 清零连续失败计数
        }
      } catch (e) {
        // 只有 404/410（任务确认消失）才判终态；429 限流等其余 4xx 走 failCount 重试（M2 修复）
        if (e instanceof ApiError && /^HTTP_(404|410)$/.test(e.code || '')) {
          t.status = 'error';
          t.error = `任务不存在或已过期（${e.code}），请重新生成`;
          t.ts = Date.now();
          releaseLock(t);
          persistTasks();
          onTaskSettled?.({ sid: t.sid, taskId, status: 'error', error: t.error, model: t.model });
          return t;
        }
        // 网络/超时类：连续失败计数，≥FAIL_LIMIT 判"查询失败"（释放锁；记录保留可重试）
        t.failCount = (t.failCount || 0) + 1;
        t.lastError = e.message;
        if (t.failCount >= FAIL_LIMIT) {
          t.status = 'error';
          t.error = `查询火山状态失败，任务可能仍在生成（可稍后重新生成）[${e.message}]`;
          t.ts = Date.now();
          releaseLock(t);
          persistTasks();
        }
      }
      return t;
    })().finally(() => {
      t.querying = null; // 清在飞标记，下次可再查
    });
    return t.querying;
  }

  // ---- 下载视频功能已移除（2026-08-27）----


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
    return { imageModels, videoModels, imageResolutions, ratios, hasKey: mediaConfig?.hasAnyKey?.() ?? false, transcribeEnabled };
  }

  /** 强制结束：清空全部生成任务并释放并发锁（并发 1，一次一个任务，清全部 = 清当前）。同步清落盘防重启复活。 */
  function cancelAll() {
    for (const t of tasks.values()) t.lockHeld = false; // H2：阻止在飞查询终态释放锁（孤儿不释放）
    tasks.clear();
    active = 0;
    persistTasks();
  }

  // ---- 后端盯梢：无论前端是否轮询，都替任务盯到完成（认领式兜底核心） ----
  const inFlight = new Set(); // 防重入：同一任务同时只有一个查询在飞
  const watchTimer = setInterval(() => {
    for (const [id, t] of [...tasks]) {
      if (t.status !== 'running') continue;
      if (inFlight.has(id)) continue; // 上一次查询还没返回（防 60s 超时叠罗汉）
      const minGap = t.resolution === '4K' ? WATCH_MS_4K : WATCH_MS; // 4K 放宽节奏
      if (Date.now() - (t.lastWatchAt || 0) < minGap) continue;
      t.lastWatchAt = Date.now();
      inFlight.add(id);
      queryTask(id).finally(() => inFlight.delete(id));
    }
  }, WATCH_MS);
  if (watchTimer.unref) watchTimer.unref();

  // ---- 低频清理：done 留 10min / error 留 24h（保护内存，不涉及放弃生成） ----
  const cleanTimer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, t] of [...tasks]) {
      if (t.status === 'done' && now - t.ts > DONE_KEEP_MS) { tasks.delete(id); changed = true; }
      else if (t.status === 'error' && now - t.ts > ERROR_KEEP_MS) { tasks.delete(id); changed = true; }
    }
    if (changed) persistTasks(); // 文件同步清理，防 gen_tasks.json 无界增长（L2）
  }, CLEAN_MS);
  if (cleanTimer.unref) cleanTimer.unref();

  // 启动认领：重启后恢复未完成任务（放在定时器之后，认领完盯梢立即接管）
  loadTasks();

  /** 是否有生成任务在跑（切换模型前检查，有则拒绝——避免 kill 打断生成） */
  function hasActive() { return active > 0; }

  return { generateImage, generateVideo, queryTask, getConfig, cancelAll, hasActive };
}
