# 模型请求静默挂起时界面没有任何提示（120 秒看门狗）

- 日期：2026-11-06
- 版本：SurfCore 0.8.8（待发布）
- 相关文件：`plugins/surfcore/lib/stall-watch.js`、`plugins/surfcore/lib/index.js`、`plugins/surfcore/lib/client.js`

## 现象

- 用户原话：「刚刚所有对话的 session 都卡住了，检查一下，先告诉我原因再解决」。
- 复现步骤（现场还原）：
  1. 在 F:\工作区 的会话（`9c4e1eb6`）里，17:25:34 发起的第 51 轮第 2 步请求，只收到一个 reasoning 片段就再无内容，静默 **111 秒**；
  2. 同一时段 QQ 桥接会话（`bd232661`）17:23:43 发起的请求，同样只回一个片段，静默 **224 秒**；
  3. 两个请求都停在「首 token 已到、正文不再来」的状态，直到 17:27:26 应用被重启并以 `aborted/disposed` 落盘。
- 影响面：**所有正在等模型回复的会话**看起来都卡死；用户唯一的出路是手动点「停止」或重启 DSH。同期另一个 agent 会话（`0f87fba3`）6 次模型调用全部 1–3 秒正常，说明不是进程/网络整体挂掉。

## 环境

- 系统：Windows 11，DSH Desktop 0.2.2-rc.1（Electron 44.7.0 / Node 24.21.0）
- SurfCore：0.8.8，link 安装（`F:\SurfCore\repo\plugins\surfcore`）
- 其它：模型 `deepseek-official / deepseek-flash`，`reasoningEffort: max`，直连（无代理）

## 根因

- 代码位置（文件:行）：
  - `dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`：`const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 3e5;`、`idleWatchdog(..., "MESSAGES_IDLE")`、`parseSse(body, activity)` 里 `EventSourceParserStream({ onComment: activity })`。
  - 本插件：`plugins/surfcore/lib/stall-watch.js`（新增前不存在），此前没有任何「正文是否还在增长」的判断。
- 问题链条：
  1. 服务端或链路在吐出第一个 delta 后停止发正文（原因在服务端侧，本地不可见）；
  2. DSH 判断「是否卡住」只看连接上还有没有数据包，**SSE 注释心跳也会 reset 计时器**（`onComment: activity` → `watchdog.pulse()`）；
  3. 于是默认 300 秒的 `MESSAGES_IDLE` 超时被心跳无限续命，请求既不报错也不结束；
  4. 流式期间 session 事件是静默的（只有最终 `assistant/message` 才落盘），UI 没有任何「正在等待第 N 秒」的反馈；
  5. 用户看到的就是「所有对话都卡住了」。
- 为什么之前没发现：日常请求 p50 只有 2.5–3.6 秒，从没构造过「心跳正常、正文不来」的场景；provider 层只测了「完全没数据」的超时分支，UI 层也没有「等待中」的独立状态。

## 完整逻辑（给用户看的那一遍）

- **链路**：模型流 → DSH `agent-loop` 每个 delta 发一帧 `agent/assistant-stream`（`start` / `chunk` / `end`）→ 本插件 `ctx.on('agent/assistant-stream', …)` 收到 `{ frame, agent }` → `stall-watch` 记录该 attempt 最后一次「正文增长」的时间 → 定时器每 5 秒检查一次 → `/dsh-surfcore/api/stall` 暴露快照 → 浏览器里的 `StallNotice` 每 5 秒轮询，超过 120 秒没有新帧就在右下角弹提示条。
- **机制**：判断标准从「连接上有没有包」换成「正文有没有新增」。只有 `type: "chunk"` 能刷新计时；工具阶段（`tool/call` 之后、`tool/result` 之前）整段跳过，所以跑 10 分钟的长命令不会误报。
- **爆炸半径**：1 个进程 × 1 个读者（使用者本人）× 静默=3 分；不碰用户数据、不碰密钥、不花钱。误报的成本只是一条可以关掉的提示。
- **取舍**：
  - 路线 A：检测到 120 秒无内容就**自动中止请求并重试**。收益是全自动，风险是误伤「长时间思考 / 正在准备大工具调用」的正常请求，而且中止会丢掉已生成的内容。
  - 路线 B：只提示、不动手（**采用**）。收益是零误伤、用户自己决定停不停；成本是需要人看一眼。
  - 之所以不做在 provider 层，是因为那层只能改全局配置（`streamIdleTimeoutMs`），且心跳续命的问题仍在；插件层能拿到逐帧信号，粒度更细。
- **生效与重启**：宿主侧 `lib/index.js` 改动由 DSH 热重载（`plugin.log` 出现「已激活」即生效）；**浏览器侧 `lib/client.js` 要刷新页面**才会重新加载。

## 修法

- 改了什么（关键片段）：
  - 新增 `lib/stall-watch.js`：`createStallWatch({ stallMs = 120_000, sampleMs = 5_000, … })`，内部维护 `attempts` / `sessions` / `stalls` 三张表；`trackStream` 吃帧、`noteSessionEvent` 记阶段、`tick` 判定、`snapshot` 出快照。
  - `lib/index.js`：导入并在 `apply()` 里 `ctx.on('agent/assistant-stream', …)` + `stallWatch.start()`；`session/event` 回调里补 `noteSessionEvent`；新增 `GET /dsh-surfcore/api/stall`（非 GET 返回 405 + `code: 'STALL_METHOD'` + `hint`）；`ctx.effect` 清理里 `dispose()`。
  - `lib/client.js`：`StallNotice` 组件注册到 `shell.overlay`（`id: "surfcore-stall"`），5 秒轮询、可关闭（10 分钟内不再弹同一条）、带「已经恢复」的收尾态。
  - 测试：`scripts/test-stall-watch.mjs`（假时钟，5 组场景）、`scripts/test-stall-notice.mjs`（React stub 渲染断言），并接进 `package.json` 的 `test` 链。
- 为什么选这个方案：不动 provider 全局配置、不改 DSH 本体，回滚只需删文件 + 去掉三处接线；提示条走 `shell.overlay` 是因为它在根作用域渲染，切会话/切面板都不会消失。
- 回滚方式：删除 `lib/stall-watch.js`，还原 `lib/index.js`（导入、`stallWatch` 三处、`/stall` 路由、清理）与 `lib/client.js`（`StallNotice`、`apply` 里那条 `slots.inject`），并从 `package.json` 的 `test` 链移除两行。

## 验证

- 自动化：
  - `node scripts/test-stall-watch.mjs` → 通过（119s 不报 / 121s 报且不重复 / 工具阶段不报 / 恢复后清记录 / QQ 与子代理跳过 / 脏数据不抛错）。
  - `node scripts/test-stall-notice.mjs` → 通过（注册到 `shell.overlay`、id 为 `surfcore-stall`、文案含「可能卡住了」、恢复态含「已经恢复」、无记录时不渲染）。
  - `node scripts/test-host-smoke.mjs` → `SMOKE OK`，`/dsh-surfcore/api/stall` 返回 `{ ok, stallMs, sampledAt, tracked, count, stalls }`。
  - `node scripts/test-client-contract.mjs` → `client contract tests OK`；三个文件 `node --check` 均通过。
- 失败路径（用户看到什么 / 下一步 / 失败分支断言）：接口非 GET 时返回 `405` + `code: 'STALL_METHOD'` + `hint: '刷新页面后重试'`；前端 `fetch` 失败静默（不打扰用户），`AbortSignal.timeout(8000)` 防挂死。
- 手工/集成验证：宿主热重载后 `plugin.log` 记录「已激活 v0.8.8」；直接 `curl http://127.0.0.1:54668/dsh-surfcore/api/stall` 被 GUI 鉴权拦成 **401**（这是预期，接口只在已登录页面里可用）。
- 没验证到的部分：**真实卡死场景没复现过**（下一次服务端再静默挂起时才能看到实际弹窗）；浏览器端只做了 stub 渲染测试，没在真页面里点过「关闭」。

## 遗留 / 后续

- 需要补的测试：真机上的端到端（真实 120 秒空窗）验证；提示条在窄窗口/移动端布局下的表现。
- 需要改的文档：本文 + `docs/cases/README.md` 已登记；`docs/CHANGELOG.md` 待随发布补。
- 可选加固：provider 层 `streamIdleTimeoutMs` 已在 profile 补丁里降到 90 秒（需重启 DSH 生效），可与本提示条并存。
