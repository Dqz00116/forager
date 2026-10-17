# pi-crawler

pi-agent 作为大脑全程驱动的探索式网页爬虫：LLM agent 自主决定抓哪个页面、是否动态渲染、抽取什么数据，并通过工具保存记录。

## 设计哲学

- **不求全面，但求精细**：不堆砌功能与工具数量，而是把每个动作做扎实，让 agent 用最少的原语完成最多的任务。
- **第一性原理**：回归"抓取"这件事的本质——无论站点如何千变万化，爬虫的原子动作只有三个：取（Fetch）、懂（Extract）、存（Save）。一切工具切分都回归这三个动作，拒绝按技术实现冗余拆分。
- **三本质动作**：策略差异（静态 vs 渲染、确定性 vs 语义抽取）内化为工具参数，而非并列成多个工具。agent 根据具体任务自主组合取/懂/存，即可完成任意抓取任务。

## 使用

1. 填写 `.env`：

   ```
   OPENCODE_API_KEY=你的 OpenCode Go 密钥
   CRAWLER_MODEL=muse-spark-1.3
   ```

2. 安装依赖并下载 chromium：

   ```bash
   npm install
   npx playwright install chromium
   ```

3. 运行爬虫任务：

   ```bash
   npm run crawl -- <入口URL> "<任务描述>"
   ```

   例如：

   ```bash
   npm run crawl -- https://example.com/news "抓取前 3 页新闻列表，进入每条详情页保存标题、日期和摘要"
   ```

抓取到的结构化记录逐行追加在 `output/records.jsonl`（JSON Lines 格式）。

## 可观测性 / Trace

每次 `npm run crawl` 都会自动把本次运行的全量 trace 记录到 `output/trace.db`（`node:sqlite`，零新增依赖）。CLI 结束时打印本次 `run_id` 与查询提示。

trace 内容：

- run 元信息：入口 url / task / 状态 / 耗时 / 落盘数（`records_saved`）
- 每次 LLM 交互的完整 prompt 与 response（全量，不截断决策依据）
- 每次工具调用：args / 结果 / 耗时 / 是否落盘（`saved`），以及是否报错

查询命令：

```bash
# 列出所有运行（按时间）
npm run trace
npm run trace -- runs

# 回放某次运行的完整事件流
npm run trace -- run <run_id>

# 查「extract 有产出但没 save」的运行
npm run trace -- --pattern extract-no-save

# 指定其他 trace 库
npm run trace -- --db <path>
```

trace 是排查"agent 为什么没存数据 / 行为异常"的入口：行为可观测，根因可证。

## 本质工具

爬虫内核固化为三个本质工具，策略差异内化为参数：

**取 fetch(url, render?)**
- 输入 URL，返回页面内容与其中链接；`links` 可用于识别"下一页"等分页并再次调用 `fetch` 翻页（分页内化于取，非独立工具）。
- 默认静态抓取；失败或返回内容明显不足时，改传 `render=true` 走无头浏览器渲染重取。

**懂 extract(content, instruction, selector?)**
- 输入页面内容与抽取意图。给了 `selector`（CSS 选择器，支持 `::attr(x)` 后缀）走 cheerio 确定性提取，快速、零模型成本；不给 `selector` 则按 `instruction` 走 LLM 语义抽取。

**存 save(data, schema?, dedup_key?, source_url?)**
- 数据契约：缺字段拒绝（`schema_missing`）、同 `dedup_key` 跳过（`duplicate`）、内容全空过滤（`all_empty`）。
- `source_url` 用于溯源，并作为默认去重键（`dedup_key` 缺省时等价于 `'url'`）。

辅助工具：`list_saved`（查看已存记录数与路径）、`finish`（宣告任务完成）。

## 人机协作 / Human-in-the-Loop

- **设计哲学**：承认 agent 的能力边界，把人当作系统的一个组件——agent 做擅长的探索、抽取、导航，人做擅长的登录、验证码、复杂交互与判断。不追求虚假的全自动，关键是 agent 知道"何时该求助、如何让人接手"。
- **第 4 本质工具 request_human**：与取/懂/存并列。agent 遇到登录墙、验证码、权限墙、拖拽等需要人操作的场景时，主动发起求助并说明需要人做什么，而非卡死或盲目重试。
- **交互流程**：agent 求助 → 弹出有头浏览器窗口显示目标页 → 你在窗口里完成操作（登录/验证码/拖拽）→ 回 CLI 按回车 → agent 在同一会话中继续抓取（同一浏览器上下文，登录态/Cookie 自然保留）。
- **按需有头**：不需要人介入的任务，agent 仍以无头模式高效运行；有头窗口仅在求助时出现。
- **全程可观测**：求助与接管都记入 trace，`npm run trace` 可查，人操作耗时以 `duration_ms` 记录。

## 说明

- 默认静态抓取；失败或内容为空时自动改用 playwright 无头浏览器渲染。
- agent 可用工具：`fetch` / `extract` / `save` / `list_saved` / `finish`。
- 模型经 OpenCode Go provider 调用，模型 ID 由 `.env` 的 `CRAWLER_MODEL` 配置。
