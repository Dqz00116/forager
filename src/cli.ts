import { readFile } from "node:fs/promises";
import path from "node:path";
import { createCrawlerAgent } from "./agent.js";
import { closeBrowser } from "./page.js";
import { closeHumanBrowser } from "./human.js";
import { AppError } from "./errors.js";
import { TraceCollector } from "./trace.js";

const RECORDS_PATH = path.join("output", "records.jsonl");
const TRACE_DB_PATH = path.join("output", "trace.db");

let shuttingDown = false;
let collector: TraceCollector | undefined;
let currentRunId: string | undefined;

async function countSaved(): Promise<number> {
  try {
    const content = await readFile(RECORDS_PATH, "utf8");
    return content.split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    return 0;
  }
}

async function shutdown(exitCode: number): Promise<never> {
  if (shuttingDown) return new Promise<never>(() => {}); // 防重入：挂起直到 process.exit
  shuttingDown = true;
  try {
    if (collector && currentRunId) await collector.close(currentRunId, "aborted");
  } catch {
    /* 旁路收尾失败不影响退出 */
  }
  try {
    await closeBrowser();
  } catch {
    /* 关闭浏览器失败不影响退出 */
  }
  try {
    await closeHumanBrowser();
  } catch {
    /* 关闭人类浏览器失败不影响退出 */
  }
  process.exit(exitCode);
}

function registerSignalHandlers(): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

async function main() {
  let entryUrl: URL;
  try {
    entryUrl = new URL(process.argv[2] ?? "");
  } catch {
    console.error(`无效的 URL: ${process.argv[2] ?? ""}`);
    console.error('用法: npm run crawl -- <入口URL> "<任务描述>"');
    process.exit(1);
  }
  const task = process.argv.slice(3).join(" ").trim();
  if (!task) {
    console.error('用法: npm run crawl -- <入口URL> "<任务描述>"');
    process.exit(1);
  }

  registerSignalHandlers();

  const trace = new TraceCollector();
  collector = trace;
  const runId = trace.start({ url: entryUrl.href, task });
  currentRunId = runId;

  try {
    const { agent, closeBrowser: closeAgentBrowser } = createCrawlerAgent(trace);

    agent.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const ev = event.assistantMessageEvent;
          if (ev.type === "text_delta") process.stdout.write(ev.delta);
          break;
        }
        case "tool_execution_start":
          process.stderr.write(`\n[tool] ${event.toolName} 开始 ${JSON.stringify(event.args)}\n`);
          break;
        case "tool_execution_end": {
          const brief = JSON.stringify(event.result);
          process.stderr.write(
            `[tool] ${event.toolName} 结束 ${brief.length > 300 ? brief.slice(0, 300) + "..." : brief}\n`
          );
          break;
        }
      }
    });

    try {
      await agent.prompt(`入口 URL：${entryUrl.href}\n\n任务：${task}`);
    } finally {
      try {
        await closeAgentBrowser();
      } catch {
        /* 关闭浏览器失败不影响后续清理 */
      }
      try {
        await closeHumanBrowser();
      } catch {
        /* 关闭人类浏览器失败不影响后续清理 */
      }
    }
  } catch (err) {
    try {
      await closeBrowser();
    } catch {
      /* 关闭浏览器失败不影响原始错误上报 */
    }
    throw err;
  }

  const saved = await countSaved();
  await trace.close(runId, "ok", saved);

  process.stdout.write(`\n\n已保存记录：output/records.jsonl\n`);
  process.stdout.write(`trace：${TRACE_DB_PATH}\n`);
  process.stdout.write(`run_id：${runId}\n`);
  process.stdout.write(`查询：npm run trace -- ${runId}\n`);
}

main().catch(async (err) => {
  try {
    if (collector && currentRunId) await collector.close(currentRunId, "error");
  } catch {
    /* 旁路收尾失败不影响退出 */
  }
  try {
    await closeHumanBrowser();
  } catch {
    /* 关闭人类浏览器失败不影响错误上报与退出 */
  }
  if (err instanceof AppError && err.isOperational) {
    console.error(`[${err.code}] ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.stack : err);
  }
  process.exitCode = 1;
});
