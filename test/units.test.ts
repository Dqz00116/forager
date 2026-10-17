import "dotenv/config";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pageToLLMView, extractLinks, closeBrowser } from "../src/page.js";
import { crawlerTools } from "../src/tools.js";
import { TraceCollector } from "../src/trace.js";
import { waitForEnter, waitForDone, launchHumanBrowser, getHumanContext, closeHumanBrowser } from "../src/human.js";

const execFileAsync = promisify(execFile);

// trace 用例需要真实 LLM；无 key 时整体跳过（config.ts 会经 tools.ts 传递加载 .env）。
const opencodeKey = process.env.OPENCODE_API_KEY?.trim();
const itWithKey = opencodeKey ? it : it.skip;

// 从工具 execute 返回值里取回 payload：优先 details，缺省回退解析 content 文本。
// 这样断言只依赖工具的输出契约，不绑定实现细节。
function payloadOf(result: unknown): any {
  const r = result as { details?: unknown; content?: Array<{ type: string; text?: string }> };
  if (r.details !== undefined) return r.details;
  const text = r.content?.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

// ---------- 1. pageToLLMView ----------

describe("pageToLLMView", () => {
  const base = "https://example.com/articles/";
  const html = `<!DOCTYPE html>
<html>
  <head>
    <title>Test Page</title>
    <style>body { color: red; }</style>
    <script>window.SECRET_TOKEN = "SCRIPT_SECRET_123";</script>
  </head>
  <body>
    <h1>Main Heading</h1>
    <p>Visible paragraph text.</p>
    <a href="/articles/next">Next article</a>
    <a href="https://elsewhere.org/page">External</a>
  </body>
</html>`;

  it("returns markdown and links", () => {
    const view = pageToLLMView(base, html);
    expect(view).toHaveProperty("markdown");
    expect(view).toHaveProperty("links");
    expect(typeof view.markdown).toBe("string");
    expect(Array.isArray(view.links)).toBe(true);
  });

  it("strips script and style content from markdown", () => {
    const { markdown } = pageToLLMView(base, html);
    expect(markdown).not.toContain("SCRIPT_SECRET_123");
    expect(markdown).not.toContain("color: red");
    expect(markdown).toContain("Main Heading");
    expect(markdown).toContain("Visible paragraph text.");
  });

  it("absolutizes relative link hrefs against the passed base url", () => {
    const { links } = pageToLLMView(base, html);
    const hrefs = links.map((l) => l.href);
    expect(hrefs).toContain("https://example.com/articles/next");
    expect(hrefs).toContain("https://elsewhere.org/page");
    for (const href of hrefs) {
      expect(() => new URL(href)).not.toThrow();
      expect(href.startsWith("http")).toBe(true);
    }
  });
});

// ---------- 2. extractLinks ----------

describe("extractLinks", () => {
  it("extracts {text, href}, absolutizes relative hrefs, skips unparseable hrefs", () => {
    // "http://exa mple.com/x"（空格）是 new URL 解析会抛错的非法 href
    const html =
      '<a href="https://absolute.example/p">Absolute</a>' +
      '<a href="/relative/path">Relative</a>' +
      '<a href="http://exa mple.com/x">Illegal</a>';
    const links = extractLinks(html, "https://base.example/dir/page.html");

    expect(links).toEqual([
      { text: "Absolute", href: "https://absolute.example/p" },
      { text: "Relative", href: "https://base.example/relative/path" },
    ]);
  });

  it("collapses whitespace in link text", () => {
    const links = extractLinks(
      "<a href=\"/p\">\n  multi\n  line  text  </a>",
      "https://base.example/"
    );
    expect(links).toEqual([{ text: "multi line text", href: "https://base.example/p" }]);
  });
});

// ---------- 3. save 双重编码还原 ----------

describe("save 双重编码还原", () => {
  const recordsPath = path.join("output", "records.jsonl");
  const saveTool = crawlerTools.find((t) => t.name === "save");

  it("parses a JSON-string data arg back into an object in records.jsonl", async () => {
    expect(saveTool).toBeDefined();
    const result = await saveTool!.execute("test-call-id", {
      data: '{"a":1}',
    });
    expect(result.content[0]).toMatchObject({ type: "text" });

    const content = await readFile(recordsPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    const last = JSON.parse(lines[lines.length - 1]) as { data: unknown };
    expect(last.data).toEqual({ a: 1 });
    expect(typeof last.data).toBe("object");
  });

  afterAll(async () => {
    await rm(recordsPath, { force: true });
  });
});

// ---------- 4. config 缺 key 报错 ----------

describe("config 缺 OPENCODE_API_KEY", () => {
  it(
    "importing config without a key exits non-zero with a ConfigError message on stderr",
    async () => {
      // config.ts 模块加载即校验，所以用真实 node 子进程验证。
      // `node -e` 的代码无法用相对路径 import（解析为 [eval1]），所以写临时脚本文件再删。
      // 置空 OPENCODE_API_KEY：dotenv 不会覆盖已存在的变量，.env 里的真实 key 因此失效。
      const script = [
        "process.env.OPENCODE_API_KEY = '';",
        "try {",
        "  await import('./src/config.ts');",
        "  console.log('IMPORT_SUCCEEDED');",
        "} catch (err) {",
        "  console.error(String(err && err.message ? err.message : err));",
        "  console.error('ERR_NAME:' + (err && err.name ? err.name : 'unknown'));",
        "  process.exit(1);",
        "}",
      ].join("\n");
      const scriptPath = path.join(".tmp-config-nokey.test.mjs");
      await writeFile(scriptPath, script, "utf8");
      try {
        await execFileAsync(process.execPath, ["./node_modules/tsx/dist/cli.mjs", scriptPath], {
          cwd: path.resolve(import.meta.dirname, ".."),
        });
        throw new Error("expected config import to fail without OPENCODE_API_KEY");
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException & { stderr?: string; code?: unknown };
        if (e.code === "ENOENT") throw err;
        // 子进程按预期以非零码退出
        expect(e.code).not.toBe(0);
        const stderr = e.stderr ?? "";
        expect(stderr).toContain("缺少 OPENCODE_API_KEY");
        expect(stderr).toContain("ERR_NAME:ConfigError");
      } finally {
        await rm(scriptPath, { force: true });
      }
    },
    30_000
  );
});

// ---------- 5. save 契约（P1，生产代码尚未实现 —— 预期失败） ----------

describe("save 契约", () => {
  const recordsPath = path.join("output", "records.jsonl");
  const saveTool = crawlerTools.find((t) => t.name === "save");

  beforeEach(async () => {
    await rm(recordsPath, { force: true });
  });

  it("缺 schema 字段的记录被拒：saved=false, reason=schema_missing", async () => {
    expect(saveTool).toBeDefined();
    const result = await saveTool!.execute("save-missing", {
      data: { title: "A", url: "u1" },
      schema: ["title", "url", "summary"],
    });
    const payload = payloadOf(result) as { saved: boolean; reason?: string; count: number };
    expect(payload.saved).toBe(false);
    expect(payload.reason).toBe("schema_missing");
  });

  it("同 dedup_key 的重复记录被跳过：第二次 saved=false, reason=duplicate, count 不增", async () => {
    expect(saveTool).toBeDefined();
    const first = await saveTool!.execute("save-dup-1", {
      data: { title: "A", url: "u1", summary: "s" },
      schema: ["title", "url", "summary"],
      dedup_key: "url",
    });
    const firstPayload = payloadOf(first) as { saved: boolean; count: number };
    expect(firstPayload.saved).toBe(true);
    expect(firstPayload.count).toBe(1);

    const second = await saveTool!.execute("save-dup-2", {
      data: { title: "B", url: "u1", summary: "s2" },
      schema: ["title", "url", "summary"],
      dedup_key: "url",
    });
    const secondPayload = payloadOf(second) as { saved: boolean; reason?: string; count: number };
    expect(secondPayload.saved).toBe(false);
    expect(secondPayload.reason).toBe("duplicate");
    expect(secondPayload.count).toBe(1);
  });

  it("内容字段全空被过滤（dedup_key 不计内容）：saved=false, reason=all_empty", async () => {
    expect(saveTool).toBeDefined();
    const result = await saveTool!.execute("save-empty", {
      data: { title: "", url: "u2", summary: "" },
      schema: ["title", "url", "summary"],
      dedup_key: "url",
    });
    const payload = payloadOf(result) as { saved: boolean; reason?: string; count: number };
    expect(payload.saved).toBe(false);
    expect(payload.reason).toBe("all_empty");
  });
});

// ---------- 6. extract selector 路径（P1，生产代码尚未实现 —— 预期失败） ----------

describe("extract selector 路径", () => {
  const extractTool = crawlerTools.find((t) => t.name === "extract");

  it("用确定性选择器提取文本（含 selector 时不走 LLM）", async () => {
    expect(extractTool).toBeDefined();
    const content = '<div class="q">hello</div><div class="q">world</div>';
    const result = await extractTool!.execute("extract-selector", {
      content,
      instruction: "extract the quotes",
      selector: ".q",
    });
    const payload = payloadOf(result) as { text: string[] };
    expect(payload.text).toEqual(["hello", "world"]);
  });
});

// ---------- 7. trace 记录（P2，src/trace.ts 为占位桩 —— 预期失败） ----------

// 用真实 agent + 真实 LLM 跑一次最小抓取产生 trace，再直接读 trace.db 断言结构。
// 说明：createCrawlerAgent 暂按无参调用（T2 会加可选 trace 参数）；此处用
// new TraceCollector(dbPath) + collector.attach(agent) 完成挂载。若生产实现改为
// 由 createCrawlerAgent(trace) 注入 onPayload，attach 亦应负责同样的埋点。
describe("trace 记录", () => {
  const dbPath = path.join("output", "test-trace.db");
  const sidecars = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];

  // 两个用例共享同一次真实 LLM 运行，避免重复调用。
  let shared: Promise<string> | null = null;

  async function runMinimalTrace(): Promise<string> {
    for (const p of sidecars) await rm(p, { force: true });

    const { createCrawlerAgent } = await import("../src/agent.js");
    const collector = new TraceCollector(dbPath);
    const { agent, closeBrowser: closeAgentBrowser } = createCrawlerAgent();
    const runId = collector.start({
      url: "https://quotes.toscrape.com/",
      task: "抓取首页并保存一条名言",
    });
    collector.attach(agent);
    try {
      await agent.prompt(
        [
          "入口 URL：https://quotes.toscrape.com/",
          "",
          "任务：用 fetch 抓取该首页，用 extract 抽取其中一条名言的 text 与 author，",
          "然后用 save 保存这一条（schema=['text','author']，source_url 传该页面完整 URL），",
          "最后用 finish 收工。只保存一条即可。",
        ].join("\n")
      );
    } finally {
      await collector.flush();
      await collector.close(runId, "ok");
      await closeAgentBrowser();
    }
    return runId;
  }

  function ensureRun(): Promise<string> {
    if (!shared) shared = runMinimalTrace();
    return shared;
  }

  itWithKey(
    "runs / llm_events / tool_events 三表写入且字段完整",
    async () => {
      const runId = await ensureRun();
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const runs = db.prepare("SELECT * FROM runs WHERE id = ?").all(runId);
        expect(runs.length).toBe(1);
        expect(runs[0].url).toBe("https://quotes.toscrape.com/");
        expect(typeof runs[0].task).toBe("string");
        expect(runs[0].status).toBe("ok");

        const directions = db
          .prepare("SELECT DISTINCT direction FROM llm_events WHERE run_id = ?")
          .all(runId)
          .map((r) => r.direction);
        expect(directions).toContain("prompt");
        expect(directions).toContain("response");

        const tools = db.prepare("SELECT * FROM tool_events WHERE run_id = ?").all(runId);
        expect(tools.length).toBeGreaterThan(0);
        for (const t of tools) {
          expect(typeof t.tool_call_id).toBe("string");
          expect((t.tool_call_id as string).length).toBeGreaterThan(0);
          expect(typeof t.tool_name).toBe("string");
          expect(typeof t.args_json).toBe("string");
          expect(typeof t.result_json).toBe("string");
        }
      } finally {
        db.close();
      }
    },
    180_000
  );

  itWithKey(
    "tool_call_id 关联且 save 调用 saved=1、非 save 调用 saved 为 0 或 NULL",
    async () => {
      const runId = await ensureRun();
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const saveRows = db
          .prepare("SELECT saved FROM tool_events WHERE run_id = ? AND tool_name = 'save'")
          .all(runId);
        expect(saveRows.length).toBeGreaterThan(0);
        expect(saveRows.some((r) => r.saved === 1)).toBe(true);

        const otherRows = db
          .prepare("SELECT saved FROM tool_events WHERE run_id = ? AND tool_name <> 'save'")
          .all(runId);
        expect(otherRows.length).toBeGreaterThan(0);
        for (const r of otherRows) {
          expect(r.saved === 0 || r.saved === null).toBe(true);
        }

        // toolCallId 关联：每个工具调用行都带非空 tool_call_id。
        const ids = db
          .prepare("SELECT DISTINCT tool_call_id FROM tool_events WHERE run_id = ?")
          .all(runId);
        expect(ids.length).toBeGreaterThan(0);
        for (const row of ids) {
          expect(typeof row.tool_call_id).toBe("string");
          expect((row.tool_call_id as string).length).toBeGreaterThan(0);
        }
      } finally {
        db.close();
      }
    },
    180_000
  );

  afterAll(async () => {
    for (const p of sidecars) await rm(p, { force: true });
  });
});

// ---------- 8. 人机协作（P3，src/human.ts 为占位桩 —— 预期失败） ----------

// 目标接口即生产要实现的目标接口：
//   waitForEnter(prompt: string, input?: Readable): Promise<void>
//   launchHumanBrowser(): Promise<{ browser, context, page }>
//   getHumanContext(): BrowserContext | undefined
//   closeHumanBrowser(): Promise<void>
//   page.ts: getSharedContext(browser): Promise<BrowserContext>（共享 context 单例）
// 真实运行、禁 mock；"人的回车"用注入的真实 input stream 受控模拟（REQ AC10 允许）。
describe("人机协作", () => {
  it(
    "waitForEnter 用注入 input stream 模拟回车后 resolve（不挂起）",
    async () => {
      // 用真实 Readable 注入"模拟 stdin"，预先写入换行（模拟人按回车），非 mock 库。
      const input = new Readable({ read() {} });
      input.push("\n");
      await expect(waitForEnter("完成后请按回车…", input)).resolves.toBeUndefined();
    },
    10_000
  );

  it("closeBrowser / closeHumanBrowser 幂等：连续两次 + 未启动时调用均不抛", async () => {
    // 未启动任何浏览器时为空操作：resolve undefined、不抛、无副作用。
    await expect(closeBrowser()).resolves.toBeUndefined();
    await expect(closeHumanBrowser()).resolves.toBeUndefined();
    // 连续第二次调用仍幂等。
    await expect(closeBrowser()).resolves.toBeUndefined();
    await expect(closeHumanBrowser()).resolves.toBeUndefined();
  });

  it(
    "launchHumanBrowser 启动后 closeHumanBrowser 真实清理：context 变 undefined 且再次 close 幂等",
    async (ctx) => {
      // 真实 headless=false 启动有头 chromium；无显示环境（如无头 CI）时跳过。
      try {
        const { context } = await launchHumanBrowser();
        expect(context).toBeDefined();
      } catch {
        ctx.skip();
        return;
      }
      // 单例已建立：getHumanContext 返回该 context。
      expect(getHumanContext()).toBeDefined();

      await closeHumanBrowser();
      // 清理后单例复位。
      expect(getHumanContext()).toBeUndefined();

      // 幂等：清理后再 close 仍 resolve、不抛。
      await expect(closeHumanBrowser()).resolves.toBeUndefined();
      expect(getHumanContext()).toBeUndefined();
    },
    60_000
  );

  it(
    "共享 context 单例：同一 browser 多次调用返回同一 context 实例",
    async () => {
      // 按设计 getSharedContext(browser) 为 page.ts 的导出；动态读取以对齐生产实现。
      const pageMod = (await import("../src/page.js")) as unknown as {
        getSharedContext?: (browser: Browser) => Promise<BrowserContext>;
      };
      expect(typeof pageMod.getSharedContext).toBe("function");

      const browser = await chromium.launch({ headless: true });
      try {
        const first = await pageMod.getSharedContext!(browser);
        const second = await pageMod.getSharedContext!(browser);
        expect(first).toBe(second);
      } finally {
        await browser.close();
      }
    },
    60_000
  );
});

// ---------- 9. 轮询完成检测（P3 修复：waitForDone 尚未实现 —— 预期失败） ----------

// 目标接口（生产待实现）：
//   waitForDone(page, options): Promise<{ elapsed_ms: number }>
//   options: { timeout_ms?, interval_ms?, success_url_pattern?, gone_url_pattern?,
//              success_selector?, gone_selector? }
// 轮询检测：URL 匹配 success_url_pattern / 不再匹配 gone_url_pattern /
//           success_selector 出现 / gone_selector 消失 → 返回；超时抛错或返回超时标记。
// 真实 headless browser，禁 mock。
describe("轮询完成检测", () => {
  it(
    "waitForDone 检测 URL 变化：gone_url_pattern 不再匹配后 resolve 且 elapsed>0",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto("about:blank");

        const pending = waitForDone(page, {
          gone_url_pattern: "blank",
          timeout_ms: 8_000,
          interval_ms: 300,
        });

        // 1s 后模拟人完成：离开 about:blank。
        setTimeout(() => {
          void page.goto("https://example.com/").catch(() => {});
        }, 1_000);

        const result = await pending;
        expect(result.elapsed_ms).toBeGreaterThan(0);
      } finally {
        await browser.close();
      }
    },
    20_000
  );

  it(
    "waitForDone 检测 success_selector 出现：元素出现后 resolve",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto("data:text/html,<html><body><h1>waiting</h1></body></html>");

        const pending = waitForDone(page, {
          success_selector: "#done-marker",
          timeout_ms: 8_000,
          interval_ms: 300,
        });

        // 1s 后模拟人完成：页面出现目标元素。
        setTimeout(() => {
          void page
            .setContent("<html><body><div id='done-marker'>done</div></body></html>")
            .catch(() => {});
        }, 1_000);

        const result = await pending;
        expect(result.elapsed_ms).toBeGreaterThan(0);
      } finally {
        await browser.close();
      }
    },
    20_000
  );

  it(
    "waitForDone 超时：页面始终不变时按约定抛错或返回超时标记",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto("about:blank");

        let threw = false;
        let returned: { elapsed_ms: number; timed_out?: boolean } | undefined;
        try {
          returned = await waitForDone(page, {
            gone_url_pattern: "blank",
            timeout_ms: 1_500,
            interval_ms: 300,
          });
        } catch {
          threw = true;
        }

        // 约定二选一：抛错，或返回带超时标记的结果。
        expect(threw || returned?.timed_out === true).toBe(true);
      } finally {
        await browser.close();
      }
    },
    20_000
  );

  it(
    "waitForDone 窗口关闭时 URL pattern 模式立即返回 closed（不傻等超时）",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto("about:blank");

        // 只用 gone_url_pattern：page.url() 返回缓存旧 URL 不抛错，
        // 正确实现应能感知窗口已关并立即返回 closed。
        const pending = waitForDone(page, {
          gone_url_pattern: "blank",
          timeout_ms: 30_000,
          interval_ms: 300,
        });

        // 500ms 后模拟用户手动关闭浏览器窗口。
        setTimeout(() => {
          void page.context().close().catch(() => {});
        }, 500);

        // 窗口关闭后应尽快返回；若傻等到 30s 超时，这里会先失败。
        const result = (await Promise.race([
          pending,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("waitForDone 未在窗口关闭后 5s 内返回（疑似傻等超时）")),
              5_000
            )
          ),
        ])) as { elapsed_ms: number; timed_out?: boolean; closed?: boolean };

        expect(result.closed).toBe(true);
        expect(result.timed_out).not.toBe(true);
      } finally {
        await browser.close();
      }
    },
    45_000
  );

  it(
    "waitForDone 窗口关闭时 selector 模式返回 closed，不抛原始 TargetClosedError",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto("about:blank");

        const pending = waitForDone(page, {
          success_selector: "#x",
          timeout_ms: 10_000,
          interval_ms: 300,
        });

        // 500ms 后模拟用户关闭窗口（page 关闭）。
        setTimeout(() => {
          void page.close().catch(() => {});
        }, 500);

        let result: { elapsed_ms: number; timed_out?: boolean; closed?: boolean } | undefined;
        let error: unknown;
        try {
          result = (await pending) as {
            elapsed_ms: number;
            timed_out?: boolean;
            closed?: boolean;
          };
        } catch (e) {
          error = e;
        }

        if (error) {
          // 允许以领域错误 reject，但绝不能是 Playwright 原始 TargetClosedError。
          const message = String((error as Error)?.message ?? error);
          expect(message).not.toContain("Target page, context or browser has been closed");
          expect(message).toContain("窗口已关闭");
        } else {
          expect(result?.closed).toBe(true);
        }
      } finally {
        await browser.close();
      }
    },
    20_000
  );
});
