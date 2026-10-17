# Pattern Analysis - 680e823a

## Comparison Dimensions
对比"前台测试（能工作）"与"后台实战（死锁）"：P3 集成测试里 waitForEnter 用注入 input stream 模拟回车能 resolve（工作）；知乎实战后台运行无 TTY stdin，回车无法送达（死锁）。差异在"回车信号的可达性"。

## Working vs Broken
（表格 Aspect | Working | Broken | Assessment）
- 回车信号可达性 | 前台/注入input 可达 | 后台无TTY 不可达 | 信号机制脆弱
- 完成判定方式 | 主观动作(回车) | 同左 | 应改为客观状态
- 人已完成但信号未到 | 测试不存在此情况 | 实战用户已登录却死锁 | 信号≠事实

## Dependency Changes
无依赖版本变化。缺陷由"确认机制"的抽象错误导致，与第三方库无关。Playwright/readline 行为正常。

## Historical Context
P3 设计时选"回车"是因实现最简单（readline question），测试用注入 input 容易模拟。当时未考虑后台/无 TTY 场景。知乎实战首次在真实后台场景暴露——这是 MVP 快速验证时欠下的设计债，属 deferred 考量，非回归。

## Identified Pattern
**"把客观事实错误绑定到主观信号"**：系统要确认的是"人已完成交互"这个事实，但实现绑死在"回车"这个特定主观动作上。一旦信号通道失效（后台无 TTY）或人忘记动作，系统就无法感知已完成的事实。正确模式是**轮询客观状态**：人完成交互必然留下可观测痕迹（登录后 URL 跳转、登录表单消失、出现用户头像/Logout、目标内容可加载），agent 周期性检测这些客观信号，发现即继续——人不需任何额外动作。

## Implications for Fix
- request_human 增加轮询模式：周期性（如每 2s）检查当前 human page 的状态——URL 是否离开登录页、登录元素是否消失、是否出现登录后标记。
- 提供"完成条件"参数：让 agent 求助时给出"如何判断人已完成"（如 success_url_pattern / success_selector / gone_selector），agent 轮询这些客观信号。
- 保留回车作为 fallback（前台有人时仍可按回车），但主路径改为轮询。
- 加超时与 abort：轮询带合理超时（如 5 分钟）和 signal abort，避免新的死锁。
- 测试：模拟页面状态变化（真实 browser page.goto 跳转）验证轮询检测到完成。
