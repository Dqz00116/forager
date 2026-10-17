# Root Cause Investigation - 680e823a

## Bug Summary
request_human 工具用"等回车"作为人工完成信号，但该信号依赖前台终端 stdin；后台/无终端运行时回车无法送达，agent 在用户已完成交互后仍永久阻塞（死锁）。

## Error Information, Affected files
- 缺陷位置：src/human.ts waitForEnter() —— 用 readline question() 等"回车"这个特定动作。
- 调用方：src/tools.ts request_human execute —— await waitForEnter() 无限期阻塞。
- 触发条件：crawl 在后台运行（无 TTY stdin），或任何"人已完成但没按回车"的情况。
- 实证：2026-10-16 知乎实战，用户已登录成功，agent 日志停在"完成后请按回车继续"不再前进。

## Reproduction (Steps, Frequency, Environment)
- 步骤：npm run crawl（放后台或任何无 TTY stdin 环境）→ agent 调 request_human → 用户在弹窗完成登录 → agent 等回车 → 后台进程收不到回车 → 永久阻塞。
- 频率：100%（凡后台运行 request_human 必现）。
- 环境：Node v22.23.1 / win32 / 后台 shell 无 TTY。

## Root Cause, Evidence, Alternatives Ruled Out
- Root Cause：把"人已完成"这个事实，错误地等同于"回车"这个特定主观动作。正确抽象是：人完成是可观测的客观状态变化（登录后 URL 跳转、登录元素消失、出现用户标识），agent 应主动轮询检测，而非被动等一个可能无法送达的信号。
- Evidence：request_human 的死等 readline；用户反馈"我已经登录了，似乎阻塞了"。
- Alternatives Ruled Out：
  - "改前台运行就能解决" → 排除：前台依赖人记得按回车，且仍不支持后台/自动化场景，治标。
  - "用文件信号/点按钮替代回车" → 排除：仍是要求人做额外动作，不如直接观测完成证据（URL/元素变化）本质。
  - "agent 决策错了" → 排除：日志证明 agent 正确识别登录墙并正确求助，问题纯在确认机制。

## Data Flow Trace
agent 遇登录墙 → request_human → launchHumanBrowser + page.goto(signin) → 打印"请按回车" → await waitForEnter() [readline 等 stdin 回车] ←—— 死锁点：后台无 stdin，信号永不到达 → （用户已登录）但 agent 永远停在这里，不继续 render 抓热榜。
