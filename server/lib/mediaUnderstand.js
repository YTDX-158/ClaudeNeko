import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describeImage } from './vision.js';

/**
 * mediaUnderstand.js — 统一媒体理解（图片/视频/音频 → 文字描述）
 * 面向市场设计：
 *  - 图片：走 vision.js 视觉转述（多后端 BYOK）
 *  - 视频：python cv2 抽关键帧 → 每帧视觉转述（不依赖 FFmpeg/全模态模型）
 *  - 音频：faster-whisper 转写 → 文字（本地免费）
 *  A 通道（原生多模态直接收）预留：VISION_MODES 声明 video/audio 时后续可接，当前走 B。
 */

/** 临时目录用 ASCII 路径（OpenCV/whisper 对中文路径支持差）。 */
function asciiTmpDir() {
  return process.env.SystemRoot ? path.join(process.env.SystemRoot, 'Temp') : os.tmpdir();
}

/** 检测 python 依赖（cv2 / faster-whisper），结果缓存。 */
let depsCache = null;
function checkDep(cmd, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const py = spawn('python', ['-c', cmd], { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { try { py.kill(); } catch {} resolve(false); }, timeoutMs);
    py.stdout.on('data', (d) => (out += d));
    py.stderr.on('data', () => {});
    py.on('close', (code) => { clearTimeout(timer); resolve(code === 0 && out.trim() === 'ok'); });
    py.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}
async function checkDeps() {
  if (depsCache) return depsCache;
  const [cv2, whisper] = await Promise.all([
    checkDep("import cv2; print('ok')"),
    checkDep("import faster_whisper; print('ok')"),
  ]);
  depsCache = { cv2, whisper };
  return depsCache;
}

/** 用 python cv2 抽视频最多 3 个关键帧（开头/中间/结尾）。 */
function extractVideoFrames(videoBuf) {
  return new Promise((resolve) => {
    const tmpDir = asciiTmpDir();
    const stamp = Date.now();
    const inPath = path.join(tmpDir, `cn-vid-${stamp}.mp4`);
    try {
      fs.writeFileSync(inPath, videoBuf);
    } catch {
      resolve([]);
      return;
    }
    const script = `
import cv2, os, sys
cap = cv2.VideoCapture(r'${inPath}')
if not cap.isOpened():
    sys.exit(1)
n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
fps = cap.get(cv2.CAP_PROP_FPS) or 25
dur = n / fps if fps else 1
outs = []
for i, t in enumerate([dur*0.1, dur*0.5, dur*0.9]):
    cap.set(cv2.CAP_PROP_POS_MSEC, t*1000)
    ok, frame = cap.read()
    if ok:
        p = os.path.join(r'${tmpDir}', f'cn-frame-${stamp}-{i}.jpg')
        cv2.imwrite(p, frame)
        outs.append(p)
print('|'.join(outs))
`;
    const py = spawn('python', ['-c', script], { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => {
      try { py.kill(); } catch {}
      try { fs.unlinkSync(inPath); } catch {}
      resolve([]);
    }, 60000);
    py.stdout.on('data', (d) => (out += d));
    py.stderr.on('data', () => {});
    py.on('close', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(inPath); } catch {}
      const frames = out
        .trim()
        .split('|')
        .filter(Boolean)
        .map((p) => {
          try {
            return {
              buf: fs.readFileSync(p),
              mime: 'image/jpeg',
              cleanup: () => { try { fs.unlinkSync(p); } catch {} },
            };
          } catch { return null; }
        })
        .filter(Boolean);
      resolve(frames);
    });
    py.on('error', () => { clearTimeout(timer); try { fs.unlinkSync(inPath); } catch {} resolve([]); });
  });
}

/** faster-whisper 转写音频为文字（本地，无云端）。 */
function transcribeAudio(audioBuf) {
  return new Promise((resolve) => {
    const tmpDir = asciiTmpDir();
    const inPath = path.join(tmpDir, `cn-aud-${Date.now()}.mp3`);
    try {
      fs.writeFileSync(inPath, audioBuf);
    } catch {
      resolve({ ok: false, error: '音频写入临时文件失败' });
      return;
    }
    const script = `
from faster_whisper import WhisperModel
model = WhisperModel('small', device='cpu', compute_type='int8')
segments, _ = model.transcribe(r'${inPath}')
print(''.join(s.text for s in segments))
`;
    const py = spawn('python', ['-c', script], { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => {
      try { py.kill(); } catch {}
      try { fs.unlinkSync(inPath); } catch {}
      resolve({ ok: false, error: '转写超时（音频过大或环境慢）' });
    }, 180000);
    py.stdout.on('data', (d) => (out += d));
    py.stderr.on('data', () => {});
    py.on('close', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(inPath); } catch {}
      const t = out.trim();
      resolve(t ? { ok: true, text: t } : { ok: false, error: '转写无结果（可能无语音）' });
    });
    py.on('error', () => { clearTimeout(timer); try { fs.unlinkSync(inPath); } catch {} resolve({ ok: false, error: 'python 不可用' }); });
  });
}

/**
 * 统一媒体理解入口。
 * A 通道（VISION_MODES 声明 video/audio → 原生多模态直接收）预留，当前一律走 B。
 */
export async function describeMedia(kind, buf, mime, fileName) {
  if (kind === 'image') return describeImage(buf, mime);

  if (kind === 'video') {
    const deps = await checkDeps();
    if (!deps.cv2) {
      return { ok: false, error: '视频理解需要 python + opencv-python，请安装：pip install opencv-python' };
    }
    const frames = await extractVideoFrames(buf);
    if (!frames.length) return { ok: false, error: '视频抽帧失败（需 python+cv2）' };
    const texts = [];
    for (const f of frames.slice(0, 3)) {
      const r = await describeImage(f.buf, f.mime);
      f.cleanup?.();
      if (r.ok) texts.push(r.text);
    }
    return texts.length
      ? { ok: true, text: `[视频关键帧画面]\n${texts.join('\n---帧分隔---\n')}` }
      : { ok: false, error: '视频帧视觉描述失败' };
  }

  if (kind === 'audio') {
    const deps = await checkDeps();
    if (!deps.whisper) {
      return { ok: false, error: '音频理解需要 python + faster-whisper，请安装：pip install faster-whisper' };
    }
    return transcribeAudio(buf);
  }

  return { ok: false, error: '不支持的媒体类型' };
}
