---
id: DESIGN-e1f94248
title: "P1 取/懂/存 内核设计"
status: approved
req_ref: REQ-e1f94248
feat_ref: FEAT-e1f94248
created: 2026-10-15
---

# P1 取/懂/存 内核设计

## Overview

把现有 4 个工具重构为 3 个本质工具 `fetch` / `extract` / `save`，将策略差异（是否渲染、如何抽取、如何落盘）内化为工具参数，而非拆成更多工具；`save` 内建数据契约（schema 校验 / dedup 查重 / 全空过滤），使落盘阶段自带质量约束。设计追求「不求全面但求精细」，从第一性原理出发：抓取 agent 的本质动作只有三类——**取**（fetch）、**懂**（extract）、**存**（save）。

## Architecture

```
                cli.ts  (参数解析 / SIGINT / 事件流)
                   │
                   ▼
              agent.ts  (createCrawlerAgent, sessionId 注入, muse-spark-1.3-contributor)
                   │  tool calls
                   ▼
   ┌───────────────┼────────────────┐
   ▼               ▼                ▼
 fetch.ts       extract.ts        save.ts        ← 3 本质工具
   │               │                │
   │               │ (LLM 路径)     │ (records.jsonl)
   ▼               ▼                ▼
 page.ts       streamSimple      本地文件系统
 (fetchStatic/ (pi-ai 独立一次)   (双重编码还原)
  renderDynamic/
  pageToLLMView/
  extractLinks)
   ▲
   │
 config.ts (dotenv 集中配置)   errors.ts (AppError 体系)   ← 横切支撑
```

分层职责：`cli` → `agent` → 3 本质工具 → `page` 抓取层；`config` / `errors` 作为横切支撑贯穿各层。

## 工具接口契约

### 1. fetch

- **name**: `fetch`
- **parameters**:
  ```ts
  { url: string, render?: boolean }
  ```
- **行为**：
  - `render=false`（默认）走现有 `fetchStatic`。
  - `render=true` 走 `renderDynamic`。
  - 复用 `pageToLLMView` 生成 markdown，`markdown` 截断 12000 字符。
  - `links[]` 来自 `extractLinks`，供 agent 识别分页 / 详情链接。
  - 静态失败、或 agent 判断内容不足时，agent 改用 `render=true` 重取。
- **返回**:
  ```ts
  { url: string, status: number, markdown: string, links: string[] }
  ```

### 2. extract

- **name**: `extract`
- **parameters**:
  ```ts
  { content: string, instruction: string, selector?: string }
  ```
- **行为**：两条路径。
  - **确定性路径**（给了 `selector`）：对 `content`（HTML）用 cheerio 按 `selector` 提取文本 / 属性。
  - **LLM 路径**（没给 `selector`）：把 `content` + `instruction` 发给模型做语义抽取，返回结构化 JSON。
- **返回**：
  - LLM 路径 → `{ records: unknown[] }`
  - selector 路径 → `{ text: string[] }`

### 3. save

- **name**: `save`
- **parameters**:
  ```ts
  { data: unknown, schema?: string[], dedup_key?: string }
  ```
- **行为**（契约逻辑，此前探针已验证）：
  - `schema` 给了 → 校验 `data` 含全部字段（缺任一 → 拒绝返回）。
  - `dedup_key` 给了 → 查 `records.jsonl` 已有同 key 记录（重复 → 跳过返回）。
  - 内容字段（`schema` 中除 `dedup_key` 外）全空 → 过滤拒绝。
  - 保留现有双重编码还原。
- **返回**:
  ```ts
  { saved: boolean, reason?: string, count: number }
  ```

## 数据契约逻辑

`save` 按固定顺序执行校验，三条规则：

1. **schema 存在性校验**：当 `schema` 提供时，检查 `data` 是否包含 schema 中的全部字段；任一缺失即拒绝（`saved: false`，`reason` 指明缺失字段）。
2. **dedup 查重**：当 `dedup_key` 提供时，读取 `records.jsonl`，若已存在同 `dedup_key` 记录则跳过（`saved: false`，`reason: duplicate`）。
3. **全空过滤**：对内容字段进行全空判定。**全空判定排除 `dedup_key` 字段**——`url` 等字段是**标识**而非内容，标识存在不代表有实质内容。若所有内容字段均为空 → 过滤拒绝。

校验通过后才写入 `records.jsonl`（保留现有双重编码还原逻辑），返回 `saved: true` 与写入后的 `count`。

## extract 的 LLM 路径

使用**独立一次** `streamSimple` 调用，复用 agent 同款模型（muse-spark-1.3-contributor），把 `content`（按需截断）拼接 `instruction` 作为输入，模型输出 JSON 作为 `records`。关键约束：**用 pi-ai 直接调用，不经 agent loop**，以避免嵌套 agent 循环（工具在 agent 内部被调用，若再触发 agent loop 造成递归/嵌套）。

## 重构映射

| 现有 | 去向 |
| --- | --- |
| `fetch_page` | → `fetch` |
| `save_record` | → `save`（新增契约校验） |
| `list_saved` | 保留为辅助工具 |
| `finish` | 保留 |
| —（新增） | `extract` |

`page.ts` 整体复用不动（`fetchStatic` / `renderDynamic` / `closeBrowser` / `pageToLLMView` / `extractLinks`）。

## Error Handling

复用 `errors.ts` 现有 `AppError` 体系：

- `fetch` 失败：静态路径 → `FetchError`；动态路径 → `RenderError`。
- `extract` 的 LLM 路径失败 → `ModelError`。
- `save` 的契约拒绝不属于错误，以 `{ saved: false, reason }` 正常返回。

## Testing Strategy

**禁止 mock，使用真实 API。**

- **units**（`test/units.test.ts`）：
  - `pageToLLMView` / `extractLinks`
  - `save` 契约三条规则（schema 缺失、dedup 重复、全空过滤）
  - `extract` 的 selector 路径（cheerio 确定性抽取）
- **integration**（`test/integration.test.ts`）：
  - `fetch` 真实站点
  - `extract` 的 LLM 路径（真模型）
  - `save` 契约（真实文件读写）
  - 端到端 agent 用三工具抓真实站多页

`npm test` 须全绿。

## Out of Scope

- 元工具 / `forge_tool`
- Docker 沙箱
- 工具库（P2+）
- 深度反爬对抗
- 数据库持久化

## Open Questions

1. **extract 的 LLM 路径与主 agent 的 token 分担**：独立一次调用会额外消耗 token，其与主 agent loop 的预算如何分配 / 观测？
2. **契约过严是否影响探索灵活性**：`save` 的强制契约可能阻碍开放式探索，设计上契约字段均为可选启用（不传 `schema` / `dedup_key` 即不校验），需在真实抓取任务中验证该「可选启用」是否足够。
