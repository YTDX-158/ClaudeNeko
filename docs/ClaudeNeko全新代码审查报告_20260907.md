# ClaudeNeko 全新代码审查报告（第二轮）

审查日期：2026-09-08
审查分支：`codex-permission-p1-20260906`
对照报告：`ClaudeNeko代码审查报告_20260904.md`（65 条）

## 结论摘要

本轮从当前代码重新审查权限、远程、终端、会话、媒体、配置和发布脚本，并逐条对照旧报告去重。

- 新发现并已在本分支修复：19 条 P1 权限缺陷及边界缺陷。
- 新发现但未在本轮扩大范围修复：12 条，其中高风险 3 条、中风险 9 条。
- 另有 2 项已证实现象与旧报告同根，作为补充证据记录但不重复计数。
- 已修复部分由自动化测试、生产构建和真实 Claude CLI 身份测试共同验证；未修复部分均给出代码证据、复现路径和建议。

## 一、本分支已修复的新问题

### F-01 高：已配对远端可读取/修改权限策略并切换完全访问

原行为允许远端访问 `/api/permission/config`，配对设备因此能把模式改为 bypass。现由 `server/lib/remote/proxy.js` 在规范化路径后对所有方法阻断该端点；配对设备仍可获取审批密钥并逐次处理一张待审批卡，但不能改模式或规则。对应 query、dot-segment、编码 dot-segment、反斜杠变体已有回归测试。

### F-02 中：刷新、切会话或 WebSocket 重连后待审批卡片丢失

`web/src/hooks/useChatStream.js` 现会在会话加载和每次 WS 打开时拉取权威 pending 快照，并用请求代次、会话身份和已关闭 ID 集合阻止迟到快照复活旧卡。

### F-03 中：审批网络失败后按钮永久忙碌

`web/src/components/PermCard.jsx` 现等待响应 Promise；`web/src/permissionUi.js` 用 `finally` 恢复交互。响应失败时卡片保留，可直接重试。

### F-04 中：聊天“停止”不取消权限请求

`server/routes/sessions.js` 的 cancel 路径现调用 `permissionService.cancelBySid`；后端关闭该会话全部未决/已决未消费记录并广播 `perm-closed`，前端同时乐观收卡。

### F-05 中：全新安装点击“以后都行”失败或假成功

`server/lib/permissionConfig.js` 现防御性初始化 `allow/deny` 数组；规则落盘失败会返回非 2xx，决定不落地、卡片不关闭，不再把失败伪装成成功。

### F-06 中：“以后都行”把授权放大为命令前缀或路径前缀

`server/routes/permission.js` 现只生成完整 Bash 命令或完整文件路径规则，智能审批也只做完整匹配；前端明确显示将被记住的精确范围。

### F-07 中：pending Map 长期保留完整工具输入并无限增长

每条记录现有 15 分钟 TTL；决定第一次被 Hook 取走后消费，会话停止时整体清理。广播和 pending API 统一返回 `{id, tool_name, summary, dangerous, alwaysScope}`，不再返回完整 `tool_input`；全局与单会话容量另有硬上限。

### F-08 中：安装 ClaudeNeko Hook 会覆盖用户已有 PermissionRequest Hook

`server/lib/hookManager.js` 现保留无关 Hook，只去重路径与当前 ClaudeNeko 脚本完全一致的条目。仅凭同名或 `/server/permission_hook.cjs` 后缀无法证明来源，因此一律保留，避免静默删除用户 Hook。

### F-09 中：损坏或不可写的 Claude settings 可让服务在 listen 前崩溃

`server/server.js` 现捕获 Hook 安装异常、记录 warning 并继续启动；原配置不会被当作空配置覆盖。

### F-10 低：自定义服务端口时 Hook 仍固定连接 4000

`server/permission_hook.cjs` 现按 `NEKO_PERMISSION_PORT`、继承的 `PORT`、4000 的优先级选端口，并有子进程级回归测试。

### F-11 中：缺少目标参数时“以后都行”退化为整类授权

Bash 缺 command、写类工具缺路径时，现直接拒绝保存长期规则并保持请求 pending，不再生成 `Bash`、`Write` 等工具级放行规则。

### F-12 中：混合 PermissionRequest 条目仍会丢用户 Hook 或重复 Neko Hook

Hook 合并现只消费能确认是当前 Neko 的具体 hook；同条目的 matcher 和用户 hook 保留。任意目录（包括名为 `server` 的目录）中的非当前同名脚本都不会被误判，带 metadata 的当前 Neko-only 条目也不会重复执行。

### F-13 中：停止请求失败仍会永久隐藏审批卡

前端现仅在 cancel 获得成功响应或收到 `perm-closed` 后关闭卡片；网络失败保留卡片并显示错误，后续仍可审批或重试停止。

### F-14 高：旧 WebSocket 的迟到权限事件会串到新会话

`web/src/ws.js` 现同时核对捕获的 socket 与 sid；A 会话旧连接的迟到消息不会按全局 currentSid 派发给 B。

### F-15 高：控制字符清洗造成不同 Bash 命令共用同一长期规则

授权身份现保存和比较原始完整命令；审批卡把换行显示为可见的 `\n`，不会把多条命令伪装成一行。规则解析支持换行，危险命令检查也覆盖换行和常见 shell 分隔符后的命令段。

### F-16 高：远端仍能借 always 持久化规则并伪造 Hook 请求

远程代理现覆盖可信远程标记，阻断内部 `/api/permission/request` 与 `/wait`；服务端对远程 `always` 返回 403，只允许逐次 `once/deny`，远程页面同步隐藏长期授权按钮。

### F-17 高：pending 无瞬时容量限制并保留近 1 MiB 输入

pending 现设置全局与单会话上限，超量返回 429；记录只保留工具名及 Bash command/写入路径等决策必要字段，不再持有完整 `tool_input`、cwd 或 session payload。单条规则目标上限为 16 KiB，超过上限只生成 200 字符审批摘要，不能被持久化为长期规则。

### F-18 低：卡片关闭墓碑在长期会话内只增不减

墓碑只在 pending 快照请求飞行期间记录；最后一个请求完成即整体释放。停止成功会先使在途快照代次失效再清卡，兼顾防复活与长期会话内存有界。

### F-19 低：Hook 定时轮询会叠加多个慢 wait 请求

轮询现改为单飞：上一次请求完成后才安排下一次，并对 timeout/error 回调做一次性保护。

## 二、仍待修复的新问题

### N-01 高：DNS rebinding 可读取本地 GET 数据

**证据：** `server/server.js:375-382` 在无 Origin/Referer 时视为本机，且只对非 GET 做全局来源校验；`server/server.js:388` 使用请求中的任意 Host 构造 URL，没有 Host allowlist。`server/routes/config.js:71-82`、`server/routes/mediaConfig.js:41-53` 等 GET 直接返回本地状态。

**复现：** 攻击域名先提供页面，随后把 DNS 解析切到 `127.0.0.1`；页面以该域名同源请求端口 4000。Host 仍是攻击域名，但后端不拒绝，响应可被该页面读取。会话列表和消息端点可进一步暴露聊天内容。

**建议：** 在 HTTP 与 upgrade 最前面校验 authority，只接受配置端口上的 `127.0.0.1`、`localhost`、`[::1]`；远程代理继续重写为明确的 loopback authority。敏感 GET 再使用不可由任意网页获得的会话令牌，且不要把“无来源头”直接等同于本机。

### N-02 高：终端 WebSocket 接受超大业务消息

**证据：** `server/routes/terminal.js:47` 未配置 `maxPayload`，`ws` 默认允许约 100 MiB；`server/routes/terminal.js:248-261` 对整帧转字符串并解析后，把 `m.text`、`m.d` 无类型/长度校验交给 PTY。真实 upgrade 通道已验证 2 MiB `send` 文本能完整到达 `ptyHost.submit`。

**建议：** WSS 设置不高于 HTTP 1 MiB 的硬上限；按消息类型验证 schema，给聊天文本与终端输入设置更小独立上限，拒绝 binary 和未知字段，超限关闭为 1009。

### N-03 高：PTY 到 WebSocket 没有背压，慢客户端可持续堆内存

**证据：** `server/routes/terminal.js:97-108` 对每个客户端直接 `ws.send(payload)`，不检查 `bufferedAmount`、无发送回调或队列上限。终端历史缓冲上限不能限制 WebSocket 内部发送队列。

**复现：** 已配对远端 attach 后限速或暂停读取，同时让终端持续输出；`bufferedAmount` 与进程内存会持续增长。

**建议：** 设置发送高水位；终端增量可在超限时丢弃并标记需要快照重同步，恢复后发送有界 `term-replay`；持续超限则以 1009/1013 断开。聊天事件使用独立的有界队列。

### N-04 中：合法的重复用户消息会被文本去重吞掉

**证据：** `web/src/hooks/useChatStream.js` 的轮询合并使用 `u:${text}` 作为用户消息唯一键。用户连续发送相同文本时，第二条会被当作第一条。

**建议：** 使用后端稳定消息 ID 或 `claudeMessageId`；乐观消息与落盘消息建立显式 client id 映射，不以文本作为身份。

### N-05 中：媒体提示词落盘失败后仍会继续生成并消费额度

**证据：** `web/src/components/ChatWindow.jsx:145-148` 对用户提示词落盘失败静默忽略，随后仍在 `:181-184` 发起生成；结果落盘失败也只保留本地显示（`:166-170`）。

**影响：** 刷新后对话缺失生成缘由或结果，但外部生成请求已经产生费用，审计链不完整。

**建议：** 提示词持久化成功后再开始计费生成；失败时明确告知并停止。结果落盘失败应标为可重试的持久化错误，而不是仅保留易失 UI 状态。

### N-06 中：切模型的 busy 检查存在 TOCTOU

**证据：** `server/routes/config.js:88-92`、`:126-130`、`:160-164` 先检查 busy，再异步读取请求体；等待 body 时可能有新任务启动，之后配置仍会写入并重启 PTY。

**建议：** 使用覆盖“检查—写配置—停旧进程—提交”的全局事务锁；启动新任务也必须经过同一把门闩。

### N-07 中：媒体配置锁文件在进程崩溃后不会恢复

**证据：** `server/lib/mediaConfig.js:12-29` 使用独占 `.lock` 文件，超过 2 秒只报错，没有 PID、创建时间、所有者验证或陈旧锁清理。

**建议：** 锁文件记录 PID/时间/随机 owner；确认进程不存在且超过阈值后原子接管。优先采用支持陈旧锁恢复的库或单进程写队列。

### N-08 中：会话路由只在构造时读取一次 currentModel

**证据：** `server/routes/sessions.js:207` 在 `sessionsHandler` 构造时捕获 `currentModel`，后续列表、分支和新建会话继续使用该旧值（`:215`、`:233`、`:261`）。运行中切模型后，新会话元数据可能与实际启动模型不一致。

**建议：** 每次需要默认模型时动态读取，或由 modelConfig 发布变更并更新单一状态源；增加运行中切换后新建会话的测试。

### N-09 中：macOS/Linux 的 PTY 停止路径实际依赖 Windows taskkill

**证据：** README 声明 macOS/Linux 可运行，但 `server/lib/ptyHost.js:90-100` 无条件启动 `taskkill` 并吞掉缺失命令的错误；force-stop、模式切换和空闲回收均依赖该路径。

**影响：** 非 Windows 上停止会超时，子进程继续存活，记录长期停在 stopping。

**建议：** 按 `process.platform` 分支：Windows 使用 taskkill，POSIX 对进程组先 SIGTERM、超时后 SIGKILL，并把失败显式上报。

### N-10 中：绿色包会条件性包含本机私有 `.build_local.env`

**证据：** `scripts/build-all.py:43-56` 把 `scripts/.build_local.env` 定义为本机私有配置，`.gitignore` 也忽略它；但 `scripts/green-pack.py:51`、`:135-136` 整树复制 scripts，ZIP 层只排除 `.log`。当前工作树没有该文件，因此尚未发生实际秘密泄露，但文件一旦存在就会被原文打包。

**建议：** scripts 使用文件 allowlist；copytree 与 ZIP 两层同时拒绝 `.build_local.env`、`.env`、`*.local`、缓存目录，并用哨兵秘密做打包回归测试。

### N-11 中：启动器把端口 4000 上任意 HTTP 服务当成 ClaudeNeko

**证据：** `start-web.bat`、`start-server.bat` 固定检查 4000，curl 未使用 `--fail` 或校验响应体；`launcher.html` 的 no-cors 探测也只要收到响应就判成功。真实测试中，一个在 4000 返回 404 `not ClaudeNeko` 的 dummy server 仍使原 curl 命令退出 0。

**建议：** 启动器统一读取 PORT；health 返回稳定 product marker/version，脚本严格校验状态和 marker。身份不匹配时报告端口冲突，不打开占位服务。

### N-12 中：媒体生成台账无限增长且每次全量读写/返回

**证据：** `server/lib/mediaGen.js:157-193` 每次读取整个文件、追加含完整 prompt 的记录、再全量重写；`server/routes/media.js:126-128` 每次返回全部记录，`softMax:5000` 只是提示而非硬限制。

**建议：** 同时设置数量、字节和年龄上限，限制单条 prompt；API 使用分页/游标和响应硬上限，必要时按日滚动或改用 SQLite。

## 三、已证实但不重复计数

1. 已配对远端可读取 `/api/media/log` 中全部会话的完整生成提示词。它是旧报告“跨模块 C：远程代理把请求伪装成本机”在新端点上的实例，因此不重复算新问题；修复时应把 `/api/media/log` 与 `/api/media/log-enabled` 纳入明确的远程能力策略。
2. 视频重启恢复使用当前凭据且缺少稳定 sid，会造成查询账户或回填归属不可靠。它与旧 02-10、02-11 的终态回填/重启恢复问题高度重叠，作为原问题的补充验收条件，不另计数。

## 四、建议顺序

1. 先修 N-01、N-02、N-03：它们位于本地信任边界和远程资源边界。
2. 再修 N-06、N-05、N-04：避免配置切换打断任务、计费操作失去审计记录和消息身份错误。
3. 随后修 N-10、N-09、N-11：封住发布物泄密和跨平台/启动可靠性。
4. 最后处理 N-07、N-08、N-12，并把媒体台账的保留策略写成产品级约束。

## 五、验证说明

- P1 修复的定向测试、全量测试、生产构建和差异检查结果记录在 `docs/权限P1稳健修复验证_20260906.md`。
- 本报告对 WS 2 MiB 入站和 4000 端口误识别做了实际复现；其余条目由可达代码路径和现有测试交叉验证。
- 审查期间未修改主工作树，未重启用户当前服务，未推送远程分支。
