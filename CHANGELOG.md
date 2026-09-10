# 更新日志

## v2.4.15（2026-09-10 · 下载链接换成国内网盘）
> 缺 Claude Code 时的引导弹窗 / 报错里的下载链接，从 GitHub 换成**蓝奏云网盘**（国内直连、免登录下载），并写明下载密码。

### 🔗 下载渠道国内化
- `launcher.vbs` 弹窗：下载链接 → 蓝奏云，补一行「下载密码：YTDX666」
- `server/lib/settings.js`：报错里的下载链接同步换成网盘

## v2.4.14（2026-09-10 · 新增：缺 Claude Code 时的友好引导）
> 没装 Claude Code 的用户，以前双击 ClaudeNeko 会「毫无反应」（后台报错只写进日志）；现在会明确弹窗告诉你缺什么、去哪装。

### 🆕 启动前检测 + 引导
- `launcher.vbs`：启动前检测 claude（`CLAUDE_BIN` / npm 全局路径 / npm bin shim），缺失则弹窗提示并一键打开下载页（ClaudeInstall）
- `server/lib/settings.js`：找不到 claude.exe 的报错改为可操作指引（附下载链接），不再只说「设置环境变量 CLAUDE_BIN」

## v2.4.13（2026-09-08 · 紧急修复：安装器依赖缓存损坏）
> 修复安装后一启动就崩的问题——打包缓存里 node_modules 缺 package.json，导致 jimp 图片库入口解析失败。

### 🔧 依赖缓存根治
- 根因：打包脚本的依赖缓存"只查目录存在、不查完整性"，一次装坏的缓存被反复复用，打包出的安装器 node_modules 缺 package.json → 朋友安装后 `jimp` 解析崩溃
- 修复：缓存命中前强制校验关键包（jimp/node-pty/ws）的 package.json 存在，损坏即自动重装
- 重新打包并验证安装器依赖完整

## v2.4.12（2026-09-08 · 修复：远程配对失效 + 进程改名）
> 修好一个远程配对的硬伤：手机/朋友连远程时卡在"配对页面已失效"永远配对不上；
> 另外让 ClaudeNeko 进程在任务管理器里带上自己的名字，不再淹没在一堆 node.exe 里。

### 🔗 远程配对修复（关键）
- 根因：浏览器自动请求网页图标时，把配对页的一次性校验码悄悄顶掉 → 点配对永远报"页面已失效"
- 修复：配对页只认"真人打开的页面"，图标等无关请求不再干扰；配对手续恢复顺畅

### 🏷 进程一眼可辨
- ClaudeNeko 进程在任务管理器里显示为 `ClaudeNekoNode.exe`，跟其他 node.exe 区分开，关闭/排查不再靠猜

## v2.4.11（2026-09-08 · 中风险修复：消息身份 / 计费保护 / 配置时序 / 打包防泄漏）
> 继续清审查报告第二批：修复消息重复文本被吞、生图生视频"记录丢了钱照烧"、
> 切模型瞬间撞任务、新会话显示旧模型名、绿色包打包本机私密文件五处隐患。

### 💬 消息不再被吞（N-04）
- 连续发两条一模一样的消息，第二条不再被当成重复悄悄吃掉——前后端消息改认稳定 id 而非文字

### 💰 生图生视频更稳（N-05）
- 提示词必须保存成功才开始生成：记录没存上 → 明确提示、不生成不扣费（原会静默烧钱）

### 🔁 切模型更安全（N-06）
- 切换模型/应用档案的"忙闲检查"不再留 30 秒空窗，不会误杀正好启动的新任务

### 🏷 模型标注实时（N-08）
- 切换模型后新建/列表会话立即显示新模型，不再等重启（原来显示的是服务器启动时的旧值）

### 🔒 打包不泄漏（N-10）
- 绿色包装包时剔除本机私密配置（.build_local.env/.env）与缓存文件（__pycache__/*.pyc），双层保险

## v2.4.10（2026-09-08 · 安全加固版：三个高危防线）
> 堵住三个高危口子：恶意网页偷读本机数据、超大消息灌进终端、慢客户端吃满内存。
> 依据外部代码审查报告 N-01~03 修复，144 项测试全过。

### 🛡 只认本机访问（N-01 · 防 DNS rebinding）
- 请求最前面校验访问地址必须是 `127.0.0.1` / `localhost`——防恶意网页把域名解析到本机后偷读聊天记录
- 网页终端连接（WebSocket）同样加这道校验；远程经转发不受影响，本地 curl/脚本照常用

### 📏 终端消息上限（N-02）
- 单条消息超 1MB 直接断开，不再 100MB 照单全收
- 聊天/终端输入校验类型和长度，非法内容不再直送终端程序

### 🚦 终端显示不再吃满内存（N-03 · 背压）
- 屏幕刷太快、客户端（尤其手机远程）读不过来时自动丢中间帧，等它缓过来补一帧完整画面——画面不花、内存不爆
- 彻底读不动才断开，不再无限积压

## v2.4.9（2026-09-08 · 权限体系完善版 + 外观修复）
> 把"权限审批"从头到尾加固了一遍：卡片不再丢、消息不再重复、权限不再掉进原生终端；
> 远程配对设备只能逐次审批、改不了权限策略；外观里"清壁纸"和"恢复默认外观"两个毛病也修好了。
> 本版由隔离工作树（GPT/Codex 复核修复）+ 主开发端回归验证后发布。

### 🔐 权限审批（核心）
- **会话身份稳定绑定**：新会话预留固定身份，彻底根治"权限卡不弹/消息重复/权限落原生终端"——跨刷新、切会话、断线重连卡片都能恢复
- **审批卡更可靠**：点允许/拒绝网络失败可重试、点"停止"会取消该会话未决请求并收卡、不会误删用户已有的 hook 配置
- **"以后都行"更精确**：只记完整 Bash 命令或完整文件路径，绝不放大成整类授权；超长命令只逐次审批、不能存长期规则
- **状态有界**：未决请求 15 分钟自动过期、全局/单会话数量上限，不长期保存敏感输入

### 🔒 远程更安全
- 配对设备只能"允许一次 / 拒绝"，不能改权限模式、不能读改规则、不能切免确认
- 阻断伪造权限请求通道（含 DNS/编码变体绕过）

### 🎨 外观修复
- **点"清除"清壁纸后回到默认流体背景**（之前会把流体背景藏起来变成"裸底"）
- **"恢复默认外观"每次都能可靠重置**（修了一个会漏删设置的隐藏 bug，之前偶尔会残留一个设置导致恢复默认失效）

## v2.4.8（2026-09-05 · 安装器大升级：可选位置 + 运行拦截 + 换目录数据迁移）
> 面向小白把安装体验补完整：安装位置可选、装前自动关闭运行中的实例、所选目录可写校验、**更换安装目录时自动迁移聊天记录和媒体库**。
> 换安装位置提示：想换目录，直接用本安装器选新位置即可（会提示迁移旧数据）；或先卸载旧版再装。

### 📍 安装器（v2.4.7 起 + 本版补齐）
- **选择安装位置**：向导强制显示目录页（此前 Inno 默认 auto 会在覆盖安装时吞目录页 → 朋友反馈"不能选位置"）
- **装前自动关闭运行中的 ClaudeNeko**：检测 4000 端口占用 → 询问后自动安全关闭再继续（避免文件占用装一半失败）
- **目录可写校验**：选了需要管理员的位置（如 Program Files）会提示换普通文件夹
- **换目录自动迁移数据**：装到新位置时勾选"迁移旧数据"，自动把旧 `server\data`（聊天记录）+ `server\media`（媒体库）复制到新目录；旧目录保留待确认后可手动删
- **自启计划任务重指向**：换目录后清除指向旧路径的旧自启任务

## v2.4.7（2026-09-05 · 安装器可选安装位置）
> 修复面向小白的关键体验：安装器现在**强制显示"选择安装位置"页**（此前 Inno 默认 auto 会在覆盖安装等场景吞掉目录页，朋友反馈"不能自选安装位置"）。桌面快捷方式 + 可卸载不变，全中文向导不变。

## v2.4.6（2026-09-04 · 更新自动提示 + 台账可复制 + 黑猫欢迎区）
> 三个体验增量：版本更新自动检测弹框（ClaudeNeko 第一个"自己提醒自己"的功能）+ 台账提示词可复制 + 空会话透明黑猫欢迎区。

### 📦 版本更新自动检测 + 弹框（新功能）
- 打开应用**自动查** GitHub releases/latest（本机访问才查，手机远程不弹），有新版弹框提示：显示新版更新说明 + [去下载]（跳 GitHub Releases）/ [知道了] / [稍后再说]
- 防烦设计：同版本只弹一次 · "稍后再说"24h 内不弹 · 24h 限频查 GitHub · 网络失败全静默 · 4s 超时
- 安全：更新说明纯文本渲染防注入 · 下载地址硬编码不信任远端 · localStorage `neko_no_update=1` 可彻底关（开发期）
- 版本号数字段比较（v2.4.10 > v2.4.9 正确）

### 📋 媒体库台账：提示词可复制
- 台账"提示词"列 hover 浮出 📋 复制按钮，点一下整条复制 + "已复制"反馈
- 点击提示词文字弹全文小窗（可选中 + 带复制按钮），长 prompt 查看不裁断

### 🐱 空会话欢迎区：透明黑猫图标
- 原来 44px 渐变空色块 → 换成透明背景黑猫本体（1024 素材裁边·56px·香草色光晕，深色皮肤也清晰）

## v2.4.5（2026-09-04 · 外审两轮安全修复合并：10 项凭据/远程/持久化加固）
> 给 ChatGPT/Codex 外审 65 项，两轮修复全部合并（首轮 4 项 + 二轮 6 项）。Claude 反方审查 + 亲验：node --test 41/41 过、build 过。合并含 proxy.js 冲突解决（两轮阻断语义并合，/api/balance 保留）。commit 见 git log（3e0001d 合并）。

### 🔒 凭据不外泄
- **04-01 余额查询不再把别的供应商 key 发给 DeepSeek**：只认专用 `DEEPSEEK_API_KEY`，兜底需校验 `ANTHROPIC_BASE_URL` hostname 确为 api.deepseek.com；`/api/balance` 仅本机可用
- **02-02 视频任务查询不再泄露 apiKey**：查询响应改白名单 DTO（只回 status/mediaId/error/ts），内部任务对象不下发
- **02-11 媒体任务凭据不再落盘**：`gen_tasks.json` 改恢复队列（仅 running + 6 个安全字段），凭据启动时从当前配置现取；终态任务立即出盘；远未来/非法记录启动即清

### 🛡️ 远程安全
- **03-01 反斜杠绕过根治**：高危路径拦截与业务端统一 WHATWG URL 规范化，`/api/x/..\force-stop` 一类不再穿透
- **03-04 本机日志远程读不到**：`/api/log`(+download) 进远程阻断表，点段/编码点段路径（`..`/`%2e%2e`）绕过全堵
- **03-02 换码/关远程立即踢掉已连手机**：代理侧 socket registry 幂等断开；远程与本机 WS 区分，桌面本地不误伤
- **03-08 配对页防跨站锁死**：一次性 nonce + Origin/Host 同源校验 + 双层限流（每来源 5 次/分 + 全局 50 次/分），锁在读取请求体前判定，跨站/超大请求不计猜测

### 📦 数据与配置保护
- **04-02 损坏的 settings.json 不再被空配置覆盖**：损坏即拒绝保存(409)并保留原文件；写入前二次验证 + 原子写；`.bak.1~3` 三份轮换备份
- **04-06 "导出全部"不再静默出半个备份**：超 200 会话 / 超 500MB 整体拒绝(413)；成功带完整性标记，客户端未确认完整不下载
- **05-01-B 媒体库台账页真显示**：MediaLedger 组件展示 `media_gen_log.json` 真实记录（时间/类型/模型/结果/文件），清空记录不删文件

## v2.4.4（2026-09-03 · 模型配置面板重构：自定义供应商/模型 + 候选互斥）
> 对话模型配置「自定义」死锁根治：模型名/供应商名都可自由手输（预设只是候选），切换串台修复，预设扩充三家国产（智谱/Kimi/MiniMax），服务端域名识别同步。commit 见 git log。

### 🐛 对话模型配置根治（原"自定义不能真自定义"）
- **手输死锁修复**：原下拉「✏️ 自定义…」点选即清空模型名，而手输框显示又要求名字非空 → 永填不进。重构为**输入框 + 自画候选下拉**（datalist 弃用，浏览器事件不可控/候选被遮挡），可自由手输任意名或点候选即填
- **切换串台修复**：换供应商时 baseUrl 只在"有预设"才填、无预设（豆包/自定义）**清空**（原逻辑残留上一家地址）；模型名永不自动填，交用户填/选
- **进面板全空**：供应商不再默认 DeepSeek，下拉第一项"— 请选择供应商 —"，全空手填即自定义
- **候选列表互斥**：供应商 ↔ 模型候选列表同时只开一个（开 A 自动关 B），防叠加遮挡
- **提交 trim**：模型名手输统一去首尾空格再提交（防 API 404）

### ✨ 预设扩充 + 识别
- 供应商预设新增**智谱 GLM**（glm-5.2/glm-5-turbo）、**Kimi**（kimi-k3/kimi-k2.6）、**MiniMax**（MiniMax-M3[1m]/M2.7），点选自动带 baseUrl + 模型候选
- `envReport.js` 域名表扩到 6 家（含 zhipu/kimi/minimax），"当前生效"卡片正确显示中文名（前端 id→label 映射）
- 删除"自定义"冗余列表项（供应商可自由手输，无需专门选项）

## v2.4.3（2026-09-03 · 稳定化大迭代：消息链路根治 + 日志系统 + 界面增强）
> 9-03 排查闭环（分块注入 T1200/2500 实测）：消息重复/截断/串会话从根修复；自建日志系统；界面增强。今日全部改动 commit f1752af。

### 🐛 消息链路根治（9-03 排查闭环）
- **交叉错绑根治**：transcript 从"猜最新 jsonl"改为**提交文本指纹绑定**（无指纹不探测、候选尾部含本会话消息才绑）——多会话各认各的记录，杜绝串会话/重复（store 实证曾 A↔B 交叉错绑）
- **ts=NaN 修复**：jsonl timestamp 实测是 ISO 字符串，旧 `*1000` 得 NaN → `parseTs` 正确解析
- **长文本注入截断根治**：实证 ConPTY 单次写 >~1024 字符丢前段（T1200 丢前 1024、只剩尾部 176）→ `ptyHost` 分块写入（800/块 + 延迟）+ per-rec 写队列串行；"截断→确认失配→连发 3 次""系统记录提示词残段"同源全解
- **A+B 气泡收敛**：系统记录回读独立落 isSystem（认领防误）+ claude 短确认判定放宽 + 前端折叠 claude 对系统记录的话痨回复——生成一趟聊天页只剩「请求 + 结果」（不再散"已记录/收到…"）
- **发送失败文案去误导**：确认超时改"已发出处理中"，不再"发送失败请重试"诱导堆积

### 📋 日志系统（自建 ~100 行，非第三方库）
- `logger.js`：本地时间戳(带时区)/级别 `LOG_LEVEL` 过滤/10MB 轮转保留 3 份/敏感字段屏蔽/Error 打 stack
- 全 server console(37 处) 迁移 + 崩溃钩子（uncaughtException→ERROR+exit）；claudeRunner 并入统一写者
- 设置页**日志面板**：`/api/log` 尾部读取 + download(合并归档) + **按天视觉分段** + 复制/自动刷新——排雷闭环（朋友一键复制发作者）

### 🎨 界面增强
- 设置页底部：ClaudeNeko 版本号（后端自动读，随升版自动变）+ 共同开发署名
- CatMascot memo + 粒子 useMemo（性能对齐 claude娘）
- 视频模型排序：Seedance 2.0 Mini / 2.0 Fast / 2.0 / 2.5

---

## v2.4.2（2026-09-02 · 远程修复：QQ 占 4001 冲突 → 端口自动顺延）
> 朋友真机复现"点开启远程弹窗报错"——不是 cloudflared 没装（包里明明带了），是 **QQ 固定占用 4001** 撞了写死的代理端口。

### 🐛 远程代理端口与 QQ 冲突（朋友真机复现）
- **根因**：远程代理端口写死 `4001`，而 **QQ（QQNT）固定监听 4001**（9-02 实测 QQ 占 4001/4301/4310/5283/9210）→ 任何装了 QQ 且 QQ 在跑的机器，开远程必失败 → 弹窗报错
- **误导文案**：失败提示写死"可能 cloudflared 未装"，把端口冲突完全掩盖（cloudflared 是出站连接、根本不监听 4001）
- **修复**：`server/lib/remote/index.js` 代理端口**自动顺延**——从 4001 起逐个试空闲端口（到 4050），cloudflared 指向实际用到的那个；QQ 开不开都不影响
- **文案修正**：`routes/remote.js` 失败时把**真实原因**带回前端；`SkinSettings.jsx` alert 改显示真实错误（如"4001~4050 全被占用"），删"可能 cloudflared 未装"
- **验证**：本机 4001 被 QQ 占用的状态下可直接开远程（顺延到 4002）

---

## v2.4.1（2026-09-02 · 粒子小猫吉祥物同款化）
> 界面粒子小猫挂件：手画 SVG 简笔猫 → **图标同款高清粒子小猫 PNG**（品牌三统一：图标 = 挂件 = favicon）

### 🎨 吉祥物换装（只换小猫，claude娘 不动）
- **素材链路**：`assets/图标素材/ClaudeNeko_black_cat_transparent_1024.png` → PIL 按 alpha 裁掉四周 150–260px 留白 + 瘦身 → `web/src/assets/cat-mascot-particle.png`（248×300 @2x · 57.9KB）
- **CatMascot.jsx**：SVG 简笔猫代码**删净** → `<img>`（draggable={false} + CSS 禁原生拖图，防和指针拖拽打架）；显示 62×75；拖拽/点击气泡/背景 12 粒子/skinEngine 开关全保留
- **styles.css**：`.cat-mascot-img` 显示规则 + 光晕黑色阴影 → **香草色双层 drop-shadow**（vanilla 原味图背景绿 #CBD5CD 采样，不发青）；**猫本体 opacity 0.65 → 0.85**（高清黑猫更实），hover 同步抬 **0.95**（防基线超过 hover 导致悬停变淡）
- **冒烟**（playwright DOM 断言）：img 渲染 62×75 ✅ · SVG 残留 0 ✅ · 点击冒颜文字气泡 ✅ · 拖拽移动正常 ✅

---

## v2.4.0（2026-09-02 · 正式升版）
> 收编 9-02 全部增量（模型配置按钮重构 / 首条消息被吞修复 / 图标美化接入粒子小猫）+ 升版重新打包

### 🎨 图标美化（粒子小猫）
- GPT 出的粒子小猫 4 图 → `assets/图标素材/`
- 多尺寸 .ico（16~256）· 安装器全家桶（SetupIcon 安装包图标/卸载图标/向导大图 164×314/向导小图 55×58/快捷方式图标）
- SFX 自定义图标：Resource Hacker 改 7z.sfx → 固化 `assets/图标素材/7z_neko.sfx`（sfx-pack.py 自动优先用）
- favicon 升级（ico + 32px + 64px PNG，web/public + index.html 引用）
- 桌面快捷方式 `ClaudeNeko.lnk`（粒子小猫图标）
- commit 22a283f

### 🔧 模型配置按钮重构（详见下方增量节）
### 🐛 首条消息被吞修复（详见下方增量节）

---

## 9-02 增量（未升版·首条消息被吞修复：预启动 + bracket 就绪 + 确认送达）

### 🐛 新会话第一条消息发送失败（9-01 朋友真机复现，9-02 根因+修复）
- **根因（日志实锤）**：claude 冷启动极慢（jsonl 40s 才建），旧就绪判据「输出安静 800ms」/「20s 兜底」在 jsonl 创建**之前**误判就绪 → 首条消息补发进未就绪的 claude（ConPTY 早期吞输入）→ 消息丢失 → 无重试 → 永久卡"思考中"。停止后重发才成功。
- **三层修复**：
  1. **预启动**：切会话 → `POST /sessions/:id/prewarm` 提前拉起 claude pty，发消息时已就绪（不等 20-40s 冷启动）
  2. **就绪主信号升级**：检测 claude bracketed-paste 标记 `ESC[?2004h`（取证：746ms 发出，输入框 820ms，差 74ms）→ settle 200ms 就绪。比「输出安静」可靠（终端协议不随版本漂移）、比 jsonl 探测快
  3. **确认送达 + 重发兜底**：submit 注册 pendingConfirm → 6s 内 transcript 在 jsonl 读到该文本 = 真送达；没读到 → 重发（最多 2 次，claude 已就绪时重发成功率高）→ 耗尽报错（释放 busy + 前端"思考中"换"发送失败请重试"）
- **配套**：cancel/force-stop 清 pendingConfirm（用户停止不再重发）；媒体记忆【系统记录】noConfirm（防重复注入）；resume 历史回放不误确认（时序 + ts 双保险）
- **验证**：预启动 ✅ · marker 就绪 ✅ · 消息送达（jsonl 含 user+assistant 回复）✅ · 旧判据 40s 吞消息 vs 新判据直接送达

## 9-02 增量（未升版·模型配置按钮重构 + 未配置开箱提示）

### 🔧 对话模型配置页按钮重构
- **删「保存并应用」** → 拆成两个清晰入口：
  - **💾 存为档案并应用**（原子一个请求：存档 + 写 env + 标记 current + 重启 pty）
  - **📚 存为档案**（只存不应用，以后到档案列表点「应用」切换）
- **新增「📚 将当前生效配置存为档案」**：卡片区一键把正在生效的 cli 配置存成档案（不用重填表单）
- 存前查重：同名档案 confirm 覆盖
- `onModelChanged` 只在真正生效时刷新右上角模型显示

### 💡 开箱提示（未配置对话模型）
- 检测到 `~/.claude` 未配置对话模型 → 顶栏提示"请先到 设置→模型配置 填写"，带「去配置」快捷按钮
- **引导不硬拦**：OAuth 登录用户（settings 空但 claude 可用）不受影响，提示可忽略
- 配置生效后（onModelChanged）提示自动消失

### ⚙️ 后端新增端点
- `POST /api/config/profiles/save-current`：当前生效配置存为档案（只存档不重启）
- `POST /api/config/profiles/save-apply`：存档案并应用（原子，含 busy 检测）
- 前端 `api.setConfig`（旧保存并应用）移除；后端 `PUT /api/config` 保留兼容

## 9-01 增量（未升版·四层交付体系 + 远程修复）

### 🐛 远程修复：绿色包内置 cloudflared
- **根因**：cloudflared 只有本机装过（PATH），绿色包/安装器没带 → 他机远程报"未获取到公网地址，可能 cloudflared 未装"
- **修复**：`bin/cloudflared.exe` 内置（54M 单文件无依赖）+ `tunnel.js` 先内置后 PATH + green-pack 打包带 bin
- **实测**：内置 cloudflared 拿到 trycloudflare 公网 URL（远程可用）

### 📦 四层交付体系
- 源码包 zip / 绿色包 zip / SFX 自解压 exe / **中文安装器 exe**（Inno Setup 6·ChineseSimplified.isl 全中文向导·桌面快捷方式·端口检测提示·免管理员）
- 自动归档：打包 → 桌面待处理（发人）+ 项目 `交付物\`（D盘家底）双份
- 历史版本源码包 → `004_归档\ClaudeNeko历史备份\`（回滚用）

## v2.3.1（2026-08-31）—— 外观默认修复 + 海洋流体背景 🎨

### 🐛 修复：出厂外观默认从未生效（关键 bug）
- **根因**：`init()` 判断"是否有外观设置"时，把猫咪/claude娘功能键（`dsw-dream-skin:cat-pos` / `niang-*`）误判为外观设置 → 出厂默认永不注入 → 界面长期处于"跟随系统"残缺态（深色底 / 无背景 / 透明度兜底）
- **修复**：`init()` 判断排除功能键（与 `resetAll` 同判据）→ 仅设过功能键时也能正确注入出厂默认
- 效果：界面恢复正常出厂外观（mist 主题 + 原透明度参数，参数全部未动）

### 🎨 背景：默认改为海洋流体
- 出厂默认壁纸从"外链随机图 picsum.photos"（实测 503 不可达，外链图源不可靠）改为 **海洋流体**（WebGL 本地渲染，零外网依赖）
- 设置面板移除"随机风景图 / 固定狗图"两个外链快捷按钮

## v2.3.0（2026-08-30）—— 回合视图重构：多段回复合并 + 打字机调速 + 生成指示 ✨

### 🎨 回合视图（多段回复合成一个气泡）
- **回合分组**：claude 一次回复因工具调用被拆成多条 assistant 记录 → 渲染层按"中间无用户消息"合并为一段，不再碎成 N 条气泡
- **整组一个气泡**：过程段灰字弱化（每段思考折叠保留、可展开看当时推理）+ 最终答案完整突出 + 组级按钮（复制=整组拼接 / 引用=最终答案 / 分支=从最终答案）
- ⚠ 数据层/后端/store 一行不动，纯渲染层展示策略（历史会话天然正确、成本统计不漏账、可回滚）

### ⌨️ 打字机体验
- **时序修复**：3s 轮询兜底拉进的新消息也标 replay（与 WS 一致）——最终答案可靠触发打字机（修复"只有第一条打字机、后续直接出"）
- **调速**：100 字/秒基准，>800 字自动加速 300 字/秒（短答案有打字感、长答案不煎熬），渲染封顶 ≤200 tick 不卡
- **去掉跳过按钮**：速度有界，无需手动跳过

### ⏳ 生成状态指示
- **占位气泡**："思考中…" 呼吸动画（AI 回复前明确告知，替代干闪的 |）
- **底部胶囊**："⏳ 正在生成" + 三点依次跳动（回合段间不静默，解决"以为卡了其实在想"）
- **回合结束信号驱动**：transcript 提取 `message.stop_reason`（end_turn/stop_sequence/stop）→ 事件标 `turnEnd` → 前端收到立即熄灭胶囊。**替代"无活动超时"启发式**：claude 思考再久（>12s/>30s）都不闪，答完瞬间精准消失；error/force-stop/切会话/发送失败 显式兜底

## v2.2.0（2026-08-29）—— 终端稳定性大修：单色+c 根治 🛡️

### 🐛 终端单色+c 根治（三层方案）
- **真根因锁定**：claude Ink 在窄列（<50）渲染崩溃 → 手机 attach 窄列只输出"C" → 前端回放即单色背景+c（进程活着但画面没画出，宽列 resize 可唤醒，实测 attach 80 列秒恢复）
- **源头**：ptyHost resize 下钳 `MIN_COLS=50`（手机窄列钳到安全宽度，不再崩）
- **快恢复**：attach 后 3s 查 termBuf<200B → 宽列 80 resize 唤醒（秒级，不杀进程不丢状态）
- **兜底**：30s 周期查 termBuf → kill 自动重启（覆盖任意时刻死锁）
- 前端 `ensureFitReady` / `doResize` 列宽就绪检查（防发 1~3 列错误尺寸）
- onExit 身份检查（防重启竞态误删新进程）

### 🐛 修复（其他）
- **force-stop 并发写防护**：kill 同步轮询确认旧 claude 进程退出后再放行新 pty（防新旧并发写同 jsonl 损坏）——全项目审查剩余项清零
- **claude娘 手机拖拽**：`touch-action: none`（浏览器不再抢触摸手势，拖动不再被掐断成一点点）
- **终端滚动对齐**：`.xterm-viewport` 显式声明可滚动容器（微信 WebView 识别滚动，滚内容→到头才传外层，与聊天页手感一致）

### 🛠️ 工具
- 新增 `scripts/grab_termbuf.mjs`：终端 termBuf 取证工具（定位单色+c 根因立大功）

### 📦 封装
- commit `89e4b20` · zip `ClaudeNeko_v2.2.0_20260829.zip`

---

## v2.1.1（2026-08-29）—— claude娘 性能优化 + 代码拆分 🚀

### 🆕 优化
- **claude娘 手机卡顿修复**：图片 1026px/661KB → 320px/94KB（降 86%）· 拖拽简单化（去吸附/Q弹/DOM 直改 left-top，同小猫）· `memo` + status 节流（打字中气泡不闪）· resize clamp（窗口缩小拉回视口）
- **代码拆分**：终端(xterm)/设置/媒体库 `React.lazy` 懒加载 → 首屏主包 701KB → **389KB（降 44%）**
- **窄屏 header**：隐藏导出/id/⛔文字，模型 CSS 截断（hover 看全名，通用不猜前缀）

### 🐛 修复
- `chat-sid` 桌面样式缺失（id 按钮底座恢复，共用 chat-model）
- lazy 缺 ErrorBoundary（chunk 加载失败白屏）→ 新增 ErrorBoundary 兜底
- 死样式清理（`session-item-model` / `claude-q-pop`）
- 颜文字数组共享（`utils/kaomoji.js`，猫 + claude娘 统一维护）

### 📦 封装
- commit `33a6d81` · zip `ClaudeNeko_v2.1.1_20260829.zip`（117 文件 2.3MB）

---

## v2.1.0（2026-08-28）—— 模型配置预设化 + 生成记忆进 claude 会话 🧠⚙️

### 🆕 新增
- **模型配置页预设化**：生图/生视频改为固定预设清单（Seedream×2 + Seedance×4），每项填 baseUrl/key，填什么用什么（支持中转）；新增第四 tab「🤖 视觉理解」独立配置（baseUrl + key + model）
- **生成记忆进 claude 会话**：生成前把「【系统记录】命令」经 pty 提交给 claude，生成后回填结果 → claude 记住每次生成（对话连贯）；独立确认句进程退役
- **生成确认弹窗**（设置→功能页开关，默认开）：生成前确认一次，防误触白白消耗 API 额度

### 🐛 修复
- 图片显示两次（media-message 落盘 id 与前端占位对齐去重）
- 用户消息重复（命令进 claude 后不再双 append）
- 系统记录 / 确认回复刷屏（isSystem 标记 + 渲染过滤；只滤"已记录"类，不误伤正常回复）
- 恢复默认分流：外观 / 功能分开管辖，模型配置页无恢复按钮

### 🧹 清理
- 独立确认句进程（maybeStartMediaClaude）退役删除 · mediaClaude 目录清理 · doubaoKey 冗余传递移除 · README 配置指引改为「模型配置页」方式

---

## v2.0.0（2026-08-28）—— 设置中心：模型配置管理 ⚙️

### 🆕 新增
- **设置面板「模型配置」分区**（三个 tab）
  - 💬 对话模型：当前生效配置卡片 + 我的档案（存/应用/删）+ 配置表单（供应商/模型档/baseUrl/key）+ 连通测试
  - 🖼🎬 生图 / 生视频：模型条目管理（每个模型独立 baseUrl/key，增删改 + 可达性测试），媒体生成按条目取配置（条目优先 → VISION_API_KEY 兜底）
- **模型配置 × ClaudeInstall 联动契约**：配置读写接口 A + 环境检测接口 B（`--detect-json` ↔ `/api/env`）对齐

### 🐛 修复（模型显示/切换根因链）
- **`*_MODEL_NAME` 残留覆盖 MODEL**：claude 实际调用优先认 `ANTHROPIC_DEFAULT_*_MODEL_NAME`，旧 settings 残留 flash 导致配置 pro 实际跑 flash → writeEnv 同步写 NAME 系列键
- **会话级 model 废弃**：claude 统一走全局 env（不再传 `--model`），配置保存后 killAll 重启 pty 生效
- **detectEnv 误用卡顿**：GET /api/config 误调 spawnSync 全环境检测阻塞 2s+ → 改纯读 settings（毫秒级）
- **busy 保护**：有任务在跑拒绝切换模型，提示先「⛔ 结束」

### 🔧 涉及改动
- `server/routes/config.js` / `server/lib/configService.js` / `server/lib/modelConfig.js` / `server/lib/mediaConfig.js` / `server/lib/dataStore.js` / `server/lib/mediaGen.js`
- `web/src/skin/ModelSettings.jsx` / `SkinSettings.jsx` / `web/src/App.jsx` / `ChatWindow.jsx` / `web/src/api.js`
- `server/routes/terminal.js` / `sessions.js`（去会话级 model 传参）

### 📦 封装
- commit `9f5e33e`（17 文件）· zip `ClaudeNeko_v2.0.0_20260828.zip`（95 文件 1.74MB）

---

## v1.9.3（2026-08-28）—— 全项目审查 10 项清零 🔍

### 🎯 变更
- 2-agent 全面审查，10 项问题全部修复：
  - 断连保护（客户端断开不崩服务）
  - docx 解压 bomb 防护（超大/畸形文档拒绝解压）
  - cancel 并发写会话冷却
  - 媒体库 TTL 清理（超时任务释放）
  - 超长 prompt 走 `-p` 路径兜底
  - memo 相关收尾
- 副产品修复：No response resume、Phase2 bus 订阅签名回归

### ✅ 结果
- 回归脚本全绿 · commit `e45ea08` · 封装 zip 1.81MB

---

## v1.9.2（2026-08-27）—— TUI 就绪修复 + busyLock 收敛 + 路由拆分 🔧

### 🎯 变更
- **TUI 就绪修复三保险**：pty ready 状态判定多重兜底 + 回车延迟优化
- **busyLock 收敛**：新建 `server/lib/busyLock.js` 模块，4 处调用点统一改用
- **Phase1 路由拆分**：server.js 按功能拆分为独立路由
- **Phase2 事件总线**：`server/lib/bus.js` 事件订阅发布，transcript/ptyHost 改走总线
- 回归脚本（`npm run regression`）· sticky scroll（终端/聊天黏底跟随）

### 📦 封装
- commit `a024500`

---

## v1.9.1（2026-08-27）—— 移除「下载视频」功能 🗑️

### 🎯 变更
- 移除「下载视频」技能包（生图/生视频保留）：粘贴链接下载整个下线
- 同步清理：后端下载引擎 + 脚本、前端技能入口/选项、`NEKO_DOWNLOAD_SCRIPT`、README 相关说明
- 保留：媒体库管理、生图/生视频、媒体理解（视频/音频转文字）
- 注：期间顺带修复了 faster-whisper 转录编码 bug（Windows 下 Python stdout 默认 GBK，Node 按 UTF-8 解码 → `U+FFFD` 坏字；强制 `PYTHONIOENCODING=utf-8` 已修复，供后续复用）

### 🔧 涉及改动
- `server/lib/mediaGen.js`（删 download 函数族）· `server/routes/media.js`（删 /api/media/download）· `server/lib/settings.js`（删 downloadScript/downloadBlacklist）
- `web/src/components/SkillBar.jsx` / `Composer.jsx` / `ChatWindow.jsx` / `web/src/api.js`（删下载入口）
- `web/src/skin/SkinSettings.jsx`（删「远程禁下载」提示）· `README.md`
- 删除 `server/lib/douyin/`（项目内下载脚本）

---

## v1.8.3（2026-08-26）—— @ 引用已挂的图（简化） 🖼️

### 🎯 变更
- **@ 只引用"已挂在输入框附件里"的图**（v1.8.2 是弹媒体库全部图面板）→ 简化：要新图先挂图（拖/📎），再 @ 引用
- 没挂图输入 @ → 面板提示"先挂图再 @ 引用"
- 点已挂图 → 插入 `@imageN`（N=该图在附件的顺序），**不重复加附件**（已在）

### 🔧 涉及改动
- `web/src/components/RefImagePicker.jsx`：去掉媒体库加载（fetch /api/media）→ 改收 `attachedImages` prop 直接显示附件图；空时提示"先挂图"
- `web/src/components/Composer.jsx`：`handleRefSelect(media, index)` 只插入 `@image{index+1}`、不加附件；传 `attachedImages=附件图片`

### ✅ 实测（Playwright）
- 没挂图 @ → 提示"先挂图" · 挂图后 @ → 面板只显示已挂图 · 点图 → `@image1` 干净插入（无双 @）· 附件不重复 · 挂 2 张 → 点第 2 张 → `@image2`

### 📌 本次不做
媒体库 @ 面板（已去掉）· 搜索过滤 · 删除附件自动重编号

---

## v1.8.2（2026-08-26）—— 生视频 @ 补全参考图 @🎨

### 🆕 新增
- **@ 自动补全参考图**：生视频技能下，输入框打 `@` → 弹出媒体库图片面板（缩略图网格）→ 点一张 → 自动插入 `@imageN` + 加入附件参考图。选图即引用，不用手动挂图+写编号
  - 编号 = 附件图片数 + 1，与附件顺序一致（提交时 @imageN 精确对应第 N 张参考图）
  - 插入到最新光标位置；光标自动停到插入文本后
  - 仅生视频技能启用；Esc / 点外 / 切技能关闭面板

### 🔧 涉及改动
- `web/src/components/RefImagePicker.jsx`（新组件）：媒体库图片面板（filter kind=image 限 50 张滚动、Esc/点外关闭）
- `web/src/components/Composer.jsx`：@ 检测（onKeyUp 读光标前字符）+ 选图插入（替换触发 @，防双 @）+ 编号协调 + 光标恢复（useEffect setSelectionRange）+ 函数式追加附件
- `styles.css`：面板浮层样式

### 🔧 实测抓 bug（Playwright）
- **双 @ / 残留 @**：插入 `@image1` 时没替换掉触发面板的 `@` → `test @@image1 @` → 修复：替换 @ 位置并跳过原 @（`start=pos-1, slice(start+1)`）
- 实测通过：面板弹出 → 插入 `@image1` 干净 → 二次插入 `@image2` 编号位置正确 → 附件标注出现

### 📌 本次不做
搜索过滤 · 内联缩略图（纯文本 @imageN）· 聊天模式 @ 补全 · 删除中间附件自动重编号

---

## v1.8.1（2026-08-26）—— 漏洞与冗余修复（2-agent 审查） 🔧

### 🔴 高危（实测验证）
- **H1 并发重复下载 + 锁双减**：前端轮询与后端盯梢并发调 queryTask，都过入口检查 → 同一视频下载两遍 + `active` 双减 → 新任务锁丢失可并发提交突破 MAX_ACTIVE。修复：queryTask 共享在飞 Promise（`t.querying`）+ 每任务 `lockHeld` 只释放一次
- **H2 孤儿释放锁**：force-stop 清空后，在飞 queryTask 终态仍 `active--` → 新任务锁被打回 0。修复：cancelAll 先把所有 `lockHeld` 置 false（阻止孤儿释放）

### 🟠 中危
- **M1 后端参考图不按 mode 限张数**：first 能传 5 张 / ref 传 100 张 → 按 mode 截断（1/2/8）
- **M2 429 限流误杀**：所有 4xx 判"任务不存在"→ 只 404/410 判终态，429 等走 failCount 重试
- **F1「无参考」被覆盖**：『无』值 '' 与"未选"同值 → 选无+挂图被默认 ref（白烧钱）→ 改独立值 'none'
- **F2 跨技能遗留 duration/resolution**：2.0 选 4K → 切走切回 2.5 无 4K → 提交失败 → 切技能重置
- **F3 上传竞态**：addFiles 闭包旧值丢附件 + 生视频提交不查 uploading → 函数式更新 + 提交前查 uploading
- **F4 首尾帧取前 2 张**：应为首帧+末帧 → `[imgs[0], imgs[last]]`

### 🟢 防御/整洁
- L1 duration 空数组兜底失效 + 加整数校验 · L2 gen_tasks.json 无界增长（cleanTimer 同步 persist + loadTasks 清超期）· L3 参考图脏记录守卫 · L4 选参考但图空静默降级 → 明确报错 · F5 切会话 tick/poll 定时器空转（标注待办）· F7 streaming+技能按钮假死（disabled 加 streaming）· 删 fileRef 死变量 · download 技能不再重置 video 模型 · resolution 存储口径统一

### ✅ 回归（实测）
- 连续 4 个无效参考图 → 锁不泄漏 · duration 4.5 → 整数校验拦截 · 首帧图生视频完整链路 90s done · done 后锁正常释放

### 📌 待办标注
- F5 生视频 tick/poll 定时器切会话/卸载清理（低危·无数据丢失）· F6 附件乐观清空失败后回填（低危）· api.js 错误字段口径统一（mediaTask 读 j.error vs message）

---

## v1.8.0（2026-08-26）—— 生视频参考图（首帧/首尾帧/参考素材） 🖼️🎬

### 🆕 新增
- **生视频参考图**：生视频技能下可选参考图，三种模式——首帧（图当第一帧）/ 首尾帧（两张图之间生成）/ 参考素材（多图 ≤8，风格/主体参考）
- **复用输入框附件**：挂图 = 参考图（拖拽/粘贴/📎媒体库两个入口天然都有，不用单独选图 UI）；附件条技能模式下醒目标注"图片将作为参考图"
- **base64 本地图直传火山**：无需公网 URL（实测确认 2.5/2.0 都认 `role: first_frame/last_frame/reference_image` + base64，**统一格式不用按模型分支**）
- **@ 引用**：参考素材模式提示词可写 `@image1` 指认第一张图（透传 + UI 灰字提示）
- **首帧/首尾帧自动省略 ratio**（火山按图片比例自适应，不裁切）

### 🔧 涉及改动
- `server/lib/mediaGen.js`：`buildRefBlocks`（读媒体图 base64 + role 排序 + 总预算 58MB + 防御）+ `generateVideo` 加 refMode/refImages + 参考图请求超时 120s
- `server/routes/media.js`：透传 refMode/refImages
- `web/src/components/Composer.jsx`：生视频提交把附件 image→refImages（首帧取1/首尾帧取2/参考素材≤8）、默认 refMode='ref'、提交后清空附件、附件条参考图标注
- `web/src/components/SkillBar.jsx`：参考方式单选（无/首帧/首尾帧/参考素材）+ @ 提示
- `web/src/components/ChatWindow.jsx`：mediaGenerate 透传参考图参数
- `styles.css`：参考方式按钮样式

### 🔧 审查迭代（4 轮审视 + 实测抓 2 bug）
- **锁泄漏 bug（实测抓到）**：buildRefBlocks 在校验后、try 外抛错（REF_INVALID）→ `active+=1` 未释放 → 后续生成全 BUSY → 移入 try 块
- 单张 5MB 限制太紧（挡掉 4K 图）→ 改**总预算 58MB**
- 首帧图比例冲突 → 省略 aspect_ratio
- 火山创建任务阶段校验参数被拒不扣钱 = 天然安全网
- 附件语义标注可见性 / 切换参考方式自动截断 / 后端 refMode 白名单防御

### ✅ 实测通过（mini 5s 720P 首帧图生视频）
- 2.5 首帧 `role: first_frame` base64 → HTTP 200
- 2.5 参考素材 `role: reference_image` base64 → HTTP 200
- Neko 完整链路：提交（媒体库图当首帧）→ 盯梢 → 约 70s done → 3.3MB 视频落盘
- 无效参考图 → REF_INVALID 拦截（不花钱）+ 锁不泄漏

### 📌 本次不做
参考视频（本地视频无法上传火山·技术障碍）· 图片压缩（零依赖）· 真人脸检测（火山拒·提示）

---

## v1.7.0（2026-08-26）—— 生视频认领式兜底 + 时长滑块 🎬🛟

### 🆕 新增
- **生视频「认领式兜底」**：任务从提交起由后端盯到完成自动落盘（不再依赖前端轮询）——关页/刷新/服务崩溃重启都不丢任务，火山跑完自动下载进媒体库，**不再白烧钱**
  - 任务落盘 `data/gen_tasks.json`（原子写），启动自动认领 24h 内未完成任务继续盯
  - 无固定放弃上限：火山说 running 就一直盯（4K 排队 1 小时也等），只有火山明确失败才停
  - running 超 6 小时强制停（终极刹车，防火山永不返回 → 永久 BUSY）
  - 连续 3 次查询失败（断网/API 挂）→ 判"查询失败"（释放锁，提示可重新生成）
  - 点「结束」同步清落盘 → 重启不会复活
- **生视频时长滑块**：固定档下拉 → 范围内自由拖动（2.5 支持 4~30s，2.0/Mini/Fast 4~15s），显示当前值，切模型自动收敛范围，默认最低值；CLI `--duration` 同步改范围校验

### 🔧 涉及改动
- `server/lib/mediaGen.js`：后端自轮询盯梢定时器（4K 放宽 10s/防重入）+ 任务落盘 + 启动认领 + 复活检查 + 6h 上限 + TTL 细化（done 10min / error 24h）+ cancelAll 清盘 + 查询失败分级（404→失败）+ 顺手修"成功但无视频地址假装成功"bug
- `server/lib/settings.js` + `doubao_models.json`：`durations` 数组 → `durationRange{min,max}`（两处同步）
- `server/server.js`：传 `dataDir` 供任务落盘
- `web/src/components/SkillBar.jsx`：时长下拉 → 滑块；`Composer.jsx`：提交时 `duration ?? min` 兜底
- `seedance_gen.py`：CLI 时长范围校验 + `--list` 显示范围

### 🔧 审查迭代（方案 5 轮审视 + 实测发现）
- 认领锁 2 分钟窗口实测翻车：提交后立即崩溃重启会被"认领锁"挡住不认领 → **去掉认领锁**（单实例重启时旧进程必然已死；双实例重复下载为可接受标注场景）
- 提交值与 UI 一致性：滑块显示 min 但提交 undefined → Composer 兜底 `?? min`

### ✅ 实测通过（Mini 5s 720P）
- 提交 → 立即杀服务 → 重启 → "启动认领未完成任务" → 火山已完成 → 自动补下载落盘 3.2MB mp4
- 重启不认领 done 任务（完成的不复活）
- force-stop 清空落盘（结束的不复活）

---

## v1.6.1（2026-08-25）—— 导出统一 + 搜索 v2.0 🚀

### 🆕 新增
- **统一导出面板（ExportDialog）**：所有导出入口收敛为两个——聊天区"导出"（当前会话 txt/json）+ 设置"导出全部"（全部 txt/zip），都弹统一面板选形式 + 勾选含思考；侧栏会话项 ⬇ 与 💾 备份全部 移除
- **搜索 v2.0**：从"搜会话"升级为"搜内容直达气泡"——只搜消息内容、结果精确到气泡（点击跳转定位对应消息）、多关键词空格/逗号分词 + AND 降级 OR（标注命中词）、每会话所有命中气泡全列、上限 200

### 🔧 涉及改动
- `web/src/components/ExportDialog.jsx`（新增通用导出面板）
- `ChatWindow.jsx` / `SkinSettings.jsx` / `SessionItem.jsx` / `Sidebar.jsx`：导出入口统一 + 移除重复按钮
- `server/routes/sessions.js`：search 路由重写（消息级结果 + AND/OR + 200 上限）
- `MessageList.jsx`：全部消息加 `msg-{index}` 锚点；`App.jsx` + `ChatWindow.jsx`：jumpTarget 跳转链路（切会话 → 定位气泡）

### 🔧 审查修复（2-agent）
- **搜索跳转高危 bug**：切到另一会话时过渡渲染会命中旧会话 DOM + 提前清掉 jumpTarget（跳转失效/跳错）→ useChatStream 暴露 `messagesSessionId`，跳转 effect 确认消息数组归属目标会话后再滚动
- **搜索后端**：snippet 定位改为"所有命中词在文本中最早位置"（修复输入序首词切错上下文）· 关键词去重（"导演 导演"不再算 2 词）· 按完整词限 10 个（不再码元截断切半词）· 单遍收集替代 AND/OR 双扫
- 死 props 清理（App 给 ChatWindow 传了未使用的 onRename）· ExportDialog `formats` 加默认值

---

## v1.6.0（2026-08-25）—— 三项增强：会话备份 + 搜索 + 成本统计 💾🔍📊

### 🆕 新增
- **会话 JSON 备份 💾**：会话项 ⬇ 导出单个 JSON（完整数据可恢复）；侧栏「💾 备份全部」打包 zip（复用 STORE 模式 zip，零依赖）
- **搜索 🔍**：侧栏搜索框（防抖 300ms）→ 标题 + 消息全文搜索，结果带片段点击跳转（性能兜底：限最近 100 会话、每会话首命中即止）
- **成本统计 📊**：每条 AI 消息显示 token 用量（↑输入 ↓输出 🧠思考）；侧栏底部全局累计；usage 从 claude result 事件抓取落盘（含缓存读/写 + 思考 token）

### 🔧 涉及改动
- `server/routes/sessions.js`：`GET /api/sessions/:id/export` + `/api/sessions/export-all` + `/api/search?q=` + `/api/stats` + `/api/sessions/:id/stats`；result 事件抓 usage 落盘
- `web/src/components/SessionItem.jsx`：⬇ 导出按钮
- `web/src/components/Sidebar.jsx`：💾 备份全部 + 搜索框 + 结果列表 + 全局统计条
- `web/src/components/MessageBubble.jsx`：AI 消息 token 小字
- `web/src/api.js`：`stats` / `sessionStats` / `search` 方法

### 🔧 审查修复（2-agent 并行审查 + 逐项验证）
- **export-all 上限**：会话数 200 / 字节 500MB，防全内存打包 OOM/阻塞
- **export-all 重名去重**：重名加 `(n)` 序号，防 zip 同名覆盖静默丢数据
- **分支剥离 usage**：修复成本统计在父会话+分支重复计数
- **新 GET 端点来源校验**：export/search/stats 防 DNS rebinding 数据外带（实测陌生 Origin → 403）
- **标题消毒加控制字符** + 抽 `safeFilename` 单一实现（修两处复制粘贴不一致）
- **usage 取值简化 + 空对象防御 + 与 text 解耦**（无文本也记成本）
- **搜索 q 长度上限** + 常量提模块级 + `mergeUsage` 统一聚合
- **前端**：搜索竞态守卫（防旧请求覆盖新结果）· 全局统计随 sessions 刷新（聊天中不再静止）· 点击结果跳转清空搜索态 · 搜索失败独立提示 · debounce 卸载清理

### 🔧 二轮复查修复（2-agent 复查修复本身 + 遗漏）
- **safeFilename 防孤代理崩溃**：标题可能被 `slice(0,15)` 切断 emoji 产生孤代理 → 单会话导出 `encodeURIComponent` 抛 URIError 500；加 `stripLoneSurrogates` 清理（合法 emoji 保留）
- **safeFilename 补全**：控制字符全挡（0-31）+ Windows 保留设备名（CON/PRN/AUX/NUL/COM/LPT）加前缀
- **export-all 去重升级**：Set 记最终名循环 +1，避开真实标题同名撞车（如真实会话叫 `a(1)` 时不再覆盖）
- **来源校验补全**：会话列表/详情/消息 + media.js 全部 GET（列表/config/task/文件）都加 `isLocalRequest`（远程代理会改写 Origin 不受影响）
- **export-all 超限 404 文案**：区分"没会话"和"超 500MB 上限"
- **usage 取值简化**：`evt.usage ?? evt.result?.usage ?? null`
- **前端搜索状态机补漏**：清空查询时递增请求序号（失效在途请求）+ 每次击键重置 results（防旧结果闪现）+ 卸载清理递增 seq

### 🔧 全项目审查修复（3-agent 全项目审查：后端核心 / 媒体远程 / 前端全部）
- **P0 安全**：
  - 去掉 `Origin: null` 本地来源放行（沙箱 iframe / data: 文档等恶意网页可烧豆包配额 / 开远程隧道 / 填磁盘；实测 403）
  - busy 锁 finally 兜底（claude 启动失败不再锁死会话永久 409）+ claudeRunner 过滤 prompt NUL（spawn 不再抛 ERR_INVALID_ARG_VALUE）
  - sessions.json 原子写（tmp+rename，防崩溃时写一半损坏索引 → 丢全部会话）
- **P1 并发 / SSRF**：
  - 生图加并发锁（与生视频同一把 active，防堆叠烧额度）
  - 下载视频 SSRF 内网过滤（拒绝 loopback / 私网 / 云元数据段；实测 BLOCKED）
- **P1 前端**：
  - claude娘滚轮缩放默认路径失效修复（effect 依赖 [visible] 重挂监听）
  - 双击 / 双 Enter 并发双流修复（streamingRef 即时守卫）
  - 删除当前会话后立即选下一个（不再空白 3 秒）

### ⚠️ 注意
- 成本统计仅对 v1.6.0 后**新消息**有效（历史消息无 usage 数据）；被取消/停止的消息无成本记录
- 每轮 input_tokens 含记忆 + 历史上下文（缓存命中时走 cache_read），累计按请求次数叠加 = **真实成本口径**（数字会偏大属正常）

---

## v1.5.2（2026-08-25）—— 对话体验升级 📑📌

### 🆕 新增
- **会话置顶 📌**：侧栏每个会话常驻置顶按钮，置顶的会话排最前、柔和底色区分，不被新会话刷沉
- **会话批量管理 ☑**：侧栏「☑」进入多选 → 批量删除（确认防误删）/ 批量导出 txt（跟随"导出含思考"开关），一次刷新
- **媒体库批量管理 ☑**：媒体库「管理」进入多选 → 批量删除 / **批量下载 zip**（后端手写 STORE 模式 zip，零依赖）
- **用户消息导航 📑**：对话右上「📑」抽屉列出所有用户提问，点击跳转到对应位置；流式生成不打断跳转（不在底部才自动滚）

### 🔧 涉及改动
- `server/lib/sessionStore.js`：`pinned` 字段 + 置顶优先排序（兼容老会话）
- `server/routes/sessions.js`：PATCH 支持 `pinned`
- `server/lib/zip.js`（新增）：手写 STORE 模式 zip + CRC-32 查表，零依赖
- `server/routes/media.js`：`POST /api/media/export-zip` 批量打包下载（UTF-8 文件名）
- `web/src/hooks/useSessions.js`：`togglePin` / `removeMany`（批量删除一次刷新）
- `web/src/components/Sidebar.jsx` + `SessionList.jsx` + `SessionItem.jsx`：置顶按钮 + 多选模式 + 批量操作条
- `web/src/components/MediaLibrary.jsx`：多选模式 + 批量删除/下载 + zip
- `web/src/components/MessageList.jsx`：自动滚动"不在底部才滚" + 用户消息锚点
- `web/src/components/ChatWindow.jsx`：📑 抽屉目录 + 跳转
- `web/src/api.js`：`exportMediaZip`

### 🧪 实测
- 置顶：置顶排最前、取消恢复、老会话兼容 ✓
- 媒体 zip：export-zip → 解压成功、中文文件名正确 ✓
- 批量删除/导出：多选 → 删除/导出生效、一次刷新 ✓
- 导航：抽屉列出用户消息、跳转定位 ✓

---

## v1.5.1（2026-08-25）—— 思考过程显示 🧠

### 🧠 新增
- **AI 思考过程显示**：DeepSeek 推理模型的思考逐字流式出现，消息上方「🧠 思考过程」折叠块，点开看完整推理（默认收起）
  - 数据来源：`thinking_delta` 流式事件（此前被丢弃，现在累积 + 转发）
  - 零额外 token 成本——思考本就传输，只是之前 Neko 没展示
- **思考永久保存**：落盘到消息的 `thinking` 字段，刷新/切会话后仍在
- **导出可选**：设置 → 功能 → 「导出包含思考过程」（默认关）；两个导出入口（当前对话 + 全部会话）都读取该全局开关

### 🔧 涉及改动
- `server/routes/sessions.js`：流式累积 `accThinking`（`thinking_delta`）+ 转发前端；assistant 块空值兜底；落盘 `thinking` 字段
- `web/src/hooks/useChatStream.js`：流式气泡加 `thinking` 字段 + `thinking_delta` 累加
- `web/src/components/MessageBubble.jsx`：`<details>` 折叠块（纯文本 `<pre>`，防 XSS）
- `web/src/styles.css`：`.msg-thinking` 样式（移动端 `pre-wrap` 防横向滚动）
- `web/src/utils/export.js`：`messagesToText` / `exportSessionText` 加 `includeThinking` 参数
- `web/src/skin/SkinSettings.jsx` + `web/src/components/ChatWindow.jsx`：导出读取全局开关

### 🧪 实测
- thinking_delta 194 事件逐字流式到达（text_delta 117、done 1）✓
- 落盘：assistant 消息带 thinking（762 字）✓
- 导出：默认不含思考、开开关含「🧠 [思考过程]」段 ✓
- 分支/历史注入不受影响（只拼 text，思考不混入 prompt）✓

---

## v1.5.0（2026-08-24）—— 记忆修复 + 远程访问 📱

### 🧠 记忆修复（对话变聪明）
- **工作目录可配置（`NEKO_WORK_CWD`）**：claude 子进程默认在主目录，需要"加载某个目录的记忆"时设环境变量 `NEKO_WORK_CWD` 指向该目录（如 `C:\Windows\System32`，加载桌面 CLI 那套记忆 → 对话"认识用户"）
- 面向市场：默认 `os.homedir()`（大众合理值），不硬编码个人路径
- **实测**：新会话问"你是谁的用户" → 能准确答出用户档案中的姓名/学校/专业（记忆加载生效）✓
- **老会话不迁**：已聊过的会话 cwd 保持原样（避免原生会话上下文丢失）；新会话自动聪明

### 📱 远程访问（手机 / 公网连接）
- **设置 → 功能 → 远程访问**开关（默认关）：开启后手机浏览器打开公网地址 + 输配对码即可用
- **配对鉴权**（沿用 c2web 方案）：短码 → SHA-256 哈希凭证，磁盘只存哈希，明文只在校对那一刻发给手机；配对一次终身免码
- **配对码动态生成**（`~/.claudeneko/`，不写死）：换码后旧设备全部失效需重配
- **独立代理端口 4001**：cloudflared 指向 4001，业务端口 4000 完全不动（桌面本地免鉴权照常）
- **安全**：远程模式下 `下载视频`（SSRF 高风险）直接禁用 403；未配对访问只给配对页；HttpOnly Cookie 鉴权（前端零改动）
- **流式**：cloudflared 实测**不缓冲 SSE**，逐帧实时到达（省/标准/强力档都走这条）
- **跨端延续**：手机和桌面共用同一份会话数据——手机聊的桌面接着聊

### 📱 移动端适配
- 窄屏（<768px）侧栏变**抽屉**：汉堡按钮展开、点会话/空白收起
- 聊天区全宽 + 隐藏模型标签 + 输入区安全区适配

### 🔧 涉及改动
- `server/lib/settings.js`：新增 `NEKO_WORK_CWD` 环境变量支持（默认 `os.homedir()`），替代硬编码工作目录
- `server/lib/remote/`（新目录）：`pairing.js`（配对凭证存储，改路径+动态码）/ `tunnel.js`（搬 @inksnow/c2web MIT）/ `proxy.js`（Cookie 鉴权 + SSE pipe 转发 + 下载禁用）/ `index.js`（生命周期管理）
- `server/routes/remote.js`：远程状态/开关/换码 API
- `server/server.js`：接线 remote + 退出清理（杀隧道防孤儿）
- `web/src/App.jsx` / `Sidebar.jsx` / `styles.css`：移动端抽屉 + 汉堡 + 遮罩
- `web/src/skin/SkinSettings.jsx`：远程访问开关 UI（显示公网地址 + 配对码 + 换码）
- `web/src/api.js`：remote 相关方法

### 📝 说明
- 公网地址为 trycloudflare 免费随机域名，重启会变（需固定域名可选，记入待办）
- 远程依赖 cloudflared（已装）；未装时开启仅局域网可用
- 手机白天用 = DeepSeek 高峰价，注意省钱

---

## v1.4.22（2026-08-24）—— 常驻自愈（任务计划）🔄

### 🆕 新增
- **开机自启升级为「常驻自愈」**：设置 → 功能 → 开机自启开关从注册表（HKCU）改为**任务计划**（登录触发 + 每 5 分钟重复）
- 新增 `start-server.bat`（幂等启动：server 在跑就跳过，没跑就拉起）→ server 崩溃后**最多 5 分钟内自动恢复**
- `start-server.vbs` 隐藏窗口启动（直接 Run bat 完整路径，绕开中文路径经 cmd 解析的乱码坑）
- 市场友好：**默认关**（不打扰），需要自启/自愈的用户在设置里打开即可

### 🔧 修复（实测踩坑）
- **vbs 中文路径乱码**：vbs 拼 `cmd /c cd /d 中文路径 && bat` 时中文坏成 `??` → 改为 ShellExecuteW 直接 Run bat 完整路径
- **快速 toggle 失败**：setAutoStart 关→立即开时任务注册静默失败（Unregister 异步）→ 注册前清残留任务 + 短延迟
- **漏洞修复（检查）**：媒体记录 fileName 缺失 → 500（`path undefined`）→ 防御 404；autostart 注册失败无反馈（前端显示"开"实际没开）→ POST 后验证任务状态，不一致返回错误；effort 无值校验 → PATCH/POST 只接受 low/max/null，非法 400
- **审查修复批（2 agent 深挖 + 验证）**：`null`/残缺 JSON body → 500 + busy 锁永久泄漏 → readBody 归一化非对象为 `{}` + Buffer 统一解码（修 UTF-8 跨包乱码）；cancel/force-stop 竞态（旧任务 release 误删新任务锁）→ 检查 runner 归属；`run-node.vbs` 改 ShellExecute（中文路径，同 start-server.vbs 修复）；附件上下文 fileName 防御；runPowerShell 加 15s 超时 + stderr 落日志；autostart 查任务启用状态（Disabled 不算开）；media 双重 decodeURIComponent（`%` 文件名 500）；前端档位 select 改用 EFFORT_LEVELS + 值钳制 + patch 吞错 + 设置页打开时刷新默认档

### 📝 说明
- schtasks 命令行不支持 ONLOGON + 重复间隔，用 PowerShell `Register-ScheduledTask` 的 Repetition 实现
- 自愈延迟 ≤ 5 分钟（任务计划重复间隔，可改）
- 旧开机触发任务（ClaudeNekoServerBoot）与旧 HKCU 自启项已自动清理

---

## v1.4.21（2026-08-24）—— 思考档位 🎚️

### 🆕 新增
- **思考档位选择（省 / 标准 / 强力）**：会话头部右上角下拉切换，对下一条消息生效
  - 🪙 省 = `--effort low`（简单问答，省 token）
  - ⭐ 标准 = 不传（DeepSeek 默认档，现状零改动）
  - 💪 强力 = `--effort max`（复杂任务，深度思考）
- **全局默认档**：设置 → 功能 → 默认思考档位，新建会话继承；对话中可随时覆盖
- **分支继承**：分支会话自动继承父会话的思考档位
- 依据 DeepSeek V4 官方：有效档位 low / high(默认) / max（medium / xhigh 会静默映射为 high）

### 🧪 实测验证（省 vs 强力，各多次）
- **耗时**：省 ~12s 稳定，强力 ~23s（约 2 倍慢）—— max 确实思考更久，effort 透传真实生效
- **质量**：强力回复更结构化（明确分段），省更直接简短
- 链路：`claude --effort` → DeepSeek 不报错，且耗时响应档位变化（通过网关 [1m] 模型验证）

### 🔧 涉及改动
- 后端：`claudeRunner.js` 透传 `--effort`；`sessions.js` 建会话 / PATCH / 分支 / 发消息支持 effort；`sessionStore.js` 存 effort 字段
- 前端：新建 `utils/effort.js`（档位常量 + localStorage 默认档）；ChatWindow 头部档位下拉；设置页默认档；api / useSessions 透传
- 说明：max 档复杂任务可能偶发极慢（实测一次 180s+ 无输出被空闲超时兜底），有 ⛔结束 按钮可打断

---

## v1.4.16（2026-08-24）—— 两轮审查修复 🔍

### 🔧 v1.4.4 ~ v1.4.16 聚合记录
- v1.4.4 AI 气泡附件显示修复（assistant 分支补附件渲染）
- v1.4.5 生成中显示升级（spinner + 分技能文案 + 生视频计时）+ 附件放大
- v1.4.6 气泡附件下载按钮
- v1.4.7 AI 生成附件自适应比例（竖/横/超宽完整）
- v1.4.8 大图查看 Lightbox（气泡/媒体库/选择器三处）
- v1.4.9 生成流程用户提示词进会话 + 新会话自动命名
- v1.4.10 每会话生成媒体首次拉 claude（确认 + 留痕，防重复）
- v1.4.11 生成中占位进消息流（带提示词 + 计时）
- v1.4.12 claude 媒体生成确认改极简（禁写记忆）
- v1.4.13 聊天窗口显示会话 claude ID（可复制）
- v1.4.14 claude ID 显示修复（实时拉 getSession）
- v1.4.15 一轮审查：删死 CSS 11 条 + 无用 import，active 泄漏 TTL 释放，arkFetch 超时，video 计时器泄漏
- v1.4.16 二轮审查：转录失败不丢视频 + 提示，视频下载失败直接判错防卡 TTL，删 seq + 修 JSDoc

---

## v1.4.3（2026-08-23）—— 生成结果进 AI 气泡 💬

### 🆕 改进
- 生成结果（生图/生视频/下载）从独立卡片区改为 **AI 消息气泡**融入对话流
- 完成后写 AI 消息进会话（text + 附件媒体）——刷新保留、可导出、可回溯
- 生成中显示「⏳ 生成中」临时气泡，完成后转成 AI 气泡
- 新增端点 `POST /api/sessions/{id}/media-message`（追加纯展示 AI 消息，不干扰 Claude 会话）

---

## v1.4.2（2026-08-23）—— 视频档位按模型修正 🎬

### 🆕 修正（按火山官方文档逐模型核对）
- **2.5**：时长 4-30s（补 4/5/10/15/30）、分辨率加 1080P
- **2.0**：分辨率加 1080P / 4K（4K 独享并发/RPM 低/更贵，标注"更慢更贵"）
- **2.0-mini / fast**：保持 480P / 720P
- 实测：`1080P` / `4K` / 时长 30s 均被火山 API 接受

### 🔧 修复
- 切模型时重置分辨率（防 2.0+4K 切到 mini 传非法值报错）
- 4K 任务 TTL 延长到 30 分钟（4K 独享并发+RPM 低，防 10 分钟 TTL 误杀）

---

## v1.4.1（2026-08-23）—— 生成分辨率可调 🖼️

### 🆕 新增
- **生图分辨率**：2K / 3K / 4K（Seedream 5.0），比例 × 分辨率组合成尺寸（目标像素 + 边长≤4096 clamp + 下限校验，18 组全部合法）
- **生视频分辨率**：480P / 720P（Seedance 官方支持范围，跟随模型）
- 高分辨率选项标注「更慢更贵」——成本透明

### 🔧 修复
- server generate 端点漏传 resolution（4K 请求实际出 2K 尺寸）——已修复，实测 4K 9:16 出 2304×4096

---

## v1.4.0（2026-08-23）—— 技能包：生图 / 生视频 / 下载视频 🎨🎬

### 🆕 新增功能
- **技能包**：输入框下方一排技能（生图 / 生视频 / 下载视频），选中切换输入模式与选项
- **生图**：选 Seedream 模型（5.0-Lite / 5.0-Pro）+ 比例 → 输入提示词出图，存媒体库
- **生视频**：选 Seedance 模型（2.5 / 2.0-Mini / 2.0 / Fast）+ 比例 + 时长（时长跟随所选模型）→ 异步生成，前端轮询，完成后媒体库可播放
- **下载视频**：粘贴链接下载到媒体库，可选「下载后转录文案」（faster-whisper 本地转写）
- **模型可用性运行时判定**：未开通模型点了给明确提示（"当前 key 未开通此模型"），不写死可用状态——换 Key 即解锁
- **BYOK 零额外配置**：生成媒体复用豆包视觉 Key（VISION_API_KEY）或单独配 DOUBAO_API_KEY
- **优雅降级**：无 key / 缺转录依赖 / 下载受限 → 明确提示，其余功能不受影响

### ⚡ 性能优化
- **faster-whisper 转录提速**：`local_files_only=True`（本地缓存优先）——模型加载从 ~165s 降到 ~2.5s（跳过 HF Hub 联网检查），转录短视频从"必超时"变"约 20 秒出文案"

### 🔒 合规
- 下载视频定位"转录/分析自己的素材"，README 免责声明 + 域名黑名单可配置

---

## v1.3.1（2026-08-23）—— 长任务不再被误杀 ⏱️

### 🔧 修复
- **总时长超时 → 空闲超时**：原 5 分钟硬超时会误杀正常长任务（读附件/长上下文/多轮工具调用经常超过 5 分钟）。现改为——只要 claude 还在持续输出（流式事件 / stderr 日志）就绝不超时；只有**连续 5 分钟毫无动静**才判定卡死并中止，兜底防会话锁被永久占用的作用不变
- **纠正误导文案**：超时中止不再显示为"claude 启动失败：…"，改为明确提示"claude 长时间无响应，已中止本次生成"

---

## v1.3.0（2026-08-21）—— 吉祥物互动与体验升级 🎎

### 🆕 新增功能
- **claude娘 吉祥物**：拟人化学者挂件（透明通道素材），支持点击**实时查询 DeepSeek 余额**；API Key 仅存后端，绝不下发前端
- **状态气泡系统**：AI 思考中 / 回答中 / 输入打字时，claude娘 显示对应状态提示
- **挂件交互**：拖拽吸附边缘、滚轮缩放（70–320px）、右键水平镜像、松手弹性动画
- **生成中可预打字**：AI 生成时输入框保持可用，可提前输入，生成结束即发送
- **会话最近时间**：侧栏每条会话显示「刚刚 / N分钟前 / 今天 / 昨天 / 日期」
- **余额接口**：`GET /api/balance`，内置 30 秒缓存，降低请求频率

### 🎨 外观与设置
- 设置重构为「外观 / 功能」双分区，分类更清晰
- 流体背景扩展为 **5 套预设**（海洋 / 极光 / 火焰 / 霓虹 / 月光），点选即联动滑块
- 支持**将当前外观固化为出厂默认**，一键恢复即回到你的专属配置

### 🔧 修复与优化
- 修复生成中断线导致的**会话锁死**问题（busy 锁立即释放）
- 行内代码视觉优化、超大输入返回明确错误提示
- 精简交互：移除低频的「重新加载对话」按钮，保留复制与引用

---

## v1.2.0（2026-08-20）—— 皮肤系统与 Markdown 渲染

### 新增功能
- **Markdown 完整渲染**（GFM）：表格 / 代码块 / 嵌套列表 / 链接；用户消息转义防注入
- **开机自启 + neko:// 一键启动**：固定浏览器标签页即可拉起服务
- **多开页面同步**：多标签自动轮询，消息不丢失、无需手动刷新
- **消息操作**：复制 / 引用（微信、QQ 式引用条）
- **皮肤系统**：8 套主题 / 壁纸（本地图、URL、渐变）/ WebGL 流体 / 各区域透明度
- **会话管理**：双击改名 / 空会话清理 / 右上角实时显示当前模型

### 架构
- 后端模块化重构（零依赖），完整保留 Claude Code 技能、MCP、记忆能力
- 数据全部本地存储，无云端上传

---

## v1.0.0（2026-08-19）—— 初版

- 多会话聊天 + 本地历史存储 + 续聊自动恢复上下文
- SSE 流式输出（打字机效果）
- 模型切换
