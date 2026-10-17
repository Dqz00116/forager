---
id: PLAN-d5bb0185
title: "P3 人机协作实施计划"
status: approved
req_ref: REQ-d5bb0185
design_ref: DESIGN-d5bb0185
created: 2026-10-16
---

# P3 人机协作实施计划

## Goal

给 agent 增加第 4 个本质工具 **request_human**：遇到登录、验证码、权限墙时拉起有头浏览器交给人操作，人按回车告知继续后，agent 在同一共享 context（登录态保留）中接管续抓，全程记入 trace。

## Tasks

### T1 page.ts 改造共享 context

- **做什么**：
  - 在现有 browser 单例（`getBrowser`，`headless:true` 硬编码于 `:43`）之外，新增**共享 context 单例** `getSharedContext(browser)`——同一 browser 下复用同一个 `BrowserContext`，不再每次新建+关闭。
  - `renderDynamic(url, context?)` 增加可选 `context` 参数：传入时复用该 context（不新建、不关闭）；不传时保持现状（每次 `newContext` + `finally` 关闭）。**必须保证现有无参 `renderDynamic` 行为字节级兼容**（集成测试的 renderDynamic 用例不能破）。
  - 新增 `renderInContext(context, url): Promise<RenderedPage>`——在指定 context 中渲染，用于人登录后的延续抓取。
  - `closeBrowser()`（`:49-59`）扩展为清理**主 browser + 共享 context + 有头 browser**，保持幂等（未启动过为空操作、清理路径不抛）的现有语义。
- **文件**：`src/page.ts`
- **验证**：`npm run typecheck` 通过；无参 `renderDynamic` 现有集成测试用例仍通过。

### T2 新建 src/human.ts

- **做什么**：
  - `launchHumanBrowser()`：`chromium.launch({ headless:false })` 启动有头 `browser` + 持久 `context` + `page`，**单例复用**（重复调用返回同一套），不随函数返回而关闭。
  - `getHumanContext()`：返回人登录后的 context（供 T4 续抓），未启动时返回 `undefined`。
  - `waitForEnter(prompt, input?)`：基于 `node:readline/promises` 的 `createInterface` + `question()`；`input` 可注入（默认 `process.stdin`），便于测试注入模拟输入流。
  - `closeHumanBrowser()`：关闭有头 browser/context，幂等、清理路径不抛。
  - **归属统一在 `src/human.ts`**：`launchHumanBrowser` / `getHumanContext` / `closeHumanBrowser` 三者都定义在 `src/human.ts`；`page.ts` 通过 `import ... from "./human.ts"` 使用它们，依赖方向固定为 **page → human**，以避免 page 与 human 之间的循环依赖。
- **文件**：`src/human.ts`（新建）
- **验证**：`npm run typecheck` 通过；`waitForEnter` 可被注入 input stream 驱动；`launchHumanBrowser` / `getHumanContext` / `closeHumanBrowser` 均从 `src/human.ts` 导出。

### T3 tools.ts 加 request_human 工具

- **做什么**：
  - 新增第 4 本质工具 `request_human`，`parameters: { reason, url }`。
  - **必须标 `executionMode:"sequential"`**——防止默认并行导致并发执行、状态混乱。
  - `execute`：`launchHumanBrowser()`（未启动则启动）→ `page.goto(url)` → 用 **stderr** 打印 `【需要人工】{reason}，完成后请按回车…` → `await waitForEnter()` → 返回 `{ resumed:true, message:"人工已完成，可继续" }`。
  - 监听 `signal`；**abort 时 reject**（不留悬挂 Promise）。
  - `result.details` 记 `{ human_action: reason, duration_ms }`。
- **文件**：`src/tools.ts`
- **验证**：`npm run typecheck` 通过；`request_human` 在 `crawlerTools` 中且带 `executionMode:"sequential"`。

### T4 page.ts render 路径集成 human context

- **做什么**：`renderDynamic` / `fetch`（`render=true`）的渲染路径在 `getHumanContext()` **存在时优先复用它**，使登录态自动延续——agent 无需知道登录细节，按原方式调 `fetch render=true` 即可拿到登录后内容。
- **文件**：`src/page.ts`（与 T1 同文件，注意与 T1 改动协同）
- **验证**：存在 human context 时渲染走该 context；不存在时行为与现状一致。

### T5 agent.ts systemPrompt 引导

- **做什么**：`createCrawlerAgent` 的 systemPrompt 增加引导——遇**登录 / 验证码 / 权限墙 / 拖拽等复杂交互**时调 `request_human`，说明需要人做什么；人完成后用 `render` 继续（自动带登录态）。
- **文件**：`src/agent.ts`
- **验证**：`npm run typecheck` 通过；systemPrompt 含求助引导文案。

### T6 units 测试

- **做什么**：
  - `waitForEnter` 用**注入的模拟 input stream**（`Readable`，向其中写入换行触发"回车"）验证 resolve 返回。
  - `getSharedContext` 单例复用：同一 browser 多次调用返回同一 context 实例。
  - 清理路径幂等：`closeHumanBrowser` / `closeBrowser` **连续两次调用不抛**，且**未启动时为空操作**（不抛、无副作用）。
  - 不破坏现有 13 用例（pageToLLMView 3 + extractLinks 2 + save 双重编码 1 + config 1 + save 契约 3 + extract selector 1 + trace 2）。
- **文件**：`test/units.test.ts`
- **验证**：`npm test` 新用例 + 现有 13 用例全通过。

### T7 integration 测试

- **做什么**：用**带登录墙的真实公开测试站** `quotes.toscrape.com/login` 做端到端验证（该站任意用户名/密码都能登录成功，登录后跳转首页并显示 "Logout" 链接），真正覆盖 AC9 的"真实登录场景"：
  - agent 调 `request_human(reason:"请登录", url:"quotes.toscrape.com/login")`；
  - 测试程序在 **human browser 的真实 page/context** 里执行**真实登录操作**——`page.fill` 填用户名密码 + click 登录按钮，这是**真实浏览器操作而非 mock**，完成后向注入的 stdin 写入换行触发回车；
  - agent 在**同一 context** 继续用 `render` 抓取；
  - **端到端断言**：拿到的内容含**仅存在于 human context 登录后的标记**（如 "Logout" 文本），用以区分"确实走了 human context 并带登录态" vs "新建了 context（未登录）"。
  - trace 里 `request_human` 工具有记录，含 `duration_ms`。
  - 真实浏览器 headed 在无显示环境需**降级**（判断可用性跳过，或改 headless 模拟）。
- **文件**：`test/integration.test.ts`
- **验证**：`npm test` 该用例通过（有显示环境真实打开 headed、在 `quotes.toscrape.com/login` 完成真实登录、同 context 抓到登录后内容；无显示时降级），且断言内容含登录后标记 "Logout"。

### T8 README + 最终验证

- **做什么**：README 加人机协作（request_human 用法与登录态延续）说明。
- **文件**：`README.md`
- **验证**：`npm run typecheck` + `npm test` 全绿。

## AC Mapping

| AC | 描述 | 对应任务 |
| --- | --- | --- |
| AC1 | agent 拥有"求助"能力，遇登录/验证码/拖拽/权限墙主动求助并说明需要人做什么 | T3、T5 |
| AC2 | 求助时弹出人可操作的真实浏览器窗口（有头模式）显示目标页 | T2、T3 |
| AC3 | 人完成交互后能通过简单方式（回车）告知 agent 继续 | T2、T3 |
| AC4 | 人完成后 agent 同会话继续抓取，登录态/Cookie 保留（同 context 延续） | T1、T4 |
| AC5 | 求助期间 agent 暂停等待，不并发其他动作 | T3 |
| AC6 | 人取消/中断（Ctrl+C）时正确清理浏览器资源并退出 | T1、T2 |
| AC7 | 不需要人介入的任务仍以无头模式高效运行（有头仅按需出现） | T1 |
| AC8 | 求助与接管过程被记入 trace（何时求助、耗时、何时接管） | T3 |
| AC9 | 提供需要登录的真实场景验证：求助 → 登录 → 继续抓到登录后内容 | T7 |
| AC10 | 全部测试真实运行、禁 mock，npm test 一键通过 | T6、T7、T8 |

## Test Strategy

- **禁 mock，真实运行**：unit / integration 均跑真实代码；不引入 mock 库。
- **人的回车用注入 input stream 受控模拟**（非 mock 库）：`waitForEnter` 接受可注入的 input stream，测试向其中写入换行触发"回车"。
- **headed 浏览器降级**：真实有头浏览器在 CI / 无显示环境不可用，判断可用性后跳过或改 headless 模拟，避免测试挂死。
- `npm test` = `vitest run`；trace 断言读实际落库数据（含 `request_human` 的 `duration_ms`）。

## Risks

- **headed 窗口依赖桌面环境**：无显示 / CI 环境无法弹出窗口 → 降级为提示人工在线下操作，并跳过该用例。
- **readline 与 agent stdout 交织**：等回车提示与 agent 输出混在一起 → `request_human` 提示统一走 **stderr**，避免污染 stdout 结果流。
- **并发工具调用**：默认 `toolExecution="parallel"` 可能与等回车冲突 → `request_human` 标 `executionMode:"sequential"` 缓解。
