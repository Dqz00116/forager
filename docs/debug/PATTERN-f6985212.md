# Pattern Analysis - f6985212

## Comparison Dimensions
对比"能正常工作的数据流"与"出问题的数据流"：本项目中 quotes.toscrape.com 单次抓取能产出结构一致的数据（工作），而量子位多次重跑/换字段描述就出现 schema 漂移+重复（出问题）。

## Working vs Broken

| Aspect | Working | Broken | Assessment |
| --- | --- | --- | --- |
| 单次单字段抓取 | 字段一致无重复 | —— | 正常 |
| 多次重跑同 url | —— | 重复落盘 | 缺 dedup |
| 换字段描述 | —— | schema 漂移 | 缺 schema 约束 |
| 列表页无摘要区 | —— | 空值落盘 | 缺空值校验 |

## Dependency Changes
无外部依赖变化——缺陷由工具层设计缺失导致，非第三方库版本漂移。pi-ai/pi-agent-core v1.2.0 行为稳定。

## Historical Context
MVP 阶段（REQ-f6985212）刻意把 save_record 做成"自由落盘"以快速验证 agent 探索能力；数据契约（schema/去重）当时列为 Out of Scope。量子位真实站点测试首次暴露该缺失——这是 MVP 验证的价值所在，属设计阶段 deferred 项，非回归 bug。

## Identified Pattern
**"LLM 自由输出直接持久化，无契约层兜底"**：agent 的 LLM 输出本质是不可控结构（受 prompt 措辞、站点布局、模型自由发挥影响），直接落盘必然产生 schema 漂移与重复。这是 LLM-driven 数据管道的通用反模式。修复方向是在工具边界（save_record）引入契约：schema 校验 + dedup_key 去重 + 空值处理。

## Implications for Fix
- 在 save_record 工具增加可选参数：`schema`（字段名列表，校验 data 必含这些字段）与 `dedup_key`（如 url，落盘前检查 records.jsonl 已存在同 key 记录则跳过/更新）。
- agent systemPrompt 引导 LLM 统一使用契约字段、空值时不落盘或显式标注。
- 契约应是"可选但推荐"——保持 MVP 自由落盘能力向后兼容，传了 schema/dedup_key 才启用强约束。
- 测试：重跑量子位，验证同 url 不重复、字段一致、空值记录被处理。真实 API 禁 mock。
