---
id: COMPLETION-d53c7143
title: "P2 全量 trace 可观测性完成报告"
status: complete
date: 2026-10-16
req_ref: REQ-d53c7143
evidence_ref: EVIDENCE-d53c7143
---

## Summary

P2 完成。为每一次 crawl 记录全量 trace——完整的 LLM prompt / response 与每一次工具调用（args / 结果 / 耗时 / 是否落盘）——并持久化到 `node:sqlite`（Node 内置，零新增依赖）。记录走旁路异步落盘，任一步失败只 `console.warn`，绝不影响抓取主流程。trace 支持按运行回放与行为模式查询（如 `--pattern extract-no-save`），使 agent 的执行过程完全可观测：行为可见、根因可证。此前"extract 后无 save"、"records.jsonl 被清空"两个悬案均由 trace 实据直接解答。

## Acceptance Criteria

对照 REQ-d53c7143 的 9 条验收标准（AC）逐条核验（详细证据见 EVIDENCE-d53c7143）：

| # | 验收标准 | 结果 | 验证来源 |
|---|---|---|---|
| 1 | 每次 crawl 运行产生一条独立的运行记录，包含入口 URL、任务描述、开始/结束时间、最终状态 | PASS | units `trace 记录 > runs / llm_events / tool_events 三表写入且字段完整`（断言 run 行含 url/task/status）；`src/trace.ts` 的 `TraceCollector.start()` / `close()` 负责 INSERT / UPDATE runs 行 |
| 2 | 运行过程中的每次 LLM 交互被记录，含完整 prompt 与完整 response（全量，不截断决策依据） | PASS | units 三表断言 `llm_events.direction` 同时含 `prompt` 与 `response`；实测 run-mvaovhqn-1wp3m0 的 `llm_events` 有 14 条 prompt/response 成对记录，payload 全量存于 `payload_json`，未截断 |
| 3 | 运行过程中的每次工具调用被记录，含工具名、输入参数、输出结果/错误、耗时、是否导致落盘 | PASS | units `tool_call_id 关联且 save 调用 saved=1、非 save 调用 saved 为 0 或 NULL`；Raw Trace Replay 逐行含 `tool_name/args_json/result_json/is_error/duration_ms/saved` |
| 4 | trace 数据持久化到 SQLite，跨运行保留、可按运行/工具/时间查询 | PASS | `output/trace.db` 实测跨运行保留多条 run；`src/trace-query.ts` 的 `listRuns()` 按 `started_at` 排序并支持 `--since`，`replayRun()` 按 run 回放；integration `端到端 crawl 后可读 trace.db 并按 turn 回放` |
| 5 | 提供查询能力：能查出"哪些运行中 extract 有产出但没有后续 save"这类行为模式 | PASS | integration `extract-no-save 查询能返回『只 extract 未 save』的 run_id`（断言 stdout 含 run_id）；`src/trace-query.ts` 的 `findExtractNoSave()`（extract 条数>0 且同 run 无 `save`+`saved=1`） |
| 6 | trace 记录不影响 crawl 主流程：记录失败不导致抓取失败（可观测性旁路） | PASS | integration `TraceStore 初始化失败时抓取仍正常完成（旁路降级，不抛错）`（不可写 db 路径下不抛且仍落盘）；`src/trace.ts` 全部写库走 try/catch + `console.warn`，不抛 |
| 7 | CLI 结束时打印本次 trace 标识与查询入口 | PASS | `src/cli.ts:102-105` 打印 `trace：output/trace.db`、`run_id：<runId>`、`查询：npm run trace -- <runId>` |
| 8 | 通过 trace 能直接回答此前的两个悬案：(a) GitHub Trending 为何 extract 后无 save；(b) records.jsonl 是否被 crawl 流程清空 | PASS | 见 EVIDENCE-d53c7143「AC8 悬案解答」：由 `runs`/`llm_events`/`tool_events` 实据直接回答（(a) 首个 LLM 调用 403 失败致 agent 未进入工具阶段；(b) crawl 只 append，删除来自测试 `rm` 清理） |
| 9 | 全部测试真实运行、禁 mock，npm test 一键通过 | PASS | Raw Test Output：`Test Files 2 passed (2)`、`Tests 23 passed (23)`；`src/`、`test/` 中 `vi.mock`/`jest.mock`/`nock`/`msw` 零匹配 |

9/9 全部 PASS。

## Delivery

**交付物清单**

- src/（模块化源码）
  - trace.ts：`TraceStore`（封装 `node:sqlite` `DatabaseSync`，三表 + 索引 + WAL，初始化失败静默降级）+ `TraceCollector`（挂载 agent，收集 LLM prompt/response 与工具调用，批量旁路落盘）
  - trace-query.ts：trace 查询 CLI（`runs` 列表 / `run <id>` 回放 / `--pattern extract-no-save` / `--db <path>`）
  - agent.ts / cli.ts：接入 `TraceCollector`（agent 绑定采集，cli 登记 run、结束时打印标识与查询入口）
- test/（全部基于真实 LLM API 与真实网络，零 mock）
  - units 13 个用例 + integration 10 个用例，共 23/23 通过（`tsc --noEmit` exit 0）
- README.md：新增「可观测性 / Trace」小节（trace 内容与查询命令）
- devflow 文档链
  - REQ-d53c7143 / FEAT-d53c7143 / DESIGN-d53c7143 / PLAN-d53c7143 / EVIDENCE-d53c7143 / COMPLETION-d53c7143（本报告）

**交付方式**：`npm run crawl` 自动带 trace（落盘 `output/trace.db`），`npm run trace` 查询。

**备注**：零新增依赖（SQLite 使用 Node 内置 `node:sqlite`）；完整测试 23/23 通过耗时约 483s；devflow gate 采用 `test:gate`（units 冒烟子集）。
