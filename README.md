# ClaudeNeko 🐱

> 在浏览器中驱动 Claude Code CLI 的本地智能对话界面——整合深度可定制皮肤、WebGL 流体背景与双吉祥物互动，带来沉浸式的 AI 聊天体验。

**ClaudeNeko** 是一款完全本地运行、隐私安全的 AI 聊天应用。它直接驱动你本机的 **Claude Code CLI**（可接入 DeepSeek 等任意 Anthropic 兼容模型），将命令行能力带入浏览器，并完整保留技能（Skills）、MCP、记忆系统等进阶能力。

由 **仰天大笑** 与 **孑孓羽然** 共同开发。

---

## 🧭 设计原则

> **所有功能默认面向市场**：BYOK（自带 Key）、可配置、优雅降级、无个人硬编码假设——下载者换掉任何 Key / 环境都能用。

- 主模型、视觉模型、媒体理解全部**可配置**，缺什么明确提示安装，不报错不装懂
- 不写死开发者的路径 / Key / 用户名

---

## ✨ 功能亮点

### 🎎 双吉祥物互动
- **小猫**：可拖拽至任意位置（位置自动记忆），点击冒气泡
- **claude娘**：拟人学者挂件——点击即可**实时查询 DeepSeek 账户余额**；在 AI 思考、回答、你输入时分别显示对应状态气泡；支持**拖拽吸附边缘、滚轮缩放、右键镜像、松手弹性动画**

### 🎨 深度可定制外观
- 8 套主题 + 壁纸（本地上传 / URL / 8 套渐变）+ WebGL 流体背景（6 项参数调节 + 5 套预设）
- 各区域独立透明度、强调色、字体颜色、一键恢复默认
- 设置分「外观 / 功能」双分区，逻辑清晰

### 💬 高效对话体验
- 多会话管理：改名 / 自动命名 / 空会话清理 / 最近对话时间
- **生成中可预打字**：AI 回答时输入框保持可用，提前输入不浪费等待
- Markdown 完整渲染、消息复制、微信/QQ 式引用、流式打字机输出
- 多开页面自动同步，消息永不丢失

### 📎 AI 读附件（文档 / 图片 / 视频 / 音频）
- **文档**：txt / pdf / docx 自动抽文字——纯文本模型也能"读"到内容
- **图片**：视觉模型把图转成文字描述喂给主模型（**BYOK 多后端**，豆包 / 智谱 GLM / 千问 / OpenAI 任一 Key 可换）
- **视频 / 音频**：本地抽帧 + 转写，AI 理解画面与语音（可选，需 python）
- 没配视觉 / 缺依赖 → **优雅降级**：明确提示原因，不报错不装懂

### 🔒 隐私与安全
- **100% 本地运行**：会话记录仅存本地，无任何云端上传
- **API Key 只留后端**：DeepSeek 密钥绝不下发前端
- 仅监听 `127.0.0.1`，不暴露公网

---

## 🚀 快速开始

### 环境要求
- **Node.js 18+**
- **Claude Code CLI**（已安装）
- 一个 Anthropic 兼容 API Key（如 DeepSeek）

### 配置 DeepSeek（一步）
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

> 想换模型/端点？修改 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN` 即可，支持任意 Anthropic 兼容服务。模型由 Claude Code CLI 系统默认决定，界面内不另作选择。

### 视觉模型配置（可选 · 让 AI 看图）
发图片给 AI，AI 会先让**视觉模型**把图转成文字描述再理解。需配一个 **OpenAI 兼容的视觉 API**（豆包 / 智谱 GLM / 阿里 Qwen / OpenAI / Gemini 任一，看你手上有什么 Key）：

```json
{
  "env": {
    "VISION_API_KEY": "你的视觉模型 Key",
    "VISION_MODEL": "doubao-seed-2-0-mini-260428 或任意视觉模型 ID",
    "VISION_BASE_URL": "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
  }
}
```

支持**多后端回退**：可再配 `VISION_2_API_KEY` / `VISION_2_MODEL`、`VISION_3_API_KEY` / `VISION_3_MODEL`…第一个失败自动换下一个。

> 没配视觉模型 → 发图片 AI 会礼貌说明"看不了图"，不影响其他功能。

### 媒体理解依赖（可选 · 视频/音频理解）
视频/音频理解靠**本地转换**（视频抽帧 + 音频转写），需 Python 环境：

```bash
pip install opencv-python faster-whisper
```

- 没装 → 发视频/音频 AI 会**提示安装命令**
- 装了 → 视频抽关键帧转描述、音频转文字，AI 都能理解

### 功能依赖速查
| 功能 | 需要 |
|------|------|
| 文字对话 / 文档读取 | 只需 Claude Code + 主模型 Key |
| 图片给 AI 看 | + 视觉模型 Key（可选） |
| 视频/音频给 AI 理解 | + python + opencv + faster-whisper（可选） |

### 启动
```bash
npm install
npm run prod      # 构建前端 + 启动服务
# 浏览器打开 http://127.0.0.1:4000
```

Windows 用户可直接双击包内 `start-web.bat`（自动构建 + 打开浏览器）。

---

## 📖 使用指南

1. 打开 `http://127.0.0.1:4000`，新建会话开始聊天
2. 点右下角 ⚙ 进入设置，自由定制外观与功能开关
3. 点小猫冒气泡；在功能页开启 claude娘，点击即可查看实时余额

---

## ❓ 常见问题

**Q: 可以用其他模型吗？**
A: 可以。修改 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN` 即可接入任意 Anthropic 兼容服务。

**Q: 聊天记录会被上传吗？**
A: 不会。所有数据仅存本地 `server/data/`，无任何云端上传。

**Q: 为什么不能让别人访问？**
A: 本服务无鉴权，仅限本机 localhost 使用，请勿端口映射或内网穿透。

---

## 🧱 技术栈

- **前端**：React 18 + Vite 5
- **后端**：Node.js（零依赖，直接驱动本机 Claude Code CLI）
- 完整保留 Claude Code 能力：Skills、MCP、记忆系统

## 致谢

外观设计令牌移植自 [dsh-dream-skin](https://www.npmjs.com/package/dsh-dream-skin)（MIT），WebGL 流体引擎移植自 [dsh-client-ui-aqua](https://www.npmjs.com/package/dsh-client-ui-aqua)（MIT）。

## License

[MIT](./LICENSE)
