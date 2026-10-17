---
id: EVIDENCE-e1f94248
feature: FEAT-e1f94248
req_ref: REQ-e1f94248
date: 2026-10-15
status: passed
---

## Evidence Summary

- **总计**：total 18 / passed 18 / failed 0
- **typecheck**：exit 0（无输出）
- **端到端真实爬取**：量子位真实爬取落盘 8 条记录，`source_url` 去重生效

## Criterion Verification

对照 REQ-e1f94248 的 8 条验收标准（AC）逐条核验：

| AC | 验收标准 | 结果 | 验证来源 |
| --- | --- | --- | --- |
| AC1 | LLM 推理流式返回非空内容 | ✅ | `test/integration.test.ts` → 真实 LLM 推理 (streamSimple) → streams a non-empty reply for 'Reply with exactly: PONG' |
| AC2 | `fetchStatic` 真实抓取静态页并可抽取链接 | ✅ | `test/integration.test.ts` → fetchStatic 真实抓取 → fetches https://quotes.toscrape.com/ with status 200 and extractable links |
| AC3 | `renderDynamic` 真实渲染 JS 页面并可抽取内容 | ✅ | `test/integration.test.ts` → renderDynamic 真实渲染 → renders the JS page https://quotes.toscrape.com/js with extractable content |
| AC4 | 端到端 agent 抓取并经 `save` 落盘记录 | ✅ | `test/integration.test.ts` → 端到端 agent 抓取 → agent crawls first 2 pages of quotes.toscrape.com and saves records via save |
| AC5 | 无 selector 时走 LLM 抽取路径，首条含 text/author 字段 | ✅ | `test/integration.test.ts` → extract LLM 路径真实模型 → 无 selector 时用 LLM 抽取 records，首条含 text/author 字段 |
| AC6 | 分页内化 + 去重：重复抓取不使行数翻倍 | ✅ | `test/integration.test.ts` → 端到端-分页内化+去重 (AC6) → 抓取 quotes.toscrape.com 前2页两次：第二次大部分记录被 dedup 跳过，行数不翻倍 |
| AC7 | `save` 契约：同一 `dedup_key` 第二次跳过，文件仅一条 | ✅ | `test/integration.test.ts` → save 契约真实文件 → 真实调 save 两次同 dedup_key，第二次跳过，records.jsonl 只有一条 |
| AC8 | 单元层用例全绿 | ✅ | `test/units.test.ts`（11 tests）全部通过 |

## Key Fix

本次修复量子位（qbitai）抓取的三处缺陷：

- **根因**：`extract` 只产出 `text`/`author` 字段，`url` 依赖 LLM 自觉补进 `save` 调用；而 schema 包含 `url` 时被整体拒绝，导致下游 `ENOENT`（缺少可写入/去重所需的 URL）。
- **修法**：为 `save` 增加显式 `source_url` 参数，由 agent 显式传入；`source_url` 作为去重的默认键，并在 `data.url` 缺失时注入该值。

## Raw Test Output

```
> pi-crawler@0.1.0 test
> vitest run

 RUN  v5.0.4 E:/Demo/Agent/Crawler

 ✓ test/units.test.ts (11 tests) 168ms
 ✓ test/integration.test.ts (7 tests) 341614ms
   ✓ 真实 LLM 推理 (streamSimple)
     ✓ streams a non-empty reply for 'Reply with exactly: PONG' 4556ms
   ✓ fetchStatic 真实抓取
     ✓ fetches https://quotes.toscrape.com/ with status 200 and extractable links 1193ms
   ✓ renderDynamic 真实渲染
     ✓ renders the JS page https://quotes.toscrape.com/js with extractable content 3911ms
   ✓ 端到端 agent 抓取
     ✓ agent crawls first 2 pages of quotes.toscrape.com and saves records via save 139252ms
   ✓ extract LLM 路径真实模型
     ✓ 无 selector 时用 LLM 抽取 records，首条含 text/author 字段 4200ms
   ✓ save 契约真实文件
     ✓ 真实调 save 两次同 dedup_key，第二次跳过，records.jsonl 只有一条 2ms
   ✓ 端到端-分页内化+去重 (AC6)
     ✓ 抓取 quotes.toscrape.com 前2页两次：第二次大部分记录被 dedup 跳过，行数不翻倍 188497ms

 Test Files  2 passed (2)
      Tests  18 passed (18)
   Duration  342.24s
```

## Raw Typecheck Output

```
> tsc --noEmit
```

（exit 0，无输出）

## Raw E2E Output

量子位爬取尾部输出：

```
finish done:true
```

summary 表明：

- 识别 8 篇 URL 含 `/2026/` 的 `.html` 资讯文章
- 字段为 `title`/`url`/`summary`
- `source_url` 去重生效
- `list_saved` 确认 8 条记录存于 `output/records.jsonl`

## Environment

- Node v22.23.1 / win32
- 模型：muse-spark-1.3-contributor (OpenCode Go)
- 真实 API key，零 mock
- 测试含真实 LLM，故耗时 342s（devflow gate 使用 `test:gate` 冒烟子集）
