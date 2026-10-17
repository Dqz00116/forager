/**
 * P2 trace 查询 CLI。
 *
 * 用法：
 *   npm run trace                       # 列出 runs（按 started_at 排序，支持 --since 过滤）
 *   npm run trace -- runs --since <iso> # 同上
 *   npm run trace -- run <run_id>       # 回放某 run 的事件流（按 turn,id 排序）
 *   npm run trace -- <run_id>           # 位置参数视为 run_id，回放
 *   npm run trace -- --pattern extract-no-save   # 查「只 extract 未 save」的 run_id
 *   npm run trace -- --db <path> ...    # 覆盖默认库 output/trace.db
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB_PATH = path.join("output", "trace.db");

interface Options {
  dbPath: string;
  pattern?: string;
  since?: string;
  positionals: string[];
}

function parseArgs(argv: string[]): Options {
  let dbPath = DEFAULT_DB_PATH;
  let pattern: string | undefined;
  let since: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") dbPath = argv[++i] ?? dbPath;
    else if (arg === "--pattern") pattern = argv[++i];
    else if (arg === "--since") since = argv[++i];
    else positionals.push(arg);
  }
  return { dbPath, pattern, since, positionals };
}

function normalizeSince(input: string): string {
  const trimmed = input.trim();
  if (/^\d{10,}$/.test(trimmed)) return new Date(Number(trimmed)).toISOString();
  const d = new Date(trimmed);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return trimmed;
}

/** 从 tool result JSON 里读出抽取条数：优先 details.count，回退 text/records 数组长度。 */
function readCount(resultJson: unknown): number {
  if (typeof resultJson !== "string") return 0;
  try {
    const obj = JSON.parse(resultJson) as any;
    const details = obj?.details ?? obj;
    if (typeof details?.count === "number") return details.count;
    if (Array.isArray(details?.text)) return details.text.length;
    if (Array.isArray(details?.records)) return details.records.length;
  } catch {
    /* 忽略无法解析的 result */
  }
  return 0;
}

/** 某 run 有 extract 且抽取条数 > 0，但同 run 无 save 落盘（saved=1），即「只 extract 未 save」。 */
function findExtractNoSave(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT run_id, tool_name, result_json, saved FROM tool_events")
    .all() as Array<Record<string, unknown>>;

  const perRun = new Map<string, { extractWithCount: boolean; savedAny: boolean }>();
  for (const row of rows) {
    const runId = String(row.run_id);
    const entry = perRun.get(runId) ?? { extractWithCount: false, savedAny: false };
    if (String(row.tool_name) === "extract" && readCount(row.result_json) > 0) {
      entry.extractWithCount = true;
    }
    if (String(row.tool_name) === "save" && Number(row.saved) === 1) {
      entry.savedAny = true;
    }
    perRun.set(runId, entry);
  }

  const matches: string[] = [];
  for (const [runId, entry] of perRun) {
    if (entry.extractWithCount && !entry.savedAny) matches.push(runId);
  }
  return matches;
}

function listRuns(db: DatabaseSync, since?: string): void {
  let sql =
    "SELECT id, url, task, status, records_saved, duration_ms, started_at, ended_at FROM runs";
  const params: string[] = [];
  if (since) {
    sql += " WHERE started_at >= ?";
    params.push(normalizeSince(since));
  }
  sql += " ORDER BY started_at ASC";

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    console.log("（无匹配 runs）");
    return;
  }
  for (const r of rows) {
    console.log(
      `${r.id}  ${r.started_at}  status=${r.status}  saved=${r.records_saved ?? "-"}  duration_ms=${
        r.duration_ms ?? "-"
      }  ${r.url}`
    );
  }
}

function truncate(text: string, limit = 300): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function replayRun(db: DatabaseSync, runId: string): void {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  if (!run) {
    console.log(`（未找到 run：${runId}）`);
    return;
  }
  console.log(`run ${runId}`);
  console.log(JSON.stringify(run));

  const llm = db
    .prepare("SELECT id, turn, direction, model, payload_json FROM llm_events WHERE run_id = ?")
    .all(runId) as Array<Record<string, unknown>>;
  const tools = db
    .prepare(
      "SELECT id, turn, tool_name, tool_call_id, is_error, duration_ms, saved, args_json, result_json FROM tool_events WHERE run_id = ?"
    )
    .all(runId) as Array<Record<string, unknown>>;

  const events = [
    ...llm.map((r) => ({ kind: "llm" as const, turn: Number(r.turn), id: Number(r.id), row: r })),
    ...tools.map((r) => ({ kind: "tool" as const, turn: Number(r.turn), id: Number(r.id), row: r })),
  ].sort((a, b) => a.turn - b.turn || a.id - b.id);

  for (const e of events) {
    if (e.kind === "llm") {
      console.log(
        `[turn ${e.turn}] llm#${e.id} ${e.row.direction} model=${e.row.model ?? "-"} :: ${truncate(
          String(e.row.payload_json)
        )}`
      );
    } else {
      console.log(
        `[turn ${e.turn}] tool#${e.id} ${e.row.tool_name} call=${e.row.tool_call_id ?? "-"} error=${
          e.row.is_error
        } duration_ms=${e.row.duration_ms ?? "-"} saved=${e.row.saved ?? "-"} :: ${truncate(
          String(e.row.args_json)
        )} -> ${truncate(String(e.row.result_json))}`
      );
    }
  }
}

function openDb(dbPath: string): DatabaseSync {
  if (!existsSync(dbPath)) {
    console.error(`trace 数据库不存在：${dbPath}（先运行一次 crawl 生成）`);
    process.exit(1);
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const db = openDb(opts.dbPath);
  try {
    if (opts.pattern) {
      if (opts.pattern === "extract-no-save") {
        const matches = findExtractNoSave(db);
        if (matches.length === 0) console.log("（无匹配 extract-no-save 的 run）");
        else for (const id of matches) console.log(id);
      } else {
        console.error(`未知 pattern：${opts.pattern}`);
        process.exitCode = 1;
      }
      return;
    }

    const [cmd, arg] = opts.positionals;
    if (cmd === "runs" || cmd === undefined) {
      listRuns(db, opts.since);
    } else if (cmd === "run") {
      if (!arg) {
        console.error("用法：npm run trace -- run <run_id>");
        process.exitCode = 1;
      } else {
        replayRun(db, arg);
      }
    } else {
      // 位置参数视为 run_id，直接回放
      replayRun(db, cmd);
    }
  } finally {
    db.close();
  }
}

main();
