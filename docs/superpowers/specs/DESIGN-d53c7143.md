---
id: DESIGN-d53c7143
title: "P2 全量 trace 可观测性设计"
status: approved
req_ref: REQ-d53c7143
feat_ref: FEAT-d53c7143
created: 2026-10-16
---

# P2 全量 trace 可观测性设计

## Overview

为每一次 crawl 运行记录**全量 trace**——真正发往 LLM 的 prompt、LLM 完整 response、以及每一次工具调用的 args/result——落盘到 SQLite。所有埋点走**旁路异步**：listener 收到数据后仅深拷贝进内存缓冲，绝不在主流程里同步做 IO，从而不拖慢抓取。trace 落盘后支持**回放**（按 run 复原完整事件流）与**行为查询**（按模式定位异常运行，例如"extract 有产出但后续无 save"），为 REQ-d53c7143 / FEAT-d53c7143 的 AC8 两个悬案提供可回答的数据基础。

## Architecture

```
              cli.ts / agent.ts
                     │
                     ▼
        ┌─────────────────────────────┐
        │        TraceCollector        │
        │  attach(agent):              │
        │   · agent.subscribe(...)     │  事件埋点
        │     - agent_start/turn_start │   → turn 归属
        │     - message_end(assistant) │   → 完整 response
        │     - tool_execution_*       │   → args/result/duration
        │   · new Agent({onPayload})   │  完整 prompt
        └──────────────┬──────────────┘
                       │ 深拷贝(structuredClone/JSON)
                       ▼
              ┌──────────────────┐
              │   内存缓冲 buffer  │  轻量、不阻塞主流程
              └────────┬─────────┘
                       │ 批量异步 flush
                       ▼
              ┌──────────────────┐
              │  异步 writer      │
              └────────┬─────────┘
                       ▼
            output/trace.db (SQLite)

              ┌──────────────────┐
              │    TraceQuery     │  ──read──▶ trace.db
              │ (trace-query.ts)  │
              └──────────────────┘
```

## 数据模型

SQLite schema（`output/trace.db`）。三张表：一次运行一行 `runs`，LLM 交互一行一条 `llm_events`，每次工具调用一行一条 `tool_events`。

### `runs` 表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | run_id（如 `d53c7143`） |
| `url` | TEXT | 入口 URL |
| `task` | TEXT | 抓取任务描述 |
| `started_at` | INTEGER | 开始时间戳（ms） |
| `ended_at` | INTEGER | 结束时间戳（ms） |
| `status` | TEXT | `ok` / `error` / `aborted` |
| `records_saved` | INTEGER | 落盘记录数（来自 list_saved / finish） |
| `duration_ms` | INTEGER | 总耗时 |

### `llm_events` 表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | 主键 |
| `run_id` | TEXT FK | 关联 `runs.id` |
| `turn` | INTEGER | 所属 turn（从 0 递增） |
| `direction` | TEXT | `prompt` / `response` |
| `payload_json` | TEXT | 完整 prompt（system+history+tools）或完整 response |
| `model` | TEXT | 模型 ID |
| `usage_json` | TEXT | token usage（input/output 等，来自 response） |
| `created_at` | INTEGER | 记录时间戳（ms） |

### `tool_events` 表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | 主键 |
| `run_id` | TEXT FK | 关联 `runs.id` |
| `turn` | INTEGER | 所属 turn |
| `tool_call_id` | TEXT | 关联 start/update/end 同一次调用 |
| `tool_name` | TEXT | `fetch` / `extract` / `save` / `list_saved` / `finish` |
| `args_json` | TEXT | 工具入参 |
| `result_json` | TEXT | 工具结果（AgentToolResult 的 content/details） |
| `is_error` | INTEGER | 是否报错 |
| `duration_ms` | INTEGER | 调用耗时 |
| `saved` | INTEGER | 该调用是否导致落盘（`save` 工具专用） |
| `created_at` | INTEGER | 记录时间戳（ms） |

### 索引

- `idx_llm_run` ON `llm_events(run_id)`
- `idx_tool_run` ON `tool_events(run_id)`
- `idx_tool_name` ON `tool_events(tool_name)`
- `idx_tool_call` ON `tool_events(tool_call_id)`

## 埋点实现

新建 `src/trace.ts`，核心为 `TraceCollector` 类。

### 四类埋点数据源

1. **完整 prompt**：借 `new Agent({ onPayload: (payload, model) => { ...; return undefined; } })` —— pi-ai 钩子，能拿到**真正发往 LLM 的 payload**（openai-responses 适配器下 `payload.input` = system + history，`payload.tools` = 工具声明）。**return undefined** 保持旁路，不改写请求。
2. **完整 response**：`agent.subscribe` 的 `message_end` 事件且 `message.role === 'assistant'` —— 拿到完整 `AssistantMessage`（`text` / `thinking` / `toolCalls` / `usage` / `stopReason`）。
3. **工具调用**：`agent.subscribe` 的 `tool_execution_start(args)` / `tool_execution_update` / `tool_execution_end(result, isError)` —— `result` 为 `AgentToolResult`（含 `content` / `details`），按 `toolCallId` 关联同一次调用；`duration_ms` 由 start/end 时间差计。
4. **turn 归属**：`agent.subscribe` 计数——`agent_start` 时 `turnIndex = 0`，`turn_start` 时 `turnIndex++`。事件串行有序，归属可靠。

### 旁路轻量原则

- listener 被 pi-ai **await**，因此 trace 收集必须保持轻量：事件到来时仅**深拷贝**（`structuredClone`，不可克隆时退化为 `JSON.parse(JSON.stringify(...))`）进内存缓冲 `buffer`，然后立即返回。
- 真正落 SQLite 走**异步批量 flush**：每 run 结束一次 flush，或缓冲达到事件阈值时触发一次，避免每事件一次 IO。
- 任何 trace 动作都在 try/catch 内，绝不让观测行为影响抓取主流程。

### 类接口

```ts
class TraceCollector {
  attach(agent): void        // 内部 agent.subscribe 收集事件 + 包装 onPayload
  start(runMeta): string     // 生成/登记 run_id 并写入 runs 起始行
  flush(): Promise<void>     // 批量写 SQLite（llm_events / tool_events）
  close(runId, status): Promise<void> // 收尾更新 runs 行(ended_at/status/records_saved/duration_ms)
}
```

### 接入点

- `agent.ts` 的 `createCrawlerAgent` 接受**可选 trace 参数**，用于挂上 `onPayload`（未传时行为与现状完全一致）。
- `cli.ts` 创建 collector、`attach(agent)`、运行结束后 `flush()` + `close(runId, status)`，并打印 trace 路径与 `run_id`。

## SQLite 方案

- 首选 **`node:sqlite`**（Node 22 内置实验性 sqlite 模块）：零依赖、零原生编译，符合项目精简哲学。**决策：优先 `node:sqlite`，探明 API 可用性后用之。**
- 备选 **`better-sqlite3`**（dependencies）：同步 API、嵌入式、零配置、适合 Node 旁路写入，需 node-gyp 编译；Node 22 通常有预编译二进制，`npm install` 应直接可用。若 `node:sqlite` API 不可用再回退。
- 库文件固定 `output/trace.db`，开启 **WAL 模式**。
- 写策略：同步写但**批量**（每 run 结束一次 flush，或事件阈值触发），避免每事件一次 IO。

## 查询接口

新建 `src/trace-query.ts`，配 CLI 子命令或独立 script：

- `npm run trace -- <run_id>` —— **回放**某次运行的完整事件流（runs 元信息 + 按 turn 排序的 llm_events + tool_events）。
- `npm run trace-query -- --pattern extract-no-save` —— **行为查询**：找"extract 有产出但后续无 save"的运行。
- 核心查询：
  1. 列出 runs（含状态、耗时、落盘数）。
  2. 查某 run 的完整事件流。
  3. 查行为模式——SQL join `tool_events`：同 run 内 `extract` 结果有非空记录（extract.count > 0）但**不存在** `save` 且 `saved = true` 的行。

## Error Handling

- trace 写库失败：`try/catch` 包裹，仅 `console.warn` **不抛**（旁路原则，绝不影响抓取）。
- 新增 `TraceError`（可选，仅在需要区分错误来源时使用）。
- db 初始化失败：**降级为"仅内存日志"**，运行继续。

## Testing Strategy

**禁 mock，真实运行。**

- **units**：TraceCollector 缓冲 / SQLite 写入读出 / 工具事件关联 / turn 归属。做法：用**真实 agent 跑一次最小真实 LLM 抓取**产生 trace，断言 `trace.db` 里存在 `runs` / `llm_events` / `tool_events` 行、字段完整、可查 `extract-no-save` 模式。
- **integration**：端到端 crawl 后查 `trace.db`，验证 AC8 两个悬案可答。
- `npm test` 全绿（test:gate 通过）。

## 依赖变更

- 首选：无新增依赖（`node:sqlite` 内置）。
- 备选：新增 `better-sqlite3`（dependencies）。原生模块需 node-gyp 编译——评估：Node 22 有预编译二进制，`npm install` 应直接可用；若不可用则继续用 `node:sqlite`。**决策：优先 `node:sqlite`，探明 API 可用性后用之。**

## Out of Scope

- 自适应造工具 / 元工具 / Docker（后续）。
- trace 可视化 UI。
- 远程上报。

## Open Questions

- 全量 prompt/response 体积：大页面 markdown 进 prompt 会很大——**接受但加单条 payload 大小告警**。
- `node:sqlite` 的实验性稳定性。
