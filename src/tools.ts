import { mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fetchStatic, renderDynamic, pageToLLMView } from "./page.js";
import { llmExtract } from "./extract-llm.js";
import { launchHumanBrowser, waitForDone, waitForEnter } from "./human.js";

const RECORDS_PATH = path.join("output", "records.jsonl");
const MARKDOWN_LIMIT = 12_000;

// 泛型辅助：让每个工具的 execute 参数按自己的 TypeBox schema 推导类型
function defineTool<TParameters extends TSchema>(tool: AgentTool<TParameters>): AgentTool<TParameters> {
  return tool;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[...已截断，原文共 ${text.length} 字符]`;
}

function textResult(payload: unknown): AgentToolResult<any> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

// 记录文件的容错读取：文件不存在按 0 行处理，坏行跳过。
async function readRecords(): Promise<any[]> {
  let content: string;
  try {
    content = await readFile(RECORDS_PATH, "utf8");
  } catch {
    return [];
  }
  const records: any[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // 跳过无法解析的行
    }
  }
  return records;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 抽出 "内容字段" 是否全空：dedup_key 本身不计内容。
function isAllEmpty(data: unknown, schema: string[] | undefined, dedupKey: string | undefined): boolean {
  const obj = isPlainObject(data) ? data : {};
  const fields = schema
    ? schema.filter((f) => f !== dedupKey)
    : Object.keys(obj).filter((k) => k !== dedupKey);
  return fields.every((f) => {
    const v = obj[f];
    return !v || (typeof v === "string" && v.trim() === "");
  });
}

// selector 支持可选的 "::attr(x)" 后缀（如 ".item a::attr(href)"）。
function parseSelector(selector: string): { selector: string; attr?: string } {
  const marker = "::attr(";
  const idx = selector.indexOf(marker);
  if (idx === -1) return { selector };
  return {
    selector: selector.slice(0, idx),
    attr: selector.slice(idx + marker.length).replace(/\)\s*$/, "").trim(),
  };
}

export const crawlerTools: AgentTool<any>[] = [
  defineTool({
    name: "fetch",
    label: "抓取页面",
    description:
      "抓取一个网页并转为 markdown 视图。默认静态抓取；静态抓取失败或返回内容明显不足时，用 render=true 改走无头浏览器渲染重取。返回的 links 可用于识别『下一页』等分页链接，并再次调用 fetch 翻页。",
    parameters: Type.Object({
      url: Type.String({ description: "要抓取的完整 URL（含 http/https）" }),
      render: Type.Optional(
        Type.Boolean({ description: "true 时用无头 chromium 动态渲染（JS 页面）；默认 false 静态抓取" })
      ),
    }),
    execute: async (_toolCallId, args) => {
      const page = args.render ? await renderDynamic(args.url) : await fetchStatic(args.url);
      const { markdown, links } = pageToLLMView(page.url, page.html);
      return textResult({
        url: page.url,
        // 动态渲染没有 HTTP 状态概念，视为 200
        status: "status" in page ? page.status : 200,
        markdown: truncate(markdown, MARKDOWN_LIMIT),
        links,
      });
    },
  }),
  defineTool({
    name: "extract",
    label: "抽取数据",
    description:
      "从页面内容中抽取结构化记录。结构明确时给 selector（CSS 选择器，遍历匹配元素取文本；支持 '::attr(x)' 后缀取属性），直接返回 {text:string[]}，不调用 LLM。结构模糊时不给 selector，改给 instruction 描述要抽什么，由 LLM 抽取并返回 {records: 对象数组}。",
    parameters: Type.Object({
      content: Type.String({ description: "要抽取的页面文本/markdown 内容" }),
      instruction: Type.String({ description: "抽取指令：想要哪些字段、什么结构（如 '抽取每条名言的 text 与 author'）" }),
      selector: Type.Optional(
        Type.String({
          description: "可选 CSS 选择器；给了就走确定性提取返回 text 数组，不给则走 LLM 返回 records",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      if (args.selector) {
        const { selector, attr } = parseSelector(args.selector);
        const $ = cheerio.load(args.content);
        const text: string[] = [];
        $(selector).each((_, el) => {
          const raw = attr ? $(el).attr(attr) ?? "" : $(el).text();
          const value = raw.trim();
          if (value !== "") text.push(value);
        });
        return textResult({ text, count: text.length, hint: `抽取出 ${text.length} 条，请逐条调用 save 落盘` });
      }
      const records = await llmExtract(args.content, args.instruction);
      return textResult({
        records,
        count: records.length,
        hint: `抽取出 ${records.length} 条记录，请逐条调用 save 落盘（data 用记录字段，source_url 用来源页 URL）`,
      });
    },
  }),
  defineTool({
    name: "save",
    label: "保存记录",
    description:
      "把一条结构化记录（JSON 对象）追加保存到 output/records.jsonl，带数据契约：可传 schema（必含字段名列表）校验结构、dedup_key（如 'url'）去重、自动丢弃内容字段全空的记录。source_url 传入记录来源页的完整 URL：既作为默认去重键（dedup_key 缺省时等价于 'url'），也在 data 缺少 url 时注入到 url 字段用于溯源。返回 {saved, count, reason?}。",
    parameters: Type.Object({
      data: Type.Unknown({ description: "要保存的结构化数据（JSON 对象）" }),
      schema: Type.Optional(
        Type.Array(Type.String(), { description: "必含字段名列表；data 缺少任一字段则拒存（reason=schema_missing）" })
      ),
      dedup_key: Type.Optional(
        Type.String({ description: "去重键（如 'url'）；已存在同键记录则跳过（reason=duplicate）。缺省时若给了 source_url 则用 'url'" })
      ),
      source_url: Type.Optional(
        Type.String({ description: "记录来源页的完整 URL：作为默认去重键，并在 data 缺少 url 时注入到 url 字段用于溯源" })
      ),
    }),
    execute: async (_toolCallId, args) => {
      // 1. 双重编码还原：LLM 有时把 data 传成 JSON 字符串，尝试解析回对象
      let value: unknown = args.data;
      if (typeof value === "string") {
        const s = value.trim();
        if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
          try {
            value = JSON.parse(s);
          } catch {
            /* 保留原字符串 */
          }
        }
      }

      // 2. source_url 注入：data 是对象且 url 缺失时，用来源页 URL 补 url（不覆盖已有 url）
      if (args.source_url && isPlainObject(value)) {
        if (value.url === undefined || value.url === null || value.url === "") {
          value.url = args.source_url;
        }
      }

      // 有效去重键：显式 dedup_key 优先，否则有 source_url 时默认 'url'
      const dedupKey = args.dedup_key ?? (args.source_url ? "url" : undefined);

      const records = await readRecords();
      const count = records.length;

      // 3. schema 校验：data 为对象时，必须包含全部 schema 字段
      if (args.schema && isPlainObject(value) && !args.schema.every((f) => f in value)) {
        return textResult({ saved: false, reason: "schema_missing", count });
      }

      // 4. 全空过滤：内容字段（不含 dedup_key）全空则拒存
      if (isAllEmpty(value, args.schema, dedupKey)) {
        return textResult({ saved: false, reason: "all_empty", count });
      }

      // 5. 去重：已存在同 dedup_key 值的记录则跳过
      if (dedupKey && isPlainObject(value)) {
        const keyValue = value[dedupKey];
        const duplicate = records.some(
          (r) => isPlainObject(r?.data) && r.data[dedupKey] === keyValue
        );
        if (duplicate) {
          return textResult({ saved: false, reason: "duplicate", count });
        }
      }

      // 6. 落盘
      await mkdir(path.dirname(RECORDS_PATH), { recursive: true });
      const record = { savedAt: new Date().toISOString(), data: value };
      await appendFile(RECORDS_PATH, JSON.stringify(record) + "\n", "utf8");
      return textResult({ saved: true, count: count + 1 });
    },
  }),
  defineTool({
    name: "list_saved",
    label: "查看已存记录",
    description: "查看已保存的记录数和存储文件路径。",
    parameters: Type.Object({}),
    execute: async () => {
      let count = 0;
      try {
        const content = await readFile(RECORDS_PATH, "utf8");
        count = content.split("\n").filter((line) => line.trim() !== "").length;
      } catch {
        count = 0; // 文件还不存在
      }
      return textResult({ count, path: RECORDS_PATH });
    },
  }),
  defineTool({
    name: "request_human",
    label: "请求人工",
    description:
      "遇到登录墙、验证码、权限墙、拖拽等需要真人操作的复杂交互时调用：打开有头浏览器并导航到 url，提示人完成。完成信号有两种模式：wait_mode='poll'（默认推荐，后台/无人值守可用）按给定的客观条件（success_url_pattern/gone_url_pattern/success_selector/gone_selector）自动轮询检测人完成，无需回车；wait_mode='enter'（前台有人值守）等人在终端按回车。人完成操作后返回 {resumed:true,...}，其登录态会在后续 render 抓取中自动延续。",
    parameters: Type.Object({
      reason: Type.String({ description: "需要人做什么（如『请登录该站点』『请完成验证码』）" }),
      url: Type.String({ description: "供人操作的页面完整 URL（含 http/https）" }),
      wait_mode: Type.Optional(
        Type.String({
          description:
            "完成检测模式：'poll' 自动轮询客观条件（后台/无人值守推荐，无需回车）；'enter' 等前台回车。默认 'enter'",
        })
      ),
      success_url_pattern: Type.Optional(
        Type.String({ description: "poll 模式：当前 URL 匹配此正则即视为人已完成（如 'loggedin|home'）" })
      ),
      gone_url_pattern: Type.Optional(
        Type.String({ description: "poll 模式：当前 URL 不再匹配此正则即视为人已完成（如离开登录页 'signin'）" })
      ),
      success_selector: Type.Optional(
        Type.String({ description: "poll 模式：页面出现此 CSS 选择器即视为人已完成" })
      ),
      gone_selector: Type.Optional(
        Type.String({ description: "poll 模式：此 CSS 选择器从页面消失即视为人已完成" })
      ),
      timeout_ms: Type.Optional(
        Type.Number({ description: "poll 模式：轮询超时毫秒数，默认 300000（5 分钟）" })
      ),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, args, signal) => {
      const startedAt = Date.now();
      const { page } = await launchHumanBrowser();
      await page
        .goto(args.url, { waitUntil: "domcontentloaded", timeout: 60_000 })
        .catch(() => {
          // 导航超时/失败不阻断：浏览器已打开，人仍可手动刷新操作
        });
      console.log(`\n【需要人工】${args.reason}\n请在打开的浏览器窗口中操作：${args.url}\n`);

      // poll 模式：自动轮询客观条件检测人完成，后台无 TTY 也可用
      if (args.wait_mode === "poll") {
        console.log("（agent 将自动检测人完成并继续，无需回车）\n");
        const result = await waitForDone(
          page,
          {
            timeout_ms: args.timeout_ms,
            success_url_pattern: args.success_url_pattern,
            gone_url_pattern: args.gone_url_pattern,
            success_selector: args.success_selector,
            gone_selector: args.gone_selector,
          },
          signal
        );
        if (result.closed) {
          return textResult({
            resumed: false,
            closed: true,
            message: `人工操作中断：用户关闭了浏览器窗口/离开了（${args.reason}）。可重新调用 request_human 再次求助，或改走其他方案。`,
            human_action: args.reason,
            duration_ms: result.elapsed_ms,
          });
        }
        return textResult({
          resumed: true,
          message: `人工操作${result.timed_out ? "检测超时" : "已完成"}：${args.reason}`,
          human_action: args.reason,
          duration_ms: result.elapsed_ms,
          timed_out: result.timed_out,
        });
      }

      // enter 模式（兼容）：等前台回车
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("request_human: 已中止（abort）"));
          return;
        }
        const onAbort = () => reject(new Error("request_human: 已中止（abort）"));
        signal?.addEventListener("abort", onAbort, { once: true });
        waitForEnter("完成后请按回车继续…").then(
          () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
          (err) => {
            signal?.removeEventListener("abort", onAbort);
            reject(err);
          }
        );
      });
      const duration_ms = Date.now() - startedAt;
      const message = `人工操作已完成：${args.reason}`;
      return textResult({
        resumed: true,
        message,
        human_action: args.reason,
        duration_ms,
      });
    },
  }),
  defineTool({
    name: "finish",
    label: "收工",
    description:
      "宣告任务完成并给出总结。前置条件：本次所有 extract 抽取的记录必须已全部通过 save 落盘，并已用 list_saved 确认数量一致；若还有未保存的抽取结果，禁止调用 finish。summary 需写明实际保存的条数。",
    parameters: Type.Object({
      summary: Type.String({ description: "本次任务的完成总结：做了什么、找到/保存了多少条记录" }),
    }),
    execute: async (_toolCallId, args) => {
      // 语义标记：实际终止由 agent 循环自然结束
      return textResult({ done: true, summary: args.summary });
    },
  }),
];
