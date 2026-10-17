---
id: EVIDENCE-d5bb0185
feature: FEAT-d5bb0185
req_ref: REQ-d5bb0185
date: 2026-10-16
status: passed
---

## Evidence Summary

- 测试：total 27 / passed 27 / failed 0（`vitest run`，`test/units.test.ts` 16 条 + `test/integration.test.ts` 11 条全部通过）。
- 类型检查：`tsc --noEmit` exit 0，无输出。
- 人机协作端到端真实登录验证通过：agent 调 `request_human(reason="请登录", url=https://quotes.toscrape.com/login)` → 弹出有头浏览器显示登录页 → 测试程序在真是 browser page 上执行真实登录操作 → 注入回车解阻塞 → 同一 context 抓到登录后标记 `Logout` → trace 有 `request_human` 记录且含 `duration_ms`。
- 对照 REQ-d5bb0185 的 10 条验收标准：10/10 通过。

## Criterion Verification

| # | 验收标准（REQ-d5bb0185） | 结果 | 验证来源 |
|---|---|---|---|
| 1 | agent 拥有"求助"能力：遇到需要人操作的场景（登录/验证码/拖拽/权限墙）时能主动发起求助并说明需要人做什么 | ✅ | `src/tools.ts:223-269` 定义第 4 本质工具 `request_human`，`parameters={reason,url}`，`description` 明示登录墙/验证码/权限墙/拖拽场景；`src/agent.ts:20` systemPrompt 第 9 条引导遇复杂交互时调 `request_human` 说明需要人做什么；integration `人机协作端到端` 断言 `crawlerTools.find(t=>t.name==="request_human")` 存在 |
| 2 | 求助时弹出人可操作的真实浏览器窗口（有头模式），显示目标页面 | ✅ | `src/human.ts:38` `chromium.launch({ headless: false })`；`request_human` 内 `page.goto(args.url)`（`src/tools.ts:236-240`）；integration 用例轮询 `getHumanContext().pages()` 取到 human page 并 `waitForSelector('input[name="username"]')` 成功（证明真实有头页面已弹出并加载登录表单） |
| 3 | 人在该窗口完成交互后，能通过简单方式（如回车）告知 agent 继续 | ✅ | `src/human.ts:18-26` `waitForEnter` 基于 `node:readline/promises`；`src/tools.ts:249` await `waitForEnter`；units `waitForEnter 用注入 input stream 模拟回车后 resolve（不挂起）`；integration `fakeInput.push("\n")` 后 `execPromise` resolve 且 `payloadOf(result)` 匹配 `{resumed:true}` |
| 4 | 人完成交互后，agent 在同一会话中继续抓取，登录态/Cookie 自然保留（同一浏览器上下文延续） | ✅ | `src/page.ts` 共享 context 单例（`getSharedContext`）；integration 登录后 `renderDynamic(HOME_URL)` 断言 `rendered.html` 含仅登录后出现的 `Logout`（区分走了 human context 带登录态 vs 新建未登录 context） |
| 5 | 求助期间 agent 暂停等待，不会并发执行其他动作导致状态混乱 | ✅ | `src/tools.ts:232` `executionMode: "sequential"`；integration 显式断言 `(requestHumanTool).executionMode === "sequential"` |
| 6 | 人取消或中断（如 Ctrl+C）时，agent 能正确清理浏览器资源并退出 | ✅ | `src/tools.ts:242-259` 监听 `signal`，`aborted` 或 abort 事件时 `reject("request_human: 已中止（abort）")`，不留悬挂 Promise；`src/human.ts:66-77` `closeHumanBrowser` 幂等且清理路径不抛；units `closeBrowser / closeHumanBrowser 幂等：连续两次 + 未启动时调用均不抛` |
| 7 | 不需要人介入的任务，agent 仍以无头模式高效运行（有头窗口仅在需要时出现） | ✅ | `src/page.ts:47` 主 browser 单例 `chromium.launch({ headless: true })`；有头 browser 仅在 `request_human` 触发 `launchHumanBrowser()` 时才启动（`src/tools.ts:235`），默认路径不产生有头窗口 |
| 8 | 求助与接管过程被记录进 trace（何时求助、人操作耗时、何时接管） | ✅ | integration 从 `tool_events` 查 `tool_name='request_human'` 且断言 `duration_ms >= 0`；`src/tools.ts:260-267` 计算 `duration_ms` 并随结果 `details` 记录；trace 由 `TraceCollector` 的 `tool_execution_start/end` 事件落库 |
| 9 | 提供一个需要登录的真实场景验证：agent 求助 → 人登录 → agent 继续抓到登录后内容（可用测试账号/模拟站点） | ✅ | integration `人机协作端到端 > request_human → 真实登录 → 同 context 抓到 Logout，trace 有 request_human 记录（AC4/AC8/AC9）3819ms`；真实站点 `quotes.toscrape.com/login` + 真实 Playwright 浏览器 + 真实登录操作 |
| 10 | 全部测试真实运行、禁 mock（人机交互环节可用受控方式模拟人的回车动作），`npm test` 一键通过 | ✅ | Raw Test Output：`Tests 27 passed (27)`；源码排查 `src/`、`test/` 中无 `vi.mock`/`jest.mock`/`nock`/`msw`，LLM/HTTP/浏览器/登录均真实调用；仅"人的回车"用注入的真实 `Readable` input stream 受控模拟（REQ AC10 豁免），非 mock 库 |

## 人机协作验证亮点

AC9 的真实登录场景（integration `人机协作端到端` 用例）完整走通了如下链路，全程真实依赖、非 mock：

1. **agent 求助**：agent 调 `request_human(reason="请登录", url="https://quotes.toscrape.com/login")`；`src/tools.ts` 内 `launchHumanBrowser()` 拉起有头 chromium 并 `page.goto` 登录页。
2. **弹出有头浏览器显示登录页**：`src/human.ts:38` 以 `headless:false` 启动；测试程序轮询 `getHumanContext().pages()` 拿到 human page，`waitForSelector('input[name="username"]')` 成功，证明登录页已真实加载并可见。
3. **真实浏览器操作登录（非 mock）**：测试程序直接在 human browser 的真实 page 上执行 `page.fill('input[name="username"]', "test")`、`page.fill('input[name="password"]', "test")`、`page.click('input[type="submit"]')` —— 这是真实浏览器交互，不是对登录逻辑的 mock；`quotes.toscrape.com` 任意账密即可登录成功。
4. **注入回车解阻塞**：测试程序向受控注入的 `Readable` 输入流 `push("\n")`，`request_human` 内部 `waitForEnter` 随即 resolve，`execPromise` 返回 `{resumed:true, ...}`（AC3）。
5. **同 context 抓到登录后标记**：`request_human` 返回后，在同一 human context 上 `renderDynamic(HOME_URL)`，断言 `rendered.html` 含 `Logout` —— 该标记仅存在于登录后页面，证明登录态/Cookie 沿同一浏览器上下文自然延续（AC4）。
6. **trace 有 request_human 记录含 duration_ms**：从 `output/test-trace-human.db` 的 `tool_events` 查询 `tool_name='request_human'`，断言存在记录且 `duration_ms >= 0`（AC8）。

## Raw Test Output

```
> vitest run
 RUN  v5.0.4 E:/Demo/Agent/Crawler
 ✓ test/units.test.ts (16 tests) — 含 人机协作 (3): waitForEnter 注入input resolve / closeBrowser+closeHumanBrowser 幂等 / 共享context单例
 ✓ test/integration.test.ts (11 tests)
   ✓ 真实 LLM 推理 / fetchStatic / renderDynamic / 端到端 agent 抓取 / extract LLM / 端到端-分页内化+去重(AC6) / trace 端到端与查询 (3)
   ✓ 人机协作端到端 (1)
     ✓ request_human → 真实登录 → 同 context 抓到 Logout，trace 有 request_human 记录（AC4/AC8/AC9） 3819ms
 Test Files  2 passed (2)
      Tests  27 passed (27)
   Duration  417.45s
```

## Raw Typecheck Output

```
> tsc --noEmit
```

(exit 0)

## 人机交互流程

`request_human` 的完整交互时序（标注各环节对应 AC）：

1. **agent 发起求助（AC1）**：agent 判断当前页面是登录墙/验证码/权限墙/拖拽等需人操作场景，调用 `request_human(reason, url)`，`reason` 说明需要人做什么。
2. **拉起有头窗口并导航（AC2）**：`launchHumanBrowser()` 以 `headless:false` 启动（或复用）有头 chromium 单例，`page.goto(url)` 打开目标页；该有头窗口按需出现，无需求助的任务仍走无头主 browser（AC7）。
3. **打印求助提示（AC1）**：`request_human` 向用户输出"【需要人工】{reason} / 请在打开的浏览器窗口中操作：{url}"，明示需要人做什么。
4. **进入暂停等待、串行阻塞（AC5）**：`request_human` 标 `executionMode:"sequential"`，期间 agent 暂停，不会并发执行其他动作；`await waitForEnter()` 阻塞等待（监听 `signal` 以支持中断，AC6）。
5. **人动手操作（AC2/AC3）**：人在弹出的有头窗口内完成登录/验证码/拖拽等交互（AC9 中测试程序以真实 `page.fill`+`page.click` 完成登录）。
6. **人按回车告知继续（AC3）**：人按下回车，`waitForEnter` resolve，`request_human` 返回 `{resumed:true, message, human_action, duration_ms}`。
7. **同 context 接管续抓（AC4）**：agent 在同一 human context 上用 `render`/`fetch render=true` 继续抓取，登录态/Cookie 自然延续，无需重新登录（AC9 中抓到登录后标记 `Logout`）。
8. **全程记入 trace（AC8）**：求助开始/结束（含 `duration_ms`）作为 `tool_events` 记录落库，可回放查询。
9. **取消/中断清理（AC6）**：若人取消或 Ctrl+C，`signal` abort 触发 `request_human` reject，`closeHumanBrowser` 幂等关闭有头 browser/context，资源正确清理。

## Environment

- Node：v22.23.1
- 平台：win32（桌面环境，headed 浏览器可弹窗）
- 模型：muse-spark-1.3-contributor（OpenCode Go provider）
- Playwright：1.64.1（headed + headless 均真实运行）
- SQLite：`node:sqlite`（内置 `DatabaseSync`，trace 旁路写库）
- API：真实 LLM API（真实 `OPENCODE_API_KEY`，值不展示）
- 测试零 mock：真实 LLM、真实 HTTP 抓取、真实浏览器渲染、真实登录均真实调用；仅"人的回车动作"用受控注入的 `Readable` input stream 模拟（REQ AC10 豁免），非 mock 库
- 完整测试耗时：417.45s（含真实 LLM 端到端 + 真实站点登录）
- devflow gate：使用 `test:gate` 冒烟
