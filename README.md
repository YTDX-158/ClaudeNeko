# ClaudeNeko 🐱

在浏览器里驱动 **Claude Code CLI** 的本地 Web 界面——带整套皮肤系统、WebGL 流体背景、**双吉祥物**（可拖动的小猫 + 会说话、能查余额的 claude娘）。

由 **仰天大笑 × 孑孓羽然** 共同开发。

## ✨ 功能

- 💬 多会话聊天，历史本地存储，续聊自动 resume；每条会话显示最近对话时间
- 🎨 **皮肤系统**：8 套主题 / 渐变 8 套 / WebGL 流体（6 滑块 + 5 预设）/ 字体颜色 / 强调色 / 一键恢复默认；设置分「外观/功能」两区
- 🐱 **小猫**：可拖动（位置记住），点击冒气泡（20 种猫咪颜文字）
- 🎎 **claude娘**：拟人挂件，点击查 DeepSeek 余额；思考中/回答中/打字时状态气泡；拖拽吸附 / 滚轮缩放 / 右键镜像（功能页开关，默认关）
- 💰 **余额查询**：DeepSeek API Key 只留后端，点 claude娘 显示实时余额
- ⌨️ **生成中可预打字**：AI 回答时输入框不禁用，可提前输入
- 📋 会话管理：双击改名 / 自动命名（首句前 15 字）/ 空会话清理 / 右上角实时模型
- ⚡ 流式输出（SSE 打字机效果）
- 🔌 保留 Claude Code 全部能力：技能、MCP、记忆系统

## 环境要求

- **Node.js 18+**
- **Claude Code CLI 已安装**
- 配置好 DeepSeek（或其他 Anthropic 兼容端点，见下）

## DeepSeek 配置（必须，一步）

在 `~/.claude/settings.json` 写入：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "你的 DeepSeek API Key",
    "ANTHROPIC_MODEL": "deepseek-v4-flash[1m]"
  }
}
```

> 想用别的模型/端点？改 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN` 即可（Anthropic 官方或其他兼容服务都能接）。模型由 Claude Code CLI 的系统默认决定，本界面不在会话里选模型。

## 安装 & 启动

```bash
npm install
npm run prod      # 构建前端 + 启动服务
# 浏览器打开 http://127.0.0.1:4000
```

开发模式：`npm run dev`（前端热更新在 5173，后端 4000）。

## 使用

1. 打开 `http://127.0.0.1:4000`
2. 左侧「＋ 新建会话」开聊
3. 右下角 ⚙ 进设置：换主题/背景/流体/透明度/颜色（外观 / 功能两区）
4. 点右下角那只猫 → 冒气泡 🐱💭；功能页打开 claude娘 → 点它查余额 🎎

## 数据与隐私

- 会话记录存本地 `server/data/`（不上传任何云端）
- 只在本机运行，**不要**把 4000 端口暴露到公网/局域网

## ⚠️ 安全警告

本服务**无鉴权**——任何能访问你 4000 端口的人都能操作你的 Claude。**仅供 localhost 本机使用**，请勿端口映射/内网穿透。

## 致谢

外观设计令牌移植自 [dsh-dream-skin](https://www.npmjs.com/package/dsh-dream-skin)（MIT），WebGL 流体引擎与玻璃质感移植自 [dsh-client-ui-aqua](https://www.npmjs.com/package/dsh-client-ui-aqua)（MIT）。DeepSeek Harness 的界面风格提供了灵感。

## License

[MIT](./LICENSE)
