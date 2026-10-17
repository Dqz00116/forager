import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { FetchError, RenderError } from "./errors.js";
import { getHumanContext } from "./human.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 pi-crawler/0.1";

export interface FetchedPage {
  url: string;
  html: string;
  status: number;
}

/** 静态抓取：全局 fetch + 合理 UA。网络错误或非 2xx 抛错（由 agent 决定是否改走动态渲染）。 */
export async function fetchStatic(url: string): Promise<FetchedPage> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });
  } catch (err) {
    throw new FetchError(`fetchStatic: 请求失败 ${url} — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new FetchError(`fetchStatic: HTTP ${res.status} ${url}`, res.status);
  }
  const html = await res.text();
  return { url: res.url || url, html, status: res.status };
}

// ---------- 动态渲染（playwright chromium 单例） ----------

let browserPromise: Promise<Browser> | null = null;

// 共享 context 单例：承载登录态等跨调用状态，随 closeBrowser 一起清理。
let sharedContextPromise: Promise<BrowserContext> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

/** 共享 context 单例：首次 newContext()，后续复用同一实例。
 *  传 browser 时用该 browser（测试用）；缺省时用 page.ts 的 headless browser 单例。 */
export async function getSharedContext(browser?: Browser): Promise<BrowserContext> {
  if (!sharedContextPromise) {
    const target = browser ?? (await getBrowser());
    sharedContextPromise = target.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
    });
  }
  return sharedContextPromise;
}

/** 进程退出前调用；未启动过 browser 时为空操作。 */
export async function closeBrowser(): Promise<void> {
  const pendingContext = sharedContextPromise;
  sharedContextPromise = null;
  if (pendingContext) {
    try {
      const context = await pendingContext;
      await context.close();
    } catch {
      // context 已关闭/创建失败时忽略
    }
  }
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    // 启动失败/已崩溃时忽略，保证清理路径不抛
  }
}

export interface RenderedPage {
  url: string;
  html: string;
  screenshot?: Buffer;
}

async function renderWithContext(context: BrowserContext, url: string): Promise<RenderedPage> {
  const page = await context.newPage();
  try {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    } catch {
      // networkidle 超时（长轮询/心跳页面）很常见，降级用当前已渲染内容
    }
    const html = await page.content();
    const screenshot = await page.screenshot({ fullPage: false });
    return { url: page.url(), html, screenshot };
  } finally {
    await page.close();
  }
}

/** 在指定 context 中渲染（复用该 context 的页面或新建 page），不关闭该 context。 */
export async function renderInContext(context: BrowserContext, url: string): Promise<RenderedPage> {
  try {
    return await renderWithContext(context, url);
  } catch (err) {
    throw new RenderError(
      `renderInContext: 渲染失败 ${url} — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * 动态渲染：无头 chromium，等待 networkidle（超时则降级取已加载内容）。
 * 传 context 时在该 context 中渲染（不新建不关闭，登录态可复用）；
 * 不传 context 时：若存在 human context（人已登录）则复用它延续登录态，
 * 否则沿用原有「每次新建 context，用完关闭」的行为。
 */
export async function renderDynamic(url: string, context?: BrowserContext): Promise<RenderedPage> {
  if (context) {
    return renderInContext(context, url);
  }
  const humanContext = getHumanContext();
  if (humanContext) {
    return renderInContext(humanContext, url);
  }
  let ctx: BrowserContext;
  let page: Page;
  try {
    const browser = await getBrowser();
    ctx = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
    });
    page = await ctx.newPage();
  } catch (err) {
    throw new RenderError(`renderDynamic: 启动浏览器或打开页面失败 ${url} — ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    } catch {
      // networkidle 超时（长轮询/心跳页面）很常见，降级用当前已渲染内容
    }
    const html = await page.content();
    const screenshot = await page.screenshot({ fullPage: false });
    return { url: page.url(), html, screenshot };
  } finally {
    await ctx.close();
  }
}

// ---------- HTML -> LLM 视图（markdown + 链接） ----------

export interface PageLink {
  text: string;
  /** 相对 base 的绝对 URL；无法解析时跳过 */
  href: string;
}

export interface LLMPageView {
  markdown: string;
  links: PageLink[];
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

/** 提取页面所有链接，href 基于 baseUrl 绝对化。 */
export function extractLinks(html: string, baseUrl: string): PageLink[] {
  const $ = cheerio.load(html);
  const links: PageLink[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const abs = new URL(href, baseUrl).toString();
      const text = ($(el).text() || $(el).attr("title") || "").replace(/\s+/g, " ").trim();
      links.push({ text, href: abs });
    } catch {
      // 非法 href（javascript: 之类解析失败的）直接跳过
    }
  });
  return links;
}

/** HTML -> markdown，同时给出链接列表。 */
export function pageToLLMView(url: string, html: string): LLMPageView {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();
  const markdown = turndown.turndown($.html()).replace(/\n{3,}/g, "\n\n").trim();
  return { markdown, links: extractLinks(html, url) };
}
