# Root Cause Investigation - f6985212

## Bug Summary
`save_record` 工具缺少数据契约层（data contract），把 LLM 自由产生的 `data` 原样落盘，导致三类缺陷同时出现：字段结构随运行漂移（schema 不一致）、重跑同一站点时相同 url 被重复写入（无去重）、列表页无摘要时回填空字符串形成无效空值记录。根因是工具层既没有 schema 校验保证字段一致，也没有 `dedup_key` 去重，更没有空值过滤。

## Error Information, Affected files
- 缺陷 1 schema 漂移：src/tools.ts `save_record` 工具，parameters schema 是 `{data: unknown}` —— data 类型为 unknown，无任何字段约束；落盘前只做双重编码还原，不校验字段。
- 缺陷 2 重复落盘：src/tools.ts `save_record`，append 模式直接 `fs.appendFile`，无按 key 去重/upsert 逻辑。
- 缺陷 3 空值记录：src/agent.ts `SYSTEM_PROMPT` 未要求字段非空校验；src/tools.ts 接受空字符串字段落盘。
- 受影响文件：src/tools.ts（save_record）、src/agent.ts（systemPrompt 引导）

## Reproduction (Steps, Frequency, Environment)
- 步骤：`npm run crawl -- <url> "<任务A，字段X>"` 跑一批记录；再 `npm run crawl -- <同url> "<任务B，字段Y>"` 重跑；检查 output/records.jsonl。
- 频率：100% 可复现（任何重跑同 url 或换字段描述的抓取）。
- 环境：Node v22.23.1 / win32 / muse-spark-1.3-contributor。
- 实证：records.jsonl 38 行中 28 个唯一 url、10 个重复（各 2 次）；两批 schema 字段名不同（一批 `{author,date,summary,title,url}`，另一批 `{summary,time,title,url}`）；4 条 summary/time 为空。

## Root Cause, Evidence, Alternatives Ruled Out
- Root Cause：`save_record` 工具把 LLM 自由产生的 `data` 原样落盘，缺少"数据契约"——既没有 schema 校验保证字段一致，也没有 `dedup_key` 去重，更没有空值过滤。
- Evidence：src/tools.ts 的 `save_record` parameters 为 `{data: unknown, note?: string}`，execute 仅做 `JSON.parse` 还原 + `appendFile`；output/records.jsonl 实测 28 唯一/10 重复/schema 两套。
- Alternatives Ruled Out：
  - "LLM 不稳定导致" → 排除：根因是工具层无契约，即便 LLM 稳定，换 prompt 仍会漂移；且重复与 LLM 无关。
  - "pageToLLMView 提取不全导致空值" → 部分相关（头条区确实无摘要），但落盘空值记录本身应由契约层过滤或标注，故仍归为契约缺失。

## Data Flow Trace
agent 决定存一条记录 → 调用 `save_record(data=LLM自由构造的对象)` → execute: data 为字符串则 `JSON.parse` 还原 → `appendFile(output/records.jsonl)` → 完成。全程无 schema 校验、无 url 去重、无空值检查。
