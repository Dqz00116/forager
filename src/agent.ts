import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { apiKey, modelId } from "./config.js";
import { crawlerTools } from "./tools.js";
import { closeBrowser } from "./page.js";
import { ModelError } from "./errors.js";
import type { TraceCollector } from "./trace.js";

const SYSTEM_PROMPT = `你是一个自主探索式网页爬虫 agent。你的核心工具是 fetch（取页面）、extract（抽数据）、save（存记录），工作方式：

1. 从给定的入口 URL 开始，用 fetch 工具抓取页面，阅读返回的 markdown 内容和 links 链接列表。
2. fetch 默认静态抓取；当静态抓取失败、返回状态异常，或 markdown 内容明显为空/只剩骨架时，用 render=true 重取同一 URL。
3. 列表页/分页：从 fetch 返回的 links 里识别『下一页』等分页链接，再次调用 fetch 翻页，尽量覆盖全部条目。
4. 抽取数据用 extract：页面结构明确时给 selector（CSS 选择器）走确定性提取；结构模糊时不给 selector，改给 instruction 描述字段与结构，由 LLM 抽取。
5. 保存用 save：统一传入 schema（必含字段名列表）与 source_url（该记录来源页的完整 URL，来自 fetch 返回的 url），让工具做结构校验与去重；data 里放 extract 抽出的字段（如 text/author），不必自己塞 url；dedup_key 缺省时即用 source_url 作为去重键。一条记录一次调用。硬性要求：只要 extract 返回了非空记录（text 数组或 records 数组），就必须对每一条调用一次 save 落盘，不能跳过。
6. 用 list_saved 确认已保存的记录数量与文件。
7. 规划好抓取顺序，不要重复抓取同一 URL；与任务无关的链接不要跟进。
8. finish 前必须先确认：本任务所有 extract 抽到的记录都已通过 save 落盘，并用 list_saved 核对 count 与预期条数一致；只要还有抽到的记录没保存，就绝不能 finish。确认无更多内容且全部落盘后，用 finish 给出总结收工，summary 里必须写明实际保存的条数（与 list_saved 的 count 对应）。
9. 遇到登录墙、验证码、权限墙、拖拽等需要真人操作的复杂交互时，调用 request_human：reason 说明需要人做什么，url 传给人操作的页面地址。优先用 wait_mode='poll'，并给出判断"人已完成"的客观条件（如登录后 gone_url_pattern='signin' 表示离开登录页即完成，或 success_selector 出现登录后标记）；后台/无人值守场景尤其必须用 poll，因为回车信号收不到。前台有人值守时也可用 wait_mode='enter' 等回车。无论哪种模式，返回 resumed=true 后其登录态已保留在浏览器上下文中；随后用 fetch 的 render=true（或 render）继续抓取目标页，会自动带上登录态，无需重新登录。

保持节制的抓取节奏，把精力放在任务要求的数据上。`;

export function createCrawlerAgent(trace?: TraceCollector) {
  const models = createModels();
  models.setProvider(opencodeGoProvider());

  const model = models.getModel("opencode-go", modelId);
  if (!model) {
    throw new ModelError(
      `模型 "${modelId}" 不在 opencode-go 提供商目录中。请检查 .env 的 CRAWLER_MODEL，或用 pi-ai 的模型目录查看可用 ID。`
    );
  }

  const agent = new Agent({
    // OpenCode Go 端点要求 x-opencode-session 头用于会话路由，
    // pi-ai 的 withOpenCodeSessionHeader 会从 options.sessionId 自动注入该头。
    sessionId: process.env.OPENCODE_SESSION_ID?.trim() || `crawler-${Date.now().toString(36)}`,
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: crawlerTools,
    },
    streamFn: models.streamSimple.bind(models),
  });

  if (trace) trace.attach(agent);

  return { agent, closeBrowser };
}
