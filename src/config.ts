import "dotenv/config";
import { ConfigError } from "./errors.js";

function requireApiKey(): string {
  const key = process.env.OPENCODE_API_KEY?.trim();
  if (!key) {
    throw new ConfigError(
      "缺少 OPENCODE_API_KEY：请在项目根目录的 .env 中填写（OPENCODE_API_KEY=你的 OpenCode Go 密钥）后重试。"
    );
  }
  return key;
}

export const apiKey = requireApiKey();
export const modelId = process.env.CRAWLER_MODEL?.trim() || "muse-spark-1.3-contributor";
