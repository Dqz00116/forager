---
id: COMPLETION-680e823a
title: "request_human 轮询模式修复完成"
status: complete
date: 2026-10-16
req_ref: REQ-680e823a
evidence_ref: EVIDENCE-680e823a
---

## Summary

修复 `request_human` 后台死锁：把"人工已完成"的确认方式从"等回车"改为轮询页面客观状态（URL / 元素变化）。人完成后 agent 自动继续，无需回车；回车模式保留为 fallback。此举消除了后台 / 无 TTY 场景下因回车无法送达而导致的永久阻塞。

## Acceptance Criteria

对照 REQ-680e823a 的 4 条验收标准，逐条验证结果如下（详细证据见 EVIDENCE-680e823a）：

| # | 验收标准 | 结果 | 验证来源 |
|---|---|---|---|
| 1 | agent 求助后无需回车即可检测人已完成（轮询页面状态） | PASS | units 轮询 3 用例（gone_url_pattern / success_selector / 超时定时）；src/human.ts `waitForDone` |
| 2 | 后台 / 无 TTY 场景不死锁 | PASS | integration 轮询端到端（后台无 TTY，靠 URL 变化自动判定完成，`resumed=true` 且全程无回车） |
| 3 | 回车模式保留为 fallback | PASS | src/tools.ts `request_human` 保留回车分支（轮询为优先模式，回车为 fallback） |
| 4 | 全部测试真实运行禁 mock，`npm test` 通过 | PASS | EVIDENCE Raw Test Output：`Tests 31 passed (31)`；零 mock，真实 API / 真实网络 |

4/4 全部 PASS。

## Delivery

**交付物清单**

- `src/human.ts`：`waitForDone` —— 轮询检测页面客观状态（URL / 选择器变化），支持超时与 abort。
- `src/tools.ts`：`request_human` 轮询分支（`wait_mode='poll'`），回车模式保留为 fallback。
- `src/agent.ts`：systemPrompt 引导优先使用轮询模式。
- `test/`：全量 31/31 通过（units 19 + integration 12），真实 API、零 mock。
- devflow debug 文档链：ROOT-CAUSE / PATTERN / HYPOTHESIS / VERIFICATION / SUMMARY（`docs/debug/*-680e823a.md`）。
- 知乎实战验证：轮询检测登录成功自动继续，无需回车（对比修复前后台死锁）。

**备注**：本修复源自知乎实战，详见 `docs/debug/SUMMARY-680e823a.md`。
