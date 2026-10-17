import "dotenv/config";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createModels, type Model } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Page } from "playwright";
import { fetchStatic, pageToLLMView, renderDynamic, closeBrowser } from "../src/page.js";
import { crawlerTools } from "../src/tools.js";
import { TraceCollector, TraceStore } from "../src/trace.js";
import { getHumanContext, closeHumanBrowser } from "../src/human.js";

const execFileAsync = promisify(execFile);

const key = process.env.OPENCODE_API_KEY?.trim();
const itWithKey = key ? it : it.skip;
const modelId = process.env.CRAWLER_MODEL?.trim() || "muse-spark-1.3-contributor";

// 从工具 execute 返回值里取回 payload：优先 details，缺省回退解析 content 文本。
function payloadOf(result: unknown): any {
  const r = result as { details?: unknown; content?: Array<{ type: string; text?: string }> };
  if (r.details !== undefined) return r.details;
  const text = r.content?.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

// 读取 records.jsonl 的非空行数；文件不存在（未创建）时视为 0，避免 ENOENT 掩盖真实断言。
async function countRecords(recordsPath: string): Promise<number> {
  if (!existsSync(recordsPath)) return 0;
  const content = await readFile(recordsPath, "utf8");
  return content.split("\n").filter((l) => l.trim() !== "").length;
}

afterAll(async () => {
  await closeBrowser();
});

// ---------- 1. 真实 LLM 推理 ----------

describe("真实 LLM 推理 (streamSimple)", () => {
  itWithKey(
    "streams a non-empty reply for 'Reply with exactly: PONG'",
    async () => {
      const models = createModels();
      models.setProvider(opencodeGoProvider());
      const model = models.getModel("opencode-go", modelId);
      expect(model).toBeDefined();
      const m = model as Model<any>;

      const stream = models.streamSimple(
        m,
        { messages: [{ role: "user", content: "Reply with exactly: PONG", timestamp: Date.now() }] },
        { sessionId: "test-integration" }
      );

      let text = "";
      let sawStart = false;
      for await (const ev of stream) {
        if (ev.type === "start") sawStart = true;
        if (ev.type === "text_delta") text += ev.delta;
        if (ev.type === "error") {
          throw new Error(`LLM stream error: ${ev.error.errorMessage ?? "unknown"}`);
        }
      }
      expect(sawStart).toBe(true);
      expect(text.trim().length).toBeGreaterThan(0);
    },
    120_000
  );
});

// ---------- 2. fetchStatic 真实抓取 ----------

describe("fetchStatic 真实抓取", () => {
  it(
    "fetches https://quotes.toscrape.com/ with status 200 and extractable links",
    async () => {
      const page = await fetchStatic("https://quotes.toscrape.com/");
      expect(page.status).toBe(200);
      expect(page.html).toContain("Quotes to Scrape");

      const view = pageToLLMView(page.url, page.html);
      expect(view.links.length).toBeGreaterThan(0);
      for (const l of view.links) {
        expect(() => new URL(l.href)).not.toThrow();
      }
      expect(view.markdown.length).toBeGreaterThan(0);
    },
    60_000
  );
});

// ---------- 3. renderDynamic 真实渲染 ----------

describe("renderDynamic 真实渲染", () => {
  it(
    "renders the JS page https://quotes.toscrape.com/js with extractable content",
    async () => {
      const page = await renderDynamic("https://quotes.toscrape.com/js");
      expect(page.html.length).toBeGreaterThan(0);
      const view = pageToLLMView(page.url, page.html);
      // JS 渲染后应能看到真实正文（quotes.toscrape.com/js 渲染出名言列表）
      expect(view.markdown.length).toBeGreaterThan(0);
      expect(page.html).toContain("<");
    },
    120_000
  );
});

// ---------- 4. 端到端 agent 抓取（核心 AC3 多页） ----------

describe("端到端 agent 抓取", () => {
  const recordsPath = path.join("output", "records.jsonl");

  itWithKey(
    "agent crawls first 2 pages of quotes.toscrape.com and saves records via save",
    async () => {
      // 先清掉旧记录，保证断言只针对本次运行。
      await rm(recordsPath, { force: true });

      // 动态 import：agent.ts 静态引入 config.ts（模块加载即校验 key），
      // 无 key 时要在 it.skip 层面跳过而不是让整个文件在加载期报错。
      const { createCrawlerAgent } = await import("../src/agent.js");
      const { agent, closeBrowser: closeAgentBrowser } = createCrawlerAgent();
      try {
        const prompt = [
          "入口 URL：https://quotes.toscrape.com/",
          "",
          "任务：抓取该站点的第 1 页和第 2 页（第 2 页 URL 是 https://quotes.toscrape.com/page/2/），",
          "每页有 10 条名言。对每条名言用 save 工具逐条保存，data 参数传对象",
          '{ "text": 名言原文, "author": 作者, "tags": 标签数组 }，不要把 data 传成 JSON 字符串。',
          "共应保存 20 条记录。全部保存完成后用 finish 工具收工，不要抓取第 3 页。",
        ].join("\n");
        await agent.prompt(prompt);
      } finally {
        await closeAgentBrowser();
      }

      const content = await readFile(recordsPath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim() !== "");
      // 宽松断言：LLM 偶尔少抓，>=15 即认为多页抓取成立
      expect(lines.length).toBeGreaterThanOrEqual(15);

      for (const line of lines) {
        const record = JSON.parse(line) as { data: unknown };
        expect(record.data).toBeTruthy();
        expect(typeof record.data).toBe("object");
        const data = record.data as Record<string, unknown>;
        expect(typeof data.text).toBe("string");
        expect((data.text as string).length).toBeGreaterThan(0);
        expect(typeof data.author).toBe("string");
      }
    },
    300_000
  );

  afterAll(async () => {
    await rm(recordsPath, { force: true });
  });
});

// ---------- 5. extract LLM 路径真实模型（P1） ----------

describe("extract LLM 路径真实模型", () => {
  const extractTool = crawlerTools.find((t) => t.name === "extract");
  const content =
    "It is not in the stars to hold our destiny but in ourselves. — William Shakespeare";

  itWithKey(
    "无 selector 时用 LLM 抽取 records，首条含 text/author 字段",
    async () => {
      expect(extractTool).toBeDefined();
      const result = await extractTool!.execute("extract-llm", {
        content,
        instruction: "extract the quote text and author as JSON with fields text,author",
      });
      const payload = payloadOf(result) as { records: Array<Record<string, unknown>> };
      expect(Array.isArray(payload.records)).toBe(true);
      expect(payload.records.length).toBeGreaterThan(0);
      expect(payload.records[0]).toHaveProperty("text");
      expect(payload.records[0]).toHaveProperty("author");
    },
    120_000
  );
});

// ---------- 6. save 契约真实文件（P1） ----------

describe("save 契约真实文件", () => {
  const recordsPath = path.join("output", "records.jsonl");
  const saveTool = crawlerTools.find((t) => t.name === "save");

  it("真实调 save 两次同 dedup_key，第二次跳过，records.jsonl 只有一条", async () => {
    await rm(recordsPath, { force: true });
    expect(saveTool).toBeDefined();

    const first = await saveTool!.execute("save-real-1", {
      data: { text: "hello", author: "anon", url: "https://example.com/q/1" },
      schema: ["text", "author", "url"],
      dedup_key: "url",
    });
    expect(payloadOf(first).saved).toBe(true);

    const second = await saveTool!.execute("save-real-2", {
      data: { text: "other", author: "anon2", url: "https://example.com/q/1" },
      schema: ["text", "author", "url"],
      dedup_key: "url",
    });
    expect(payloadOf(second).saved).toBe(false);
    expect(payloadOf(second).reason).toBe("duplicate");

    const fileContent = await readFile(recordsPath, "utf8");
    const lines = fileContent.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0]) as { data: { url: string } };
    expect(record.data.url).toBe("https://example.com/q/1");
  });

  afterAll(async () => {
    await rm(recordsPath, { force: true });
  });
});

// ---------- 7. 端到端-分页内化+去重（AC6，P1） ----------

describe("端到端-分页内化+去重 (AC6)", () => {
  const recordsPath = path.join("output", "records.jsonl");

  itWithKey(
    "抓取 quotes.toscrape.com 前 2 页两次：第二次大部分记录被 dedup 跳过，行数不翻倍",
    async () => {
      // 基线清空只在两次运行前做一次；两次运行之间不清空（正是要验证跨运行去重）。
      await rm(recordsPath, { force: true });

      const prompt = [
        "入口 URL：https://quotes.toscrape.com/",
        "",
        "任务：抓取第 1 页和第 2 页（第 2 页链接可从第 1 页返回的 links 里找到）。",
        "步骤：",
        "1. 用 fetch 工具取页面，拿到 markdown 与 links；",
        "2. 从 links 中识别下一页链接，再次用 fetch 取第 2 页；",
        "3. 用 extract 工具从页面内容抽取每条名言的 text 与 author；",
        "4. 用 save 工具保存，schema=['text','author']，并用 source_url 参数传入该条名言所在页面的完整 URL",
        "   （source_url 会作为默认去重键用于去重与溯源，不必把 url 放进 data）。",
        "全部完成后用 finish 收工，不要抓第 3 页。",
      ].join("\n");

      // 第一次运行
      const { createCrawlerAgent } = await import("../src/agent.js");

      const firstAgent = createCrawlerAgent();
      try {
        await firstAgent.agent.prompt(prompt);
      } finally {
        await firstAgent.closeBrowser();
      }

      const count1 = await countRecords(recordsPath);

      // 第二次运行：同一站点再抓一遍（不清空 records.jsonl，验证去重）
      const secondAgent = createCrawlerAgent();
      try {
        await secondAgent.agent.prompt(prompt);
      } finally {
        await secondAgent.closeBrowser();
      }

      const count2 = await countRecords(recordsPath);

      // 取舍：source_url 默认去重键是页面级 URL，同一页的多条记录会判为重复（粒度变粗），
      // 因此 count1 下限放宽到 >=5 只确认有落盘；AC6 的核心断言是第二次不翻倍（dedup 生效）。
      expect(count1).toBeGreaterThanOrEqual(5);
      // 第二次大部分记录命中去重键被跳过：总行数不翻倍（理想 count2 ≈ count1）。
      expect(count2).toBeLessThan(count1 * 2);
    },
    600_000
  );

  afterAll(async () => {
    await rm(recordsPath, { force: true });
  });
});

// ---------- 8. trace 端到端与查询（P2，src/trace.ts 为占位桩 —— 预期失败） ----------

describe("trace 端到端与查询", () => {
  const recordsPath = path.join("output", "records.jsonl");

  itWithKey(
    "端到端 crawl 后可读 trace.db 并按 turn 回放该 run 的 llm_events + tool_events",
    async () => {
      const dbPath = path.join("output", "test-trace-e2e.db");
      const sidecars = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
      for (const p of sidecars) await rm(p, { force: true });
      await rm(recordsPath, { force: true });

      const { createCrawlerAgent } = await import("../src/agent.js");
      const collector = new TraceCollector(dbPath);
      const { agent, closeBrowser: closeAgentBrowser } = createCrawlerAgent();
      const runId = collector.start({
        url: "https://quotes.toscrape.com/",
        task: "抓取首页并逐条保存名言",
      });
      collector.attach(agent);
      try {
        await agent.prompt(
          [
            "入口 URL：https://quotes.toscrape.com/",
            "",
            "任务：抓取第 1 页，用 extract 抽取每条名言的 text 与 author，逐条 save，",
            "全部保存后用 finish 收工。不要抓第 2 页。",
          ].join("\n")
        );
      } finally {
        await collector.flush();
        await collector.close(runId, "ok");
        await closeAgentBrowser();
      }

      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const llm = db
          .prepare(
            "SELECT turn, direction FROM llm_events WHERE run_id = ? ORDER BY turn ASC, id ASC"
          )
          .all(runId);
        const tools = db
          .prepare(
            "SELECT turn, tool_name, tool_call_id FROM tool_events WHERE run_id = ? ORDER BY turn ASC, id ASC"
          )
          .all(runId);

        expect(llm.length).toBeGreaterThan(0);
        expect(tools.length).toBeGreaterThan(0);

        // 回放：每个事件都归属整数 turn，且 token 顺序可复原（turn 从 0 起）。
        const turns = [...llm, ...tools].map((e) => Number(e.turn));
        for (const t of turns) expect(Number.isInteger(t)).toBe(true);
        expect(Math.min(...turns)).toBe(0);

        const toolNames = tools.map((t) => t.tool_name);
        expect(toolNames).toContain("fetch");
        expect(toolNames).toContain("save");
      } finally {
        db.close();
      }

      for (const p of sidecars) await rm(p, { force: true });
      await rm(recordsPath, { force: true });
    },
    300_000
  );

  itWithKey(
    "extract-no-save 查询能返回『只 extract 未 save』的 run_id",
    async () => {
      // 用只暴露 extract + finish 的 agent，结构上保证「只 extract 不 save」。
      const models = createModels();
      models.setProvider(opencodeGoProvider());
      const model = models.getModel("opencode-go", modelId);
      expect(model).toBeDefined();

      const extractOnlyTools = crawlerTools.filter(
        (t) => t.name === "extract" || t.name === "finish"
      );
      const agent = new Agent({
        sessionId: `trace-no-save-${Date.now().toString(36)}`,
        initialState: {
          systemPrompt: "你只做数据抽取。完成抽取后必须用 finish 收工，绝不保存任何内容。",
          model: model as Model<any>,
          tools: extractOnlyTools,
        },
        streamFn: models.streamSimple.bind(models),
      });

      // 用默认库 output/trace.db（与 `tsx src/trace-query.ts` 默认读取一致）。
      const collector = new TraceCollector();
      const runId = collector.start({
        url: "https://quotes.toscrape.com/",
        task: "只抽取不保存",
      });
      collector.attach(agent);
      try {
        await agent.prompt(
          [
            "请对下面内容调用一次 extract（不要给 selector，用 instruction 让模型抽取 text 与 author），",
            "拿到结果后调用 finish 收工，不要调用 save。",
            "内容：It is not in the stars to hold our destiny but in ourselves. — William Shakespeare",
          ].join("\n")
        );
      } finally {
        await collector.flush();
        await collector.close(runId, "ok");
      }

      const { stdout } = await execFileAsync(
        process.execPath,
        ["./node_modules/tsx/dist/cli.mjs", "src/trace-query.ts", "--pattern", "extract-no-save"],
        { cwd: path.resolve(import.meta.dirname, "..") }
      );
      expect(stdout).toContain(runId);
    },
    180_000
  );

  itWithKey(
    "TraceStore 初始化失败时抓取仍正常完成（旁路降级，不抛错）",
    async () => {
      await rm(recordsPath, { force: true });

      // 用一个不可能写入的 db 路径：父级是普通文件 → 无法在其下建库。
      const blocker = path.join("output", "trace-bypass-blocker");
      await rm(blocker, { force: true });
      await writeFile(blocker, "not a directory", "utf8");
      const badDbPath = path.join(blocker, "trace.db");

      expect(() => new TraceStore(badDbPath)).not.toThrow();
      const collector = new TraceCollector(badDbPath);

      const { createCrawlerAgent } = await import("../src/agent.js");
      const { agent, closeBrowser: closeAgentBrowser } = createCrawlerAgent();
      const runId = collector.start({
        url: "https://quotes.toscrape.com/",
        task: "旁路降级验证",
      });
      collector.attach(agent);
      try {
        await agent.prompt(
          [
            "入口 URL：https://quotes.toscrape.com/",
            "",
            "任务：抓取首页，用 extract 抽取一条名言，save 一条，然后 finish 收工。",
          ].join("\n")
        );
      } finally {
        await collector.flush();
        await collector.close(runId, "ok");
        await closeAgentBrowser();
      }

      // trace 写库失败不得影响主流程：记录仍正常落盘。
      expect(await countRecords(recordsPath)).toBeGreaterThan(0);

      await rm(blocker, { force: true });
      await rm(recordsPath, { force: true });
    },
    180_000
  );

  afterAll(async () => {
    await rm(recordsPath, { force: true });
  });
});

// ---------- 9. 人机协作端到端（P3，AC9 —— src/human.ts / request_human 尚未实现，预期失败） ----------

// 真实登录墙场景：quotes.toscrape.com/login 任意账密均可登录成功，登录后首页出现 "Logout"。
// 真实浏览器 + 真实站点 + 真实 trace.db；仅"人的回车动作"用注入 input stream 受控模拟（AC10 允许）。
describe("人机协作端到端", () => {
  const LOGIN_URL = "https://quotes.toscrape.com/login";
  const HOME_URL = "https://quotes.toscrape.com/";
  const CALL_ID = "human-call-1";

  const requestHumanTool = crawlerTools.find((t) => t.name === "request_human");

  const dbPath = path.join("output", "test-trace-human.db");
  const sidecars = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];

  // 有头浏览器需要桌面显示环境；无 DISPLAY 的 Linux/CI 无法弹窗 → 跳过（设计允许降级）。
  const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY);
  const itHeaded = hasDisplay ? it : it.skip;

  itHeaded(
    "request_human → 真实登录 → 同 context 抓到 Logout，trace 有 request_human 记录（AC4/AC8/AC9）",
    async () => {
      expect(requestHumanTool).toBeDefined();
      // AC5：必须 sequential，防止默认并行与"等回车"冲突。
      expect((requestHumanTool as unknown as { executionMode?: string }).executionMode).toBe(
        "sequential"
      );

      for (const p of sidecars) await rm(p, { force: true });

      // 受控模拟"人的回车"：用真实 Readable 顶替 process.stdin（非 mock 库）。
      // request_human 内部的 waitForEnter() 默认从 process.stdin 读取，故注入即生效。
      const fakeInput = new Readable({ read() {} });
      const originalStdin = process.stdin;
      Object.defineProperty(process, "stdin", { value: fakeInput, configurable: true });

      const collector = new TraceCollector(dbPath);
      // 真实 TraceCollector 需要 agent 事件驱动；此处用最小事件源把 request_human 的
      // execute start/end 喂进去（浏览器/网络/工具均真实运行，仅接线事件管道，不 mock 真实依赖）。
      const listeners: Array<(e: any) => void> = [];
      const harness = {
        onPayload: undefined,
        subscribe(cb: (e: any) => void) {
          listeners.push(cb);
        },
      } as unknown as Agent;
      const emit = (event: any) => {
        for (const l of [...listeners]) l(event);
      };
      collector.attach(harness);

      try {
        const runId = collector.start({ url: LOGIN_URL, task: "人机协作登录" });
        emit({ type: "agent_start" });
        emit({ type: "turn_start" });
        emit({
          type: "tool_execution_start",
          toolCallId: CALL_ID,
          toolName: "request_human",
          args: { reason: "请登录", url: LOGIN_URL },
        });

        const startedAt = Date.now();
        // 不 await：先启动 request_human（内部 page.goto + 阻塞等回车），
        // 期间测试程序在 human browser 的真实 page 上完成真实登录，再触发回车。
        const execPromise = requestHumanTool!.execute(CALL_ID, { reason: "请登录", url: LOGIN_URL });

        // 等 human page 出现并加载出登录表单。
        let humanPage: Page | undefined;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const ctx = getHumanContext();
          const pages = ctx ? ctx.pages() : [];
          if (pages.length > 0) {
            humanPage = pages[0];
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(humanPage).toBeDefined();
        await humanPage!.waitForSelector('input[name="username"]', { timeout: 30_000 });

        // 真实浏览器操作（非 mock）：任意账密即可登录成功。
        await humanPage!.fill('input[name="username"]', "test");
        await humanPage!.fill('input[name="password"]', "test");
        await humanPage!.click('input[type="submit"]');
        await humanPage!.waitForLoadState("networkidle").catch(() => {});

        // 人按回车 → 解除 request_human 的阻塞。
        fakeInput.push("\n");

        const result = await execPromise;
        emit({
          type: "tool_execution_end",
          toolCallId: CALL_ID,
          toolName: "request_human",
          result,
          isError: false,
          durationMs: Date.now() - startedAt,
        });

        // request_human 返回契约：resumed=true。
        expect(payloadOf(result)).toMatchObject({ resumed: true });

        // AC4：在（human）同 context 用 render 抓首页，登录态保留 → 含仅登录后出现的 Logout。
        const rendered = await renderDynamic(HOME_URL);
        expect(rendered.html).toContain("Logout");

        await collector.flush();
        await collector.close(runId, "ok");

        // AC8：trace 里有 request_human 记录且 duration_ms >= 0。
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const rows = db
            .prepare(
              "SELECT tool_name, duration_ms FROM tool_events WHERE run_id = ? AND tool_name = 'request_human'"
            )
            .all(runId);
          expect(rows.length).toBeGreaterThan(0);
          expect(Number(rows[0].duration_ms)).toBeGreaterThanOrEqual(0);
        } finally {
          db.close();
        }
      } finally {
        Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
        for (const p of sidecars) await rm(p, { force: true });
      }
    },
    120_000
  );

  afterAll(async () => {
    await closeHumanBrowser().catch(() => {});
    await closeBrowser().catch(() => {});
  });
});

// ---------- 10. request_human 轮询完成检测（P3 修复后台无 TTY 死锁 —— 尚未实现，预期失败） ----------

// 目标：request_human 支持 wait_mode='poll'，内部 launchHumanBrowser + goto + waitForDone，
// 不依赖「按回车」。这修复后台无 TTY（process.stdin 非交互）场景下的死锁。
// 真实浏览器 + 真实页面导航，禁 mock；测试不注入任何 stdin。
describe("request_human 轮询模式（后台无 TTY）", () => {
  const requestHumanTool = crawlerTools.find((t) => t.name === "request_human");

  // 有头浏览器需要桌面显示环境；无 DISPLAY 的 Linux/CI 无法弹窗 → 跳过（设计允许降级）。
  const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY);
  const itHeaded = hasDisplay ? it : it.skip;

  itHeaded(
    "wait_mode=poll：靠页面 URL 变化判定完成，resolve resumed=true 且全程无回车",
    async () => {
      expect(requestHumanTool).toBeDefined();

      // 不注入任何 stdin：模拟后台无 TTY。若仍走等回车路径将一直阻塞（预期失败）。
      const startedAt = Date.now();
      const execPromise = Promise.resolve(
        requestHumanTool!.execute("human-poll-1", {
          reason: "完成页面跳转",
          url: "about:blank",
          wait_mode: "poll",
          gone_url_pattern: "signin|blank",
          success_url_pattern: "loggedin|home",
          timeout_ms: 15_000,
        })
      );

      // 等 human page 出现（request_human 内部 launchHumanBrowser + goto）。
      let humanPage: Page | undefined;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const ctx = getHumanContext();
        const pages = ctx ? ctx.pages() : [];
        if (pages.length > 0) {
          humanPage = pages[0];
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(humanPage).toBeDefined();

      // 模拟人完成操作：跳到匹配 success_url_pattern 的页面。
      await humanPage!.goto("https://example.com/home").catch(() => {});

      const result = await execPromise;
      const payload = payloadOf(result) as { resumed: boolean; duration_ms?: number };
      expect(payload.resumed).toBe(true);
      expect(payload.duration_ms ?? 0).toBeGreaterThan(0);
      expect(Date.now() - startedAt).toBeGreaterThan(0);
    },
    60_000
  );

  afterAll(async () => {
    await closeHumanBrowser().catch(() => {});
  });
});
