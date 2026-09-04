// server/lib/configService.js — 配置读写契约（接口 A，ClaudeNeko 侧）
// ==============================================================
// 与 ClaudeInstall scripts/lib/config.js 同契约：操作同一套 ~/.claude 配置。
// ClaudeNeko 当前用「读」（/api/env 诊断）；写功能为未来「配置面板」预留（契约完整）。
//
// 契约函数：
//   settingsPath(home) / claudeJsonPath(home)   → 目标文件路径
//   readSettings(home)                          → 读 settings.json（损坏/缺失返回 {}）
//   writeEnv(home, {baseUrl, authToken, model}) → 合并写 env（先备份）
//   setOnboarding(home)                         → 合并写 hasCompletedOnboarding
//   isConfigured(home)                          → env 有没有凭证（AUTH_TOKEN + BASE_URL）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class ConfigFileError extends Error {
  constructor(file, cause) {
    super(`配置文件 ${file} 不是有效 JSON，已拒绝保存并保留原文件`);
    this.name = 'ConfigFileError';
    this.code = 'CONFIG_JSON_INVALID';
    this.cause = cause;
  }
}

export function settingsPath(home) {
  return path.join(home || os.homedir(), '.claude', 'settings.json');
}

export function claudeJsonPath(home) {
  return path.join(home || os.homedir(), '.claude.json');
}

export function readSettings(home) {
  return readJson(settingsPath(home));
}

function readJson(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ConfigFileError(p, error);
  }
}

function rotateBackups(p) {
  for (let generation = 3; generation >= 2; generation -= 1) {
    const previous = `${p}.bak.${generation - 1}`;
    if (fs.existsSync(previous)) fs.copyFileSync(previous, `${p}.bak.${generation}`);
  }
  fs.copyFileSync(p, `${p}.bak.1`);
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const serialized = JSON.stringify(obj, null, 2);
  if (fs.existsSync(p)) {
    // 写入前再次验证主文件，避免读取与保存之间文件被损坏后仍遭覆盖。
    readJson(p);
    rotateBackups(p);
  }
  const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, serialized, 'utf-8');
    fs.renameSync(tmp, p);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 精确临时文件清理失败不遮蔽原错误 */ }
    throw error;
  }
}

export function writeEnv(home, { baseUrl, authToken, model }) {
  const p = settingsPath(home);
  const cfg = readJson(p);
  cfg.env = cfg.env || {};
  if (baseUrl) cfg.env.ANTHROPIC_BASE_URL = baseUrl;
  if (authToken) cfg.env.ANTHROPIC_AUTH_TOKEN = authToken;
  if (model) {
    cfg.env.ANTHROPIC_MODEL = model;
    cfg.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    cfg.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    cfg.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    // *_MODEL_NAME 系列也统一写：claude 实际调用优先认 NAME，历史残留旧模型名会覆盖 MODEL（实测：配置 pro 实际跑 flash）
    cfg.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = model;
    cfg.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = model;
    cfg.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = model;
  }
  writeJson(p, cfg);
  return p;
}

export function setOnboarding(home) {
  const p = claudeJsonPath(home);
  const cfg = readJson(p);
  cfg.hasCompletedOnboarding = true;
  writeJson(p, cfg);
  return p;
}

export function isConfigured(home) {
  const env = readSettings(home).env || {};
  return Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY)
    && Boolean(env.ANTHROPIC_BASE_URL);
}
