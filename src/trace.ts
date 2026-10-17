/**
 * P2 全量 trace —— 真实实现。
 *
 * TraceStore 封装 node:sqlite 的 DatabaseSync（三表 + 索引，WAL），初始化失败时
 * 降级为纯旁路（不抛错）。TraceCollector 负责把 agent 的 LLM prompt/response 与
 * 工具调用收集进内存缓冲，批量落盘；整条链路失败只 console.warn，绝不影响抓取。
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";

export interface TraceRunMeta {
  /** 入口 URL */
  url: string;
  /** 抓取任务描述 */
  task: string;
  /** 可选：显式指定 run_id，缺省由实现生成 */
  runId?: string;
}

export type TraceRunStatus = "running" | "ok" | "error" | "aborted";

const DEFAULT_DB_PATH = path.join("output", "trace.db");
const FLUSH_THRESHOLD = 50;

/** JSON 序列化快照；序列化失败也不抛出，退化为字符串快照。 */
function toJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? "null" : json;
  } catch {
    return JSON.stringify(String(value));
  }
}

function modelIdOf(model: unknown): string | null {
  if (typeof model === "string") return model;
  if (model && typeof model === "object") {
    const m = model as { id?: unknown; modelId?: unknown; model?: unknown };
    if (typeof m.id === "string") return m.id;
    if (typeof m.modelId === "string") return m.modelId;
    if (typeof m.model === "string") return m.model;
  }
  return null;
}

interface RunRow {
  id: string;
  url: string;
  task: string;
  startedAt: string;
  endedAt?: string | null;
  status: TraceRunStatus;
  recordsSaved?: number | null;
  durationMs?: number | null;
}

interface LlmRow {
  runId: string;
  turn: number;
  direction: "prompt" | "response";
  payloadJson: string;
  model?: string | null;
  usageJson?: string | null;
  createdAt: string;
}

interface ToolRow {
  runId: string;
  turn: number;
  toolCallId: string;
  toolName: string;
  argsJson: string;
  resultJson: string;
  isError: number;
  durationMs?: number | null;
  saved: number | null;
  createdAt: string;
}

/** 封装 node:sqlite DatabaseSync 的存储层。初始化失败时 ok=false，全部操作静默降级。 */
export class TraceStore {
  private db?: DatabaseSync;
  private ok = false;

  constructor(dbPath?: string) {
    try {
      const target = dbPath && dbPath.trim() !== "" ? dbPath : ":memory:";
      if (target !== ":memory:") {
        mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
      }
      const db = new DatabaseSync(target);
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          task TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          records_saved INTEGER,
          duration_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS llm_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          turn INTEGER NOT NULL,
          direction TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          model TEXT,
          usage_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tool_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          turn INTEGER NOT NULL,
          tool_call_id TEXT,
          tool_name TEXT NOT NULL,
          args_json TEXT,
          result_json TEXT,
          is_error INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER,
          saved INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_llm_run ON llm_events(run_id);
        CREATE INDEX IF NOT EXISTS idx_tool_run ON tool_events(run_id);
        CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_events(tool_name);
        CREATE INDEX IF NOT EXISTS idx_tool_call ON tool_events(tool_call_id);
        CREATE INDEX IF NOT EXISTS idx_tool_run_name ON tool_events(run_id, tool_name);
      `);
      this.db = db;
      this.ok = true;
    } catch (err) {
      this.ok = false;
      this.db = undefined;
      console.warn(
        `[trace] trace 存储初始化失败，降级为旁路（不写库）：${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private safe(work: (db: DatabaseSync) => void): void {
    if (!this.ok || !this.db) return;
    try {
      work(this.db);
    } catch (err) {
      console.warn(`[trace] trace 写库失败（旁路忽略）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  insertRun(row: RunRow): void {
    this.safe((db) => {
      db.prepare(
        `INSERT INTO runs (id, url, task, started_at, ended_at, status, records_saved, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.url,
        row.task,
        row.startedAt,
        row.endedAt ?? null,
        row.status,
        row.recordsSaved ?? null,
        row.durationMs ?? null
      );
    });
  }

  insertLlm(rows: LlmRow[]): void {
    if (rows.length === 0) return;
    this.safe((db) => {
      const stmt = db.prepare(
        `INSERT INTO llm_events (run_id, turn, direction, payload_json, model, usage_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      db.exec("BEGIN");
      try {
        for (const r of rows) {
          stmt.run(r.runId, r.turn, r.direction, r.payloadJson, r.model ?? null, r.usageJson ?? null, r.createdAt);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  insertTool(rows: ToolRow[]): void {
    if (rows.length === 0) return;
    this.safe((db) => {
      const stmt = db.prepare(
        `INSERT INTO tool_events
           (run_id, turn, tool_call_id, tool_name, args_json, result_json, is_error, duration_ms, saved, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      db.exec("BEGIN");
      try {
        for (const r of rows) {
          stmt.run(
            r.runId,
            r.turn,
            r.toolCallId,
            r.toolName,
            r.argsJson,
            r.resultJson,
            r.isError,
            r.durationMs ?? null,
            r.saved,
            r.createdAt
          );
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  updateRun(
    runId: string,
    patch: { endedAt: string; status: TraceRunStatus; recordsSaved?: number; durationMs?: number }
  ): void {
    this.safe((db) => {
      db.prepare(
        `UPDATE runs
            SET ended_at = ?,
                status = ?,
                records_saved = COALESCE(?, records_saved),
                duration_ms = COALESCE(?, duration_ms)
          WHERE id = ?`
      ).run(patch.endedAt, patch.status, patch.recordsSaved ?? null, patch.durationMs ?? null, runId);
    });
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* 忽略关闭异常 */
      }
    }
    this.db = undefined;
    this.ok = false;
  }
}

/** 事件采集器：attach 到 agent 后收集 prompt/response/工具调用，批量落盘。 */
export class TraceCollector {
  private readonly store: TraceStore;
  private runId?: string;
  private startedAt?: number;
  private turn = -1;
  private llmBuffer: LlmRow[] = [];
  private toolBuffer: ToolRow[] = [];
  private pendingTools = new Map<string, { argsJson: string; turn: number }>();
  private closed = false;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.store = new TraceStore(dbPath);
  }

  /** 登记一次运行并返回 run_id。 */
  start(meta: TraceRunMeta): string {
    const runId =
      meta.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.runId = runId;
    this.startedAt = Date.now();
    this.turn = -1;
    this.store.insertRun({
      id: runId,
      url: meta.url,
      task: meta.task,
      startedAt: new Date().toISOString(),
      status: "running",
    });
    return runId;
  }

  /** 挂载到 agent：接 onPayload（完整 prompt）+ subscribe（response / 工具 / turn）。 */
  attach(agent: Agent): void {
    const prevOnPayload = agent.onPayload;
    agent.onPayload = async (payload: unknown, model: any) => {
      try {
        this.recordPrompt(payload, model);
      } catch {
        /* 旁路：采集失败不影响请求 */
      }
      // 旁路不改写请求 payload：沿用已有钩子（若有），否则返回 undefined。
      if (typeof prevOnPayload === "function") return prevOnPayload(payload, model);
      return undefined;
    };

    agent.subscribe((event) => {
      try {
        this.handleEvent(event);
      } catch {
        /* 旁路：采集失败不影响 agent */
      }
    });
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.turn = -1;
        break;
      case "turn_start":
        this.turn += 1;
        break;
      case "message_end": {
        const role = (event.message as { role?: string } | undefined)?.role;
        if (role === "assistant") this.recordResponse(event.message);
        break;
      }
      case "tool_execution_start":
        this.pendingTools.set(event.toolCallId, {
          argsJson: toJson(event.args),
          turn: Math.max(this.turn, 0),
        });
        break;
      case "tool_execution_end":
        this.recordToolEnd(event);
        break;
    }
  }

  private recordPrompt(payload: unknown, model: unknown): void {
    if (!this.runId) return;
    this.llmBuffer.push({
      runId: this.runId,
      turn: Math.max(this.turn, 0),
      direction: "prompt",
      payloadJson: toJson(payload),
      model: modelIdOf(model),
      usageJson: null,
      createdAt: new Date().toISOString(),
    });
    this.maybeFlush();
  }

  private recordResponse(message: unknown): void {
    if (!this.runId) return;
    const m = message as { model?: unknown; usage?: unknown };
    this.llmBuffer.push({
      runId: this.runId,
      turn: Math.max(this.turn, 0),
      direction: "response",
      payloadJson: toJson(message),
      model: modelIdOf(m.model),
      usageJson: m.usage ? toJson(m.usage) : null,
      createdAt: new Date().toISOString(),
    });
    this.maybeFlush();
  }

  private recordToolEnd(event: {
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
    durationMs?: number;
  }): void {
    const pending = this.pendingTools.get(event.toolCallId);
    this.pendingTools.delete(event.toolCallId);

    let saved: number | null = null;
    if (event.toolName === "save") {
      const details = (event.result as { details?: { saved?: unknown } } | undefined)?.details;
      saved = details?.saved === true ? 1 : 0;
    }

    this.toolBuffer.push({
      runId: this.runId ?? "",
      turn: Math.max(pending?.turn ?? this.turn, 0),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      argsJson: pending?.argsJson ?? "{}",
      resultJson: toJson(event.result),
      isError: event.isError ? 1 : 0,
      durationMs: typeof event.durationMs === "number" ? event.durationMs : null,
      saved,
      createdAt: new Date().toISOString(),
    });
    this.maybeFlush();
  }

  private maybeFlush(): void {
    if (this.llmBuffer.length + this.toolBuffer.length >= FLUSH_THRESHOLD) {
      void this.flush();
    }
  }

  /** 批量落盘（旁路：永不抛出）。 */
  async flush(): Promise<void> {
    const llm = this.llmBuffer;
    const tool = this.toolBuffer;
    this.llmBuffer = [];
    this.toolBuffer = [];
    if (llm.length === 0 && tool.length === 0) return;
    this.store.insertLlm(llm);
    this.store.insertTool(tool);
  }

  /** 收尾：flush 后 UPDATE runs 行。 */
  async close(runId: string, status: TraceRunStatus = "ok", recordsSaved?: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
    const endedAt = new Date().toISOString();
    const durationMs = this.startedAt !== undefined ? Date.now() - this.startedAt : undefined;
    this.store.updateRun(runId, { endedAt, status, recordsSaved, durationMs });
    this.store.close();
  }
}
