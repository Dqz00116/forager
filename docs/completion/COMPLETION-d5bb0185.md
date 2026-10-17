---
id: COMPLETION-d5bb0185
title: "P3 人机协作完成报告"
status: complete
date: 2026-10-16
req_ref: REQ-d5bb0185
evidence_ref: EVIDENCE-d5bb0185
---

## Summary

P3 完成。为 agent 增加第 4 本质工具 `request_human`——遇登录、验证码、权限墙、拖拽等需要人操作的场景时主动求助并说明需要人做什么；求助时弹出有头浏览器窗口显示目标页，人完成操作后回 CLI 按回车，agent 在同一共享 context 中接管续抓（登录态/Cookie 自然保留）。不需要人介入的任务仍以无头模式高效运行，有头窗口按需出现；求助与接管全程记入 trace，人操作耗时以 `duration_ms` 落库可查。承认 agent 的能力边界，把人作为系统组件，人与 agent 协作完成此前无法完成的抓取。

## Acceptance Criteria

对照 REQ-d5bb0185 的 10 条验收标准（AC）逐条核验（详细证据见 EVIDENCE-d5bb0185）：

| # | 验收标准 | 结果 | 验证来源 |
|---|---|---|---|
| 1 | agent 拥有"求助"能力：遇到需要人操作的场景（登录/验证码/拖拽/权限墙）时能主动发起求助并说明需要人做什么 | PASS | `src/tools.ts` 定义第 4 本质工具 `request_human`（`parameters={reason,url}`，description 明示登录墙/验证码/权限墙/拖拽场景）；`src/agent.ts` systemPrompt 引导遇复杂交互时调 `request_human` 说明需要人做什么；integration `人机协作端到端` 断言该工具存在 |
| 2 | 求助时弹出人可操作的真实浏览器窗口（有头模式），显示目标页面 | PASS | `src/human.ts` `chromium.launch({ headless: false })`；`request_human` 内 `page.goto(args.url)`；integration 轮询 `getHumanContext().pages()` 取到 human page 并 `waitForSelector('input[name="username"]')` 成功 |
| 3 | 人在该窗口完成交互后，能通过简单方式（如回车）告知 agent 继续 | PASS | `src/human.ts` `waitForEnter` 基于 `node:readline/promises`；`src/tools.ts` await；units `waitForEnter 用注入 input stream 模拟回车后 resolve（不挂起）`；integration `fakeInput.push("\n")` 后 resolve 且匹配 `{resumed:true}` |
| 4 | 人完成交互后，agent 在同一会话中继续抓取，登录态/Cookie 自然保留（同一浏览器上下文延续） | PASS | `src/page.ts` 共享 context 单例（`getSharedContext`）；integration 登录后 `renderDynamic(HOME_URL)` 断言 `rendered.html` 含仅登录后出现的 `Logout` |
| 5 | 求助期间 agent 暂停等待，不会并发执行其他动作导致状态混乱 | PASS | `src/tools.ts` `executionMode: "sequential"`；integration 显式断言 `(requestHumanTool).executionMode === "sequential"` |
| 6 | 人取消或中断（如 Ctrl+C）时，agent 能正确清理浏览器资源并退出 | PASS | `src/tools.ts` 监听 `signal`，abort 时 reject 不留悬挂 Promise；`src/human.ts` `closeHumanBrowser` 幂等且清理路径不抛；units `closeBrowser / closeHumanBrowser 幂等：连续两次 + 未启动时调用均不抛` |
| 7 | 不需要人介入的任务，agent 仍以无头模式高效运行（有头窗口仅在需要时出现） | PASS | `src/page.ts` 主 browser 单例 `chromium.launch({ headless: true })`；有头 browser 仅在 `request_human` 触发 `launchHumanBrowser()` 时启动，默认路径不产生有头窗口 |
| 8 | 求助与接管过程被记录进 trace（何时求助、人操作耗时、何时接管） | PASS | integration 从 `tool_events` 查 `tool_name='request_human'` 且断言 `duration_ms >= 0`；`src/tools.ts` 计算 `duration_ms` 随结果 `details` 记录，由 `TraceCollector` 落库 |
| 9 | 提供一个需要登录的真实场景验证：agent 求助 → 人登录 → agent 继续抓到登录后内容（可用测试账号/模拟站点） | PASS | integration `人机协作端到端 > request_human → 真实登录 → 同 context 抓到 Logout，trace 有 request_human 记录（AC4/AC8/AC9）`；真实站点 `quotes.toscrape.com/login` + 真实 Playwright 浏览器 + 真实登录操作 |
| 10 | 全部测试真实运行、禁 mock（人机交互环节可用受控方式模拟人的回车动作），`npm test` 一键通过 | PASS | Raw Test Output：`Tests 27 passed (27)`；`src/`、`test/` 中无 `vi.mock`/`jest.mock`/`nock`/`msw`，仅"人的回车"用受控注入的真实 `Readable` input stream 模拟（AC10 豁免），非 mock 库 |

10/10 全部 PASS。

## Delivery

**交付物清单**

- src/（模块化源码）
  - human.ts：`launchHumanBrowser`（有头 chromium 单例，`headless:false`）/ `getHumanContext`（共享 context）/ `waitForEnter`（`node:readline/promises` 回车解阻塞）/ `closeHumanBrowser`（幂等清理）
  - page.ts：`getSharedContext`（共享 context 单例）/ `renderInContext` / human context 集成（求助后同 context 接管续抓）
  - tools.ts：第 4 本质工具 `request_human`（`executionMode:"sequential"`、abort 清理、`duration_ms` 记录）
  - agent.ts：systemPrompt 第 9 条引导遇复杂交互时求助
- test/（全部基于真实 LLM API 与真实网络，零 mock）
  - units 16 个用例 + integration 11 个用例，共 27/27 通过（`tsc --noEmit` exit 0）
- README.md：新增「人机协作 / Human-in-the-Loop」小节（设计哲学、第 4 本质工具、交互流程、按需有头、全程可观测）
- devflow 文档链
  - REQ-d5bb0185 / FEAT-d5bb0185 / DESIGN-d5bb0185 / PLAN-d5bb0185 / EVIDENCE-d5bb0185 / COMPLETION-d5bb0185（本报告）

**交付方式**：agent 自动求助——遇到需人场景时调 `request_human` 弹出有头窗口，人操作后回车，agent 同 context 接管续抓，全程记 trace。

**备注**：headed 浏览器需桌面环境，无显示时会降级；完整测试 27/27 通过耗时约 417s。
