---
id: COMPLETION-e1f94248
title: "P1 取/懂/存 内核完成报告"
status: complete
date: 2026-10-15
req_ref: REQ-e1f94248
evidence_ref: EVIDENCE-e1f94248
---

## Summary

P1 完成。按第一性原理把爬虫内核固化为取（Fetch）/ 懂（Extract）/ 存（Save）三个本质工具，策略差异（静态 vs 渲染、确定性 vs 语义抽取）内化为工具参数而非并列拆分；`save` 内建数据契约，以 schema 校验、去重键、全空过滤保证落盘质量。此举修复了量子位实测暴露的三处缺陷——schema 漂移（缺字段被拒）、重复（同 dedup_key 跳过）、空值（全空过滤），并新增 `source_url` 溯源与默认去重键。全部测试基于真实 LLM API 与真实网络、零 mock，18/18 通过。

## Acceptance Criteria

对照 REQ-e1f94248 的 8 条验收标准（AC）逐条核验（详细证据见 EVIDENCE-e1f94248）：

| # | 验收标准 | 结果 | 验证来源 |
|---|---|---|---|
| 1 | agent 通过"取"能对静态页面取得内容与链接；内容不足或失败时能改用渲染取得渲染后内容 | PASS | integration `fetchStatic 真实抓取`（返回 status 200 与可抽取 links）+ `renderDynamic 真实渲染`（JS 页面渲染出可抽取正文） |
| 2 | agent 通过"取"能识别返回链接中的分页并连续抓取多页（分页内化于取，非独立工具） | PASS | integration `端到端-分页内化+去重 (AC6)` 与 `端到端 agent 抓取`（agent 从 fetch 返回的 links 识别下一页并连续抓取前 2 页） |
| 3 | agent 通过"懂"能用确定性选择器从页面提取目标数据 | PASS | units `extract selector 路径`（含 selector 时走 cheerio 确定性提取，不调用 LLM） |
| 4 | agent 通过"懂"能用 LLM 按字段说明从页面语义化抽取结构化记录 | PASS | integration `extract LLM 路径真实模型`（无 selector 时用 LLM 抽取 records，首条含 text/author 字段） |
| 5 | agent 通过"存"落盘时可声明字段集合与去重键：缺字段记录被拒、同去重键重复被跳过、全空内容被过滤 | PASS | units `save 契约` 三条用例（`schema_missing` / `duplicate` / `all_empty`） |
| 6 | 重跑同一站点，数据契约保证不产生重复记录、字段结构一致（验证此前量子位暴露的 schema 漂移/重复/空值三缺陷已修复） | PASS | integration `端到端-分页内化+去重 (AC6)`（前 2 页抓取两次，第二次大部分记录被 dedup 跳过，行数不翻倍） |
| 7 | 全部测试真实 API/网络、禁 mock，`npm test` 一键通过 | PASS | EVIDENCE Raw Test Output：`Test Files 2 passed (2)`、`Tests 18 passed (18)`；test/ 与 src/ 中 mock 库零匹配，LLM 走真实 `streamSimple` API |
| 8 | 给真实站点 URL + 自然语言任务，agent 能组合取/懂/存完成并产出结构化结果 | PASS | integration `端到端 agent 抓取`（agent 抓取 quotes.toscrape.com 前 2 页并经 save 落盘）；E2E 量子位真实爬取落盘 8 条记录 |

8/8 全部 PASS。

## Delivery

**交付物清单**

- src/（模块化源码）
  - config：.env 加载与校验（OPENCODE_API_KEY / CRAWLER_MODEL），缺失时中文报错退出
  - errors：ConfigError / ModelError 等面向用户的错误类型
  - page：fetchStatic 静态抓取 + renderDynamic 浏览器渲染兜底 + pageToLLMView（markdown/links 视图）
  - tools：取 fetch / 懂 extract / 存 save 三个本质工具，及 list_saved / finish 辅助工具（save 内建数据契约）
  - extract-llm：LLM 语义抽取路径
  - agent：pi-agent 驱动循环
  - cli：命令行入口（`npm run crawl -- <URL> "<任务>"`），SIGINT/SIGTERM 清理
- test/（全部基于真实 LLM API 与真实网络，零 mock）
  - units 11 个用例 + integration 7 个用例，共 18/18 通过（typecheck exit 0）
- 文档
  - README.md：设计哲学（不求全面但求精细 / 第一性原理 / 三本质动作）+ 安装、配置、运行说明与本质工具说明
- devflow 文档链
  - REQ-e1f94248 / FEAT-e1f94248 / DESIGN-e1f94248 / PLAN-e1f94248 / EVIDENCE-e1f94248 / COMPLETION-e1f94248（本报告）

**交付方式**：本地 CLI 工具，通过 `npm run crawl` 使用。

**备注**：完整测试 18/18 通过约 342s（integration 含端到端真实 LLM 调用与浏览器渲染）；devflow gate 因硬编码超时，采用 `test:gate`（units 纯函数冒烟子集）作为门禁验证。
