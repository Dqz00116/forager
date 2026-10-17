/**
 * P3 人机协作 —— 生产实现（T2）。
 *
 * 提供：
 *   waitForEnter(prompt, input?)   基于 node:readline/promises；input 可注入（默认 process.stdin）
 *   launchHumanBrowser()           有头 chromium 单例：browser + context + page
 *   getHumanContext()              人操作后的共享 context（未启动返回 undefined）
 *   closeHumanBrowser()            关闭有头 browser（幂等、清理路径不抛）
 *
 * 说明：human browser 使用独立单例，与 page.ts 的无头 browser 完全分开，
 * human.ts 不 import page.ts，避免循环依赖。
 */
import { createInterface } from "node:readline/promises";
import type { Readable } from "node:stream";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/** 阻塞等待用户按回车后 resolve。input 缺省用 process.stdin，可注入 Readable（测试用）。 */
export async function waitForEnter(prompt: string, input?: Readable): Promise<void> {
  const stream = input ?? process.stdin;
  const rl = createInterface({ input: stream, output: process.stdout });
  try {
    await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export interface WaitForDoneOptions {
  timeout_ms?: number;
  interval_ms?: number;
  success_url_pattern?: string | RegExp;
  gone_url_pattern?: string | RegExp;
  success_selector?: string;
  gone_selector?: string;
}

export interface WaitForDoneResult {
  elapsed_ms: number;
  timed_out?: boolean;
  /** 窗口/context 被关闭（人离开）时为 true，区别于 timed_out（超时）。 */
  closed?: boolean;
}

/**
 * 轮询检测"人已完成"：周期性检查页面 URL / 元素是否满足任一完成条件，
 * 满足即返回 elapsed_ms；超时返回 { timed_out: true }（不抛，便于调用方重试或再求助）。
 * 支持 abort（signal.aborted 时抛错）。后台无 TTY 场景下替代"等回车"。
 */
export async function waitForDone(
  page: Page,
  options: WaitForDoneOptions = {},
  signal?: AbortSignal
): Promise<WaitForDoneResult> {
  const {
    timeout_ms = 300_000,
    interval_ms = 2_000,
    success_url_pattern,
    gone_url_pattern,
    success_selector,
    gone_selector,
  } = options;
  const start = Date.now();
  const toRe = (p: string | RegExp): RegExp => (p instanceof RegExp ? p : new RegExp(p));
  while (true) {
    if (signal?.aborted) throw new Error("aborted");
    // 超时：返回事实而非抛错，让 agent 拿到超时后重试或再求助
    if (Date.now() - start > timeout_ms) {
      return { elapsed_ms: Date.now() - start, timed_out: true };
    }
    // 窗口关闭检测：人手动关窗/关 context 后 page.isClosed() 为 true（同步不抛），
    // 此时 page.url() 可能返回缓存旧 URL 不抛错，必须显式判断，避免傻等到超时。
    if (page.isClosed()) {
      return { elapsed_ms: Date.now() - start, timed_out: false, closed: true };
    }
    let done = false;
    try {
      const url = page.url();
      if (success_url_pattern && toRe(success_url_pattern).test(url)) done = true;
      if (gone_url_pattern && !toRe(gone_url_pattern).test(url)) done = true;
      if (success_selector && (await page.$(success_selector))) done = true;
      if (gone_selector && !(await page.$(gone_selector))) done = true;
    } catch (err) {
      // page 操作抛 TargetClosedError（如 page.$ 在窗口关闭后）同样视为窗口已关闭。
      const message = String((err as Error)?.message ?? err);
      if (/has been closed|Target page, context or browser/i.test(message)) {
        return { elapsed_ms: Date.now() - start, timed_out: false, closed: true };
      }
      throw err;
    }
    if (done) return { elapsed_ms: Date.now() - start, timed_out: false };
    await new Promise((r) => setTimeout(r, interval_ms));
  }
}

export interface HumanBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

let humanBrowserPromise: Promise<HumanBrowser> | null = null;
let humanContext: BrowserContext | undefined;

async function createHumanBrowser(): Promise<HumanBrowser> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  humanContext = context;
  const page = await context.newPage();
  return { browser, context, page };
}

/** 启动（或复用）有头 chromium 单例，供人工完成登录/验证码等操作。 */
export async function launchHumanBrowser(): Promise<HumanBrowser> {
  if (!humanBrowserPromise) {
    humanBrowserPromise = createHumanBrowser();
  }
  try {
    return await humanBrowserPromise;
  } catch (err) {
    // 启动失败时重置，允许后续重试
    humanBrowserPromise = null;
    humanContext = undefined;
    throw err;
  }
}

/** 返回 human browser 的 context（人登录后的登录态）；未启动时返回 undefined。 */
export function getHumanContext(): BrowserContext | undefined {
  return humanContext;
}

/** 关闭 human browser 并清理单例；未启动或重复调用均为空操作。 */
export async function closeHumanBrowser(): Promise<void> {
  const pending = humanBrowserPromise;
  humanBrowserPromise = null;
  humanContext = undefined;
  if (!pending) return;
  try {
    const { browser } = await pending;
    await browser.close();
  } catch {
    // 启动失败/已崩溃时忽略，保证清理路径不抛
  }
}
