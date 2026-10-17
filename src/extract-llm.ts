import { createModels } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { ModelError } from "./errors.js";

const MARKDOWN_LIMIT = 12_000;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[...已截断，原文共 ${text.length} 字符]`;
}

const SYSTEM_PROMPT =
  "你是一个数据抽取器。根据用户的抽取指令，从给定内容中抽取结构化记录。" +
  "只输出一个 JSON 数组（例如 [{\"field\":\"value\"}]），不要任何解释、markdown 代码块或多余文字。";

/** 从模型回复中提取 JSON 数组：取第一个 [ 到最后一个 ]。 */
function parseJsonArray(reply: string): unknown[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new ModelError(`llmExtract: 模型回复中未找到 JSON 数组 — ${reply.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch (err) {
    throw new ModelError(
      `llmExtract: JSON 解析失败 — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ModelError("llmExtract: 模型输出不是 JSON 数组");
  }
  return parsed;
}

/** 独立一次 LLM 调用（不经 agent loop）：按 instruction 从 content 抽取记录数组。 */
export async function llmExtract(content: string, instruction: string): Promise<unknown[]> {
  const models = createModels();
  models.setProvider(opencodeGoProvider());

  const modelId = process.env.CRAWLER_MODEL?.trim() || "muse-spark-1.3-contributor";
  const model = models.getModel("opencode-go", modelId);
  if (!model) {
    throw new ModelError(`llmExtract: 模型 "${modelId}" 不在 opencode-go 提供商目录中。`);
  }

  const userPrompt = [
    "抽取指令：",
    instruction,
    "",
    "内容：",
    truncate(content, MARKDOWN_LIMIT),
    "",
    "只输出 JSON 数组。",
  ].join("\n");

  const stream = models.streamSimple(
    model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
    },
    { sessionId: `extract-${Date.now().toString(36)}` }
  );

  let text = "";
  for await (const ev of stream) {
    if (ev.type === "text_delta") {
      text += ev.delta;
    } else if (ev.type === "error") {
      throw new ModelError(`llmExtract: 模型流错误 — ${ev.error.errorMessage ?? "unknown"}`);
    }
  }

  return parseJsonArray(text);
}
