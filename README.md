# ClaudeNeko 🐱

> 🏷 **v2.4.5** · 📦 [下载成品](https://github.com/YTDX-158/ClaudeNeko/releases) · 🐙 [仓库](https://github.com/YTDX-158/ClaudeNeko)

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

### 📱 远程访问（手机 / 公网连接）
- **设置 → 功能 → 远程访问**：开启后手机浏览器打开公网地址 + 输配对码即可用（配对一次终身免码）
- **对话变聪明**：默认在用户主目录运行；想让它像桌面 CLI 一样"认识你"（加载某目录的记忆），设环境变量 `NEKO_WORK_CWD` 指向该目录（见下方「环境变量」）
- **安全**：配对码动态生成、HttpOnly Cookie 鉴权；未配对访问只给配对页
- **移动端适配**：窄屏侧栏变抽屉，手机浏览器体验完整
- 需 `cloudflared`（未装则远程不可用，桌面本地不受影响）

### 📎 AI 读附件（文档 / 图片 / 视频 / 音频）
- **文档**：txt / pdf / docx 自动抽文字——纯文本模型也能"读"到内容
- **图片**：视觉模型把图转成文字描述喂给主模型（**设置→模型配置→视觉理解** 填 Key，豆包 / 智谱 / 千问 / OpenAI 任一兼容端点）
- **视频 / 音频**：本地抽帧 + 转写，AI 理解画面与语音（可选，需 python）
- 没配视觉 / 缺依赖 → **优雅降级**：明确提示原因，不报错不装懂

### 🎨 技能包（生图 / 生视频）
输入框下方一排技能，选中即切换输入模式：
- **生图**：选 Seedream 模型 + 比例 + 分辨率 → 输入提示词出图
- **生视频**：选 Seedance 模型 + 比例 + 时长（时长跟随所选模型）+ 分辨率 → 输入镜头描述生成视频（异步轮询）
- 生成走**豆包 / 火山方舟**（**设置→模型配置** 填 baseUrl/Key，填什么用什么，支持中转）；未开通的模型点了给明确提示
- **生成确认弹窗**（设置→功能页开关，默认开）：生成前确认一次，防误触白白消耗额度
- **生成记忆进 claude 会话**：每次生成的提示词与结果 claude 都会记住，后续对话连贯

### 🆕 v2.4 系列更新
- **模型配置面板重构**：自定义供应商、模型手输，预设含 智谱 / Kimi / MiniMax；存为档案一键切换
- **粒子小猫吉祥物同款化** + 安装器 / SFX / 桌面快捷方式图标全家桶
- **首条消息不再被吞**（预启动 + 就绪信号 + 自动重发兜底）
- **回合视图**：多段合并整组气泡 + 打字机调速 + 生成状态指示
- **远程端口自动顺延**（4001 起试）+ 真实错误回传
- **稳定化大迭代**：消息链路根治 + 内置日志系统

### 🔒 隐私与安全
- **100% 本地运行**：会话记录仅存本地，无任何云端上传
- **API Key 只留后端**：DeepSeek 密钥绝不下发前端
- **默认仅本机**：默认监听 `127.0.0.1`，不暴露公网；只有你在设置里主动开启「远程访问」才会经 cloudflared 暴露公网（配对码保护）

---

## 🚀 快速开始

### 📦 直接下载成品（推荐 · Windows）
已打包好，双击即用（免装依赖）：
- **绿色版** zip —— 解压后双击 `启动ClaudeNeko.bat`
- **安装器** exe —— 向导安装，自动建桌面快捷方式
- **SFX** exe —— 双击自解压并启动

👉 **去 [Releases 页](https://github.com/YTDX-158/ClaudeNeko/releases) 下载最新版**（v2.4.5+）

或想改代码 / 跑源码，看下方"环境要求"。

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

> 想换模型 / 端点？两种方式任选：
> - **界面内配置（推荐）**：设置 → 模型配置，选供应商 / 手输模型（预设含 DeepSeek、智谱、Kimi、MiniMax），存为档案一键切换
> - **改 settings.json**：修改 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN`，支持任意 Anthropic 兼容服务

### 视觉理解配置（可选 · 让 AI 看图）
发图片给 AI，AI 会先让**视觉模型**把图转成文字描述再理解。在 **设置 → 模型配置 → 🤖 视觉理解** 填入：
- **baseUrl**：OpenAI 兼容端点（留空 = 火山默认 `https://ark.cn-beijing.volces.com/api/v3`）
- **API Key**：豆包 / 智谱 / Qwen / OpenAI 任一视觉 Key
- **模型**：视觉模型 ID（如 `doubao-seed-2-0-mini-260428`）

> 没配视觉理解 → 发图片 AI 会礼貌说明"看不了图"，不影响其他功能。

### 生成媒体配置（可选 · 生图 / 生视频）
在 **设置 → 模型配置** 给每个预设模型填 **baseUrl**（留空 = 火山默认）+ **API Key**，**填什么生成时用什么**（支持中转 baseUrl）：
- 🖼 生图：Seedream 5.0 Lite / Pro
- 🎬 生视频：Seedance 2.5 / 2.0 Mini / 2.0 / 2.0 Fast
- 没填的模型生成时会提示去配置页填（不静默用其他 key）
- 已开通的模型能用；未开通的给明确提示（"当前 key 未开通此模型"），到火山方舟开通后即用
- 转录需 python + faster-whisper（同下面的媒体理解依赖）

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
| 技能包生图 / 生视频 | + 豆包 / 火山方舟 Key（可用视觉 Key 代替，可选） |
| 远程访问（手机 / 公网） | + cloudflared（未装则远程不可用，桌面本地不受影响） |

### 启动
```bash
npm install
npm run prod      # 构建前端 + 启动服务
# 浏览器打开 http://127.0.0.1:4000
```

Windows 用户可直接双击包内 `start-web.bat`（自动构建 + 打开浏览器）。

### 环境变量（可选）
| 变量 | 作用 |
|------|------|
| `NEKO_WORK_CWD` | claude 子进程工作目录。默认用户主目录；想让它加载某目录的记忆（如桌面 CLI 那套），指向该目录即可 |
| `CLAUDE_BIN` | claude.exe 不在默认安装路径时的绝对路径（见 server 启动报错提示） |
| `PORT` | 业务端口（默认 4000） |

> 设置方式：在 `~/.claude/settings.json` 的 `env` 里加，或直接设系统环境变量。

### 平台说明
- **桌面脚本**（`start-web.bat` / 开机自启 / `neko://` 协议）面向 **Windows**
- macOS / Linux 可用 `npm run prod` 启动；开机自启、任务计划自愈、`neko://` 协议暂不适用

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

**Q: 手机 / 其他设备能访问吗？**
A: 默认仅本机。想从手机访问：设置 → 功能 → 开启「远程访问」，会得到公网地址 + 配对码，手机浏览器打开输码即可（配对码保护，未配对只看到配对页）。需安装 `cloudflared`。

---

## 🗑 卸载

1. **停服务**：关掉浏览器页面；若有后台服务，双击 `start-server.bat` 目录下任务计划——设置 → 功能 → 关闭「开机自启」（或删任务计划 `ClaudeNekoServer`）
2. **删协议注册**（可选）：双击 `注册neko协议.bat` 里的反注册（或手动删 HKCU 注册表 `Software\Classes\neko`）
3. **删数据**（可选）：`server/data/`（会话）、`server/media/`（媒体库）、`~/.claudeneko/`（远程配对凭证）
4. **删项目目录**即可

---

## 🧱 技术栈

- **前端**：React 18 + Vite 5
- **后端**：Node.js（零依赖，直接驱动本机 Claude Code CLI）
- 完整保留 Claude Code 能力：Skills、MCP、记忆系统

## 致谢

外观设计令牌移植自 [dsh-dream-skin](https://www.npmjs.com/package/dsh-dream-skin)（MIT），WebGL 流体引擎移植自 [dsh-client-ui-aqua](https://www.npmjs.com/package/dsh-client-ui-aqua)（MIT），常驻终端（pty）与 jsonl 转录引擎移植自 [@inksnow/c2web](https://www.npmjs.com/package/@inksnow/c2web)（MIT）。

## License

[MIT](./LICENSE)
