# Hypothesis - 680e823a

## Hypothesis Statement
把 request_human 的完成确认从"等回车"改为"轮询客观状态"（周期性检测页面 URL 是否离开登录页 / 登录元素是否消失 / 是否出现登录后标记），agent 就能在人完成交互后自动继续，无需任何手动信号，从而在后台/无 TTY 场景下也不会死锁。

## Falsifiable Prediction
若实现"每 ~2s 检测一次 page.url 或指定元素"的轮询，则当页面状态改变（模拟人完成→URL 跳转）时，轮询会在一个检测周期内（≤2×间隔）返回 done=true，全程无回车。若该预测不成立（轮询检测不到 URL 变化），则假设被证伪。

## Minimal Test (ONE variable)
真实 Playwright browser（非 mock）：
- 起 headless page 停在 about:blank（视为"登录页"）。
- isDone = page.url() 不含 "blank"（即离开登录页）。
- 1.5s 后 page.goto 跳转到新 URL（模拟人完成登录→跳首页），这是唯一变量。
- 用 pollUntilDone(page, isDone, timeout=10s, interval=500ms) 轮询。
探针脚本（一次性，已运行后删除）：probe-poll.mts。

## Test Execution (Setup, Result, Verdict)
- Setup：headless chromium，about:blank 起始，1.5s 后 goto "data:text/html,...loggedin"。
- Result（原始输出）：
  POLL_RESULT={"done":true,"elapsed":2002}
  FINAL_URL=data:text/html,<title>home</title>loggedin
  VERDICT=轮询成功检测到完成(无需回车)
- Verdict：**Confirmed（确认）**。轮询在 2s（首个周期）检测到 URL 跳转，done=true，无需回车。

## Conclusion
假设成立。轮询客观状态（URL 变化）能可靠检测"人已完成"，替代回车，可解后台死锁。修复方向：request_human 改为轮询 page 状态（URL/元素），保留回车作 fallback，加超时与 abort。

## Artifacts
- 探针：probe-poll.mts（已运行验证后删除，一次性）
- 输出：POLL_RESULT done:true / elapsed 2002ms
