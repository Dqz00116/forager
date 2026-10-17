# Verification - 680e823a

## Fix Summary
request_human 增加轮询模式（wait_mode='poll'）：waitForDone 周期性检测页面客观状态（URL 离开登录页 gone_url_pattern / 达到 success_url_pattern / success_selector 出现 / gone_selector 消失），人完成交互后 agent 自动继续，无需回车。保留 enter 回车模式作 fallback。超时返回 timed_out 标记，signal 可 abort。

## Root Cause Recap
原实现把"人已完成"绑定到"回车"这个依赖前台 TTY stdin 的主观信号；后台/无 TTY 时信号无法送达，agent 在人已完成交互后仍死锁。

## Verification Evidence

### 单元测试（真实 headless browser，禁 mock）
- gone_url_pattern 检测 URL 变化 → resolve 1673ms
- success_selector 检测元素出现 → resolve 1344ms
- 超时返回 timed_out 标记 → 1600ms

### 集成测试（后台无 TTY 场景，复现死锁的修复）
- wait_mode=poll：不注入任何 stdin（模拟后台），测试程序在 human page 上 page.goto 模拟人完成，agent 靠 URL 变化自动判定，resolve resumed=true，elapsed>0，全程无回车。
- 日志提示语已变为"agent 将自动检测人完成并继续，无需回车"。

### 全量回归
- npm test → 31/31 通过（471s），含原 16 units + 11 integration + 3 轮询 units + 1 轮询 integration，无回归。

### 真实实战验证（知乎热榜）
- 用轮询模式抓知乎热榜：agent 弹知乎登录窗口，用户登录后 agent 轮询 gone_url_pattern='signin' 检测到离开登录页，自动继续抓热榜，无需回车。（结果见 output/records.jsonl 与 output/trace.db 的对应 run）

## Test Command
npm test（完整，真实 LLM/浏览器）；npm run test:gate（units 冒烟）

## Verdict
修复有效：轮询客观状态替代回车，后台/无 TTY 死锁消除；前台回车仍兼容。通过全部测试与真实知乎实战验证。
