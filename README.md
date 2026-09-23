# Pi Quota Monitor

Pi 扩展：在 Pi TUI 底部状态栏和 **pi-web** 聊天窗口的扩展状态栏中持续显示 Codex / Antigravity 剩余额度，另统计本地 Token 用量。

## 使用

需要 Node.js 22+、Pi（使用 `@earendil-works/pi-coding-agent` API）和已经登录的 `openai-codex` / `antigravity` Provider。Antigravity 需要另外安装并登录 [pi-antigravity](https://github.com/Rahularya01/pi-antigravity)。不代替这两个 Provider 的登录流程。

```bash
npm install
pi -e ./src/index.ts
```

或将此包的**绝对路径**加入 Pi 的 `settings.json` 中 `packages` 数组，再执行 `/reload`。pi-web 的 Pi 会话也必须加载同一个扩展：它通过 Pi RPC `setStatus` 自动将内容显示在聊天窗口下方，无需另建 Web Dashboard。开发模式下可运行 `npm run check`。

状态示例：`OAI 73%/61% ↻1h20m | AGY G84% C67% | ↑284k ↓37k`。`?` 表示未取得有效额度，而非 0%。Antigravity 汇总额度不可用（如免费账户的 `SUBSCRIPTION_REQUIRED`）时回退至各模型 `remainingFraction`；同一组多个额度窗口取最低剩余值，不误称为专属模型额度。失败时保留**本会话**最后一次成功查询的额度；切换会话则重新查询。

## 命令与配置

- `/quota`：完整额度、重置时间、当前会话及当日 Token 统计。
- `/quota refresh`：强制刷新两个 Provider。
- `/quota interval 180`：设置兜底刷新间隔（60–3600 秒），立即生效并保存。

配置在 `~/.pi/agent/pi-quota-monitor/config.json`（尊重 `PI_CODING_AGENT_DIR`）：

```json
{
  "refreshIntervalSeconds": 180,
  "staleAfterSeconds": 60,
  "requestTimeoutSeconds": 10,
  "showReset": true
}
```

间隔为后台兜底查询频率；启动自动查询，切换到目标 Provider 时更新，相关 Provider 的回复之后仅在缓存超过 `staleAfterSeconds` 时更新，429 / quota error 则立即尝试。多个同时触发的查询会合并。不会高频轮询；每次状态重绘更新 reset 倒计时。

每日 ledger 文件为 `usage-YYYY-MM-DD.jsonl`（本地日期），仅存时间戳、Provider、模型和 Token 计数；不会在本扩展的文件中写入 access token、refresh token 或 API key。`reasoning` 是 `output` 的子集，不能重复加入 `totalTokens`。Codex 凭据只发送至 `https://chatgpt.com/backend-api/wham/usage`，Antigravity 凭据只发送至硬编码的官方 Cloud Code Assist 域名；响应禁用 HTTP 跳转。没有账户或网络不可用时显示 `?`，不会弹出登录框。

## 参考

- [Pi 扩展与 RPC 状态栏 API](https://github.com/earendil-works/pi)
- [pi-web provider-usage](https://github.com/agegr/pi-web/blob/main/lib/provider-usage.ts)
- [pi-usage](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-usage)
- [pi-antigravity](https://github.com/Rahularya01/pi-antigravity)

本项目不依赖这些扩展的私有代码或运行时状态，也不调用另一个扩展的命令。
