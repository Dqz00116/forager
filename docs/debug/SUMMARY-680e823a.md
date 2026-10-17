# Debug Summary - 680e823a

## 问题
request_human 用"等回车"作人工完成信号，依赖前台 TTY stdin；后台/无 TTY 运行时回车无法送达，agent 在用户已完成交互（知乎登录）后仍永久阻塞（死锁）。

## 根因
把"人已完成"这个客观事实，错误绑定到"回车"这个特定主观动作上。信号通道（TTY stdin）失效时，系统无法感知已完成的事实。

## 修复
request_human 增加轮询模式（wait_mode='poll'）：waitForDone 周期性检测页面客观状态——URL 离开登录页（gone_url_pattern）、达到目标页（success_url_pattern）、登录后元素出现（success_selector）、登录元素消失（gone_selector）。人完成后 agent 自动继续，无需任何手动信号。回车模式保留为 fallback。超时返回 timed_out，signal 可 abort。
涉及文件：src/human.ts（waitForDone）、src/tools.ts（request_human 轮询分支）、src/agent.ts（systemPrompt 引导优先 poll）。

## 验证
- units 19/19（3 个轮询用例：URL 变化/元素出现/超时）
- integration 轮询端到端：后台无 TTY 场景，靠 URL 变化自动判定完成，全程无回车
- 全量 npm test 31/31 无回归
- 真实知乎实战：轮询检测登录成功自动继续（无需回车）

## 经验教训（Pattern）
**"把客观事实绑定到主观信号"是反模式。** 系统要确认的是"人已完成"这个事实，应轮询其可观测痕迹（URL/元素/内容变化），而非依赖人再做一个主观动作（回车）。这条原则同样适用于：任何"等待外部完成"的场景——检测完成证据，而非等待完成信号。这也再次印证第一性原理：回到"我们到底要确认什么"的本质，而非"最容易实现的形式"。

## 后续
无遗留代码债。轮询的超时/间隔已可配。未来可加更多完成检测器（Cookie 出现、网络请求成功等）作为轮询条件。
