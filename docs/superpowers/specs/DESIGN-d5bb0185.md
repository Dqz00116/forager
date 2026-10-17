---
id: DESIGN-d5bb0185
title: "P3 人机协作设计"
status: approved
req_ref: REQ-d5bb0185
feat_ref: FEAT-d5bb0185
created: 2026-10-16
---

# P3 人机协作设计

## Overview

新增第 4 本质工具 **request_human**：当 agent 撞上登录墙、验证码或权限墙时，把控制权交还给真人。`page.ts` 由"纯无头"改造为**支持按需有头 + 共享 context**——`request_human` 拉起一个可见的 chromium 窗口让真人操作（登录/过验证码），人机交接通过 CLI 的 **等回车**（readline）完成；真人操作后的**同一个 context 被保留**，agent 随后用 render/fetch 继续抓取时自动带上已登录的 sessionStorage/cookie/DOM，无需重登。全程照旧记入 trace。

## Architecture

```
                      agent (pi-agent-core)
                            │  遇登录/验证码/权限墙
                            ▼
                  ┌───────────────────────┐
                  │  request_human 工具   │  executionMode:"sequential"
                  │  {reason, url}        │  （防并发，见调研结论）
                  └───────────┬───────────┘
                              │
                              ▼
            ┌────────────────────────────────────┐
            │  HumanBrowser (page.ts 有头单例)   │
            │  launchHumanBrowser() →            │
            │   browser + 共享 context + page    │
            └───────────┬────────────────────────┘
                        │
                        ▼
            弹出可见窗口，page.goto(url) 定位到目标页
                        │
                        ▼
            ┌────────────────────────────────────┐
            │  CLI 等回车（human.ts）            │
            │  waitForEnter("完成后按回车…")     │   ← readline/promises
            │  （tool execute await 该 Promise， │     内部无限期阻塞，合法）
            │   人类在窗口里登录/过验证码）      │
            └───────────┬────────────────────────┘
                        │ 人按下回车
                        ▼
            同一 context 继续 render/fetch
            （登录态/sessionStorage/DOM 全部保留）
```

## 核心改造 1：page.ts 共享 context + 按需有头

现状：`browser` 为进程级单例（`getBrowser` 懒加载，`headless:true` 硬编码 `:43`）；`renderDynamic` 每次 `newContext`（`:73`）并在 `finally` 关闭（`:90-92`）；`closeBrowser` 于 `:49-59`。

改造要点：

- 把 browser 单例扩为**可管两个 browser**：
  - **主 browser**：默认 headless，现有逻辑不变，供 `renderDynamic` 使用。
  - **有头 browser**：仅 `request_human` 时启动（`headless:false`），供真人操作。
  - 二者独立，避免互相污染；`headless` 不能 launch 后热切（需新 browser），因此必须分开（见调研结论）。
- **关键：共享 context 单例**。新增 `getSharedContext(browser)`——同一 browser 下复用同一个 `BrowserContext`，不再每次新建+关闭。`renderDynamic` 增加可选参数复用一个"共享 context"，用于**人登录后的延续抓取**。
- 新增 `launchHumanBrowser(): Promise<{ browser, context, page }>`——以 `headless:false` 启动，返回**持久 context + page** 供人操作（不随函数返回而关闭）。
- 新增 `renderInContext(context, url)`——在**指定 context**（真人登录后的那个）里渲染，保留登录态。
- `closeBrowser` 扩展为清理**两个 browser + 共享 context**（幂等，未启动过为空操作，保持现有"清理路径不抛"语义）。

预期接口形态：

```ts
// 主 browser（现状）
function getBrowser(): Promise<Browser>;

// 共享 context 单例（人登录态延续的核心）
function getSharedContext(browser: Browser): Promise<BrowserContext>;

// 有头 browser：仅 request_human 时启动
export function launchHumanBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }>;

// 在指定 context 中渲染（登录态保留）
export async function renderInContext(context: BrowserContext, url: string): Promise<RenderedPage>;

// renderDynamic 增加可选 context 参数，缺省行为与现状一致
export async function renderDynamic(url: string, context?: BrowserContext): Promise<RenderedPage>;

// 清理两个 browser + 共享 context
export async function closeBrowser(): Promise<void>;
```

## 核心改造 2：request_human 工具（tools.ts）

- parameters：`{ reason: string, url: string }`
  - `reason`：说明需要人做什么（如"请登录"、"请输入验证码"、"请完成权限授权"）。
  - `url`：要人操作的页面。
- execute：
  - **必须标 `executionMode:"sequential"`**——默认 `toolExecution="parallel"`，不标会并发（见调研结论）。
  - 流程：`launchHumanBrowser()`（若未启动）→ `page.goto(url)` → CLI 打印 `【需要人工】{reason}，完成后请按回车…` → `await waitForEnter()`（readline `question()`）→ 返回 `{ resumed: true, message: "人工已完成，可继续" }`。
  - 监听 signal；**abort 时 reject**（不留悬挂 Promise）。

新建 `src/human.ts`：

- `waitForEnter(prompt)`：基于 `node:readline/promises` 的 `createInterface` + `question()`；stdin 空闲可用（见调研结论）。tool execute 是 async 且 pi-agent-core 无超时，可 await 该 Promise **无限期阻塞**（合法）。
- 管理 human browser 单例的**启动 / 复用 / 关闭**。

## 核心改造 3：人操作后 agent 续抓

`request_human` 返回后，agent 后续用 render/fetch 时应复用"真人登录的 context"。

设计：`human.ts` 导出 **`getHumanContext()`**；`renderDynamic` / `fetch` 的 render 路径在**存在 human context 时优先用它**，使登录态自动保留——agent 无需知道登录细节，按原方式调 `fetch render=true` 即可拿到登录后的内容。

`systemPrompt` 增加引导：遇登录 / 验证码 / 权限墙时调 `request_human`，人完成后用 `render` 继续（会自动带上登录态）。

## trace 集成

`request_human` 是普通工具，其 execute 的 `start/end`（含 `duration_ms = 人操作耗时`）**自动**进 `trace.tool_events`，无需额外埋点。额外在 `result.details` 记 `{ human_action: reason, duration_ms }`，便于事后分析"哪个 URL 需要人工介入、人了多久"。

## Error Handling

- human browser 启动失败 → 抛 `RenderError`（沿用现有 `errors.ts`）。
- readline 失败 → 提示并允许 agent 重试。
- abort → 清理 human browser / context，reject 悬挂的 `waitForEnter`。

## Testing Strategy

**禁 mock，真实运行。**

- **units**：
  - `waitForEnter` 用**注入的模拟 stdin**验证（注入 input stream、向其中写入换行触发"回车"，非 mock 库）。
  - `page.ts` 共享 context 单例逻辑（同一 browser 多次调用返回同一 context）。
- **integration**：真实场景——`request_human` 在受控测试里用**"自动回车"**（提前向 stdin 写入换行，或注入 fake input）模拟人完成，验证 agent **求助 → 继续 → 同 context 拿到内容**。
- **真实人工验证（可选手动）**：起一个需登录的演示页，人在窗口登录后回车，验证续抓带登录态。
- `npm test` 全绿（test:gate 通过）。

## Out of Scope

- 自适应造工具 / Docker（后续）。
- 自动验证码识别（**人来做**）。
- 跨运行的登录态持久化（`storageState` 落盘，后续可加）。
- 远程 / CDP 浏览器。

## Open Questions

- headed 窗口在 CI / 无显示环境不可用——降级为"提示人工在线下操作"。
- 多请求助时 human context **复用 vs 新建**。

## 调研依据

- `headless` 不能 launch 后热切（需新 browser）；Windows 上 `headless:false` 可弹出可见窗口。
- 同一运行人机交接用**"共享长期 context"最简**（登录态 / sessionStorage / DOM 全保留）。
- tool execute 是 async，且 pi-agent-core 无超时，可 await "等回车"的 Promise **无限期阻塞**（合法）。
- 默认 `toolExecution="parallel"`，`request_human` **必须标 `executionMode:"sequential"`** 防并发。
- 等回车用 `node:readline/promises` 的 `createInterface` + `question()`；stdin 空闲可用。
- Playwright 1.64.1。
