---
id: EVIDENCE-680e823a
debug_ref: SUMMARY-680e823a
date: 2026-10-16
status: passed
---

# EVIDENCE-680e823a：request_human 轮询模式修复

## Evidence Summary

request_human 轮询模式修复完成（debug-fix）。

- `npm test` 31/31 通过，无回归。
- `tsc --noEmit` 退出码 exit 0。
- 知乎实战轮询验证通过：后台无 TTY 场景下靠页面 URL 变化自动检测登录完成并继续，无需回车。

## Fix Verification

### units 19/19

含轮询 3 用例：

- `gone_url_pattern`：URL 变化检测成功，1673ms。
- `success_selector`：元素出现检测成功，1344ms。
- 超时：`timed_out`，1600ms。

### integration 轮询端到端

`wait_mode=poll` 后台无 TTY 场景，靠页面 URL 变化判定完成，resolve `resumed=true`，`elapsed>0`，全程无回车（2614ms / 2224ms）。

### 全量 npm test 31/31

无回归（471s）。

## Raw Test Output

```
> vitest run
 ✓ test/units.test.ts (19 tests) — 含 轮询完成检测 (3)
 ✓ test/integration.test.ts (12 tests)
   ✓ ... 人机协作端到端 (request_human 真实登录 AC4/AC8/AC9)
   ✓ request_human 轮询模式（后台无 TTY）
     ✓ wait_mode=poll：靠页面 URL 变化判定完成，resolve resumed=true 且全程无回车 2224ms
 Test Files  2 passed (2)
      Tests  31 passed (31)
   Duration  471.17s
```

## Raw Typecheck Output

```
> tsc --noEmit
```
（exit 0）

## 知乎实战验证

用轮询模式抓知乎热榜：agent 弹出知乎登录窗，用户登录后 agent 轮询 `gone_url_pattern='signin'` 检测离开登录页，自动继续抓取热榜，无需回车（对比修复前后台死锁问题）。结果见 `output/records.jsonl` 与 `output/trace.db`。

## Environment

- Node v22.23.1
- win32
- muse-spark-1.3-contributor
- Playwright 1.64.1
- node:sqlite
- 真实 API，禁 mock
