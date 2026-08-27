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

export function settingsPath(home) {
  return path.join(home || os.homedir(), '.claude', 'settings.json');
}

export function claudeJsonPath(home) {
  return path.join(home || os.homedir(), '.claude.json');
}

export function readSettings(home) {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(home), 'utf-8'));
  } catch {
    return {};
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function writeJson(p, obj) {
  // 合并写入，先备份（与 ClaudeInstall 一致）
  if (fs.existsSync(p)) {
    const bak = p + '.bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(p, bak);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
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
