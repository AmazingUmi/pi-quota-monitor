# Pi Quota Monitor

Pi 扩展：显示 Codex / Antigravity 剩余额度和本地 Token 用量。除 Pi TUI / pi-web 状态栏外，也提供独立的本机 Web 控制台（应用户新增需求，超出原 v0.1 任务书范围）。

## 使用

需要 Node.js 22+、Pi（使用 `@earendil-works/pi-coding-agent` API）和已经登录的 `openai-codex` / `antigravity` Provider。Antigravity 需要另外安装并登录相应的 pi-antigravity Provider。对于使用本机 `agy://local-stream-json` 的版本（如 `@tian.zuo/pi-antigravity`），本扩展调用同一原生 `agy --print /usage --output-format json` 查询，无需把 Provider 的 `agy-local-session` 占位符误当作 OAuth token；旧版 OAuth Provider 则继续使用 Cloud Code Assist API。不代替这两个 Provider 的登录流程。

在仓库目录安装为 Pi 包（供普通 Pi CLI 和 pi-web 会话自动加载）：

```bash
npm install
pi install /Volumes/exDateDisk/projects/pi-usage_rt
pi list
```

上述绝对路径是本机示例；其他机器请换成仓库的绝对路径。**`pi -e ./src/index.ts` 只对这一次 Pi CLI 进程生效，并不会给 pi-web 安装扩展。** 安装后在 pi-web 的「设置 → 插件」里选择「重新加载会话」，或打开新会话；仅刷新浏览器页面不保证现有 Pi 会话重新加载扩展。pi-web 通过 Pi RPC `setStatus` 在**聊天输入框下方的扩展状态栏**显示内容；它不是「工具」按钮。若需更清晰的独立视图，可用 `/quota console`。开发模式下可运行 `npm run check`。

状态示例：`OAI 73%/61% ↻1h20m | AGY 95%/83% ↻2h17m | ↑284k ↓37k`。两组比例均依次为 **5 小时 / 每周**，AGY 状态栏默认只显示 Gemini，倒计时取 Gemini 的 5 小时窗口；Claude/GPT 仍可在 `/quota` 或控制台查看。`?` 表示没有对应窗口数据，而非 0%。旧版 OAuth Antigravity 汇总额度不可用（如免费账户的 `SUBSCRIPTION_REQUIRED`）时回退至各模型 `remainingFraction`，但无法识别其 5 小时/每周窗口时状态栏显示 `?/?`，不会误标窗口；本机 agy 使用 `/usage` 返回的 quota groups。同一窗口有多个额度时取最低剩余值。失败时保留**本会话**最后一次成功查询的额度；切换会话则重新查询。

## 命令与配置

- `/quota`：完整额度、重置时间、当前会话及当日 Token 统计。
- `/quota console`：启动本地控制台，返回 `http://127.0.0.1:<随机端口>`；复制链接到浏览器打开。在 pi-web 中运行此命令会隐藏**本扩展**的下栏状态，其他扩展状态不受影响。控制台展示本插件账本中所有已记录日期的全模型总计及按 `(provider, model)` 分组的明细；趋势图可切换最近 24 小时（按小时）/最近 30 天（按日），选择全部模型或指定 Provider + 模型。总计不覆盖插件启用前历史，也不显示当前会话/今日 Token 面板。顶部另显示当前 Pi 会话的估算费用与当前模型上下文窗口占用（与全账本 Tokens 口径不同）；这不是账户预算上限。
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

间隔为后台兜底查询频率；启动自动查询，切换到目标 Provider 时更新，相关 Provider 的回复之后仅在缓存超过 `staleAfterSeconds` 时更新，429 / quota error 则立即尝试。多个同时触发的查询会合并。不会高频轮询；每次状态重绘更新 reset 倒计时。控制台每 5 秒读取一次**本机缓存**，不会因此调用额度 API；Token 账本也每 5 秒增量扫描新增内容（首次流式读取），包含其他进程追加的数据。损坏记录跳过并提示，聚合失败时保留上次结果并标示过期。可在页面上手动刷新额度或修改间隔。控制台绑定 **Pi 运行机器**的 `127.0.0.1`、不暴露访问凭据、会话切换/退出时关闭，旧链接届时失效。若 pi-web 运行在远程主机，浏览器无法直接访问远程机器的 localhost；需自行建立 SSH 端口转发，勿将控制台端口公开到局域网。

每日 ledger 文件为 `usage-YYYY-MM-DD.jsonl`（本地日期），仅存时间戳、Provider、模型和 Token 计数；不会在本扩展的文件中写入 access token、refresh token 或 API key。`reasoning` 是 `output` 的子集，不能重复加入 `totalTokens`。Codex 凭据只发送至 `https://chatgpt.com/backend-api/wham/usage`，旧版 OAuth Antigravity 凭据只发送至硬编码的官方 Cloud Code Assist 域名；响应禁用 HTTP 跳转。本机 agy 模式不读取 OAuth 凭据，调用 agy 自己的登录会话；由于每次 `/usage` 会启动新的 agy 后端并刷新额度，本机模式至少等待 120 秒（不受较短的 HTTP `requestTimeoutSeconds` 限制）。如遇 `agy native query timed out`，可直接运行 `/agy-usage` 检查原生查询或检查 agy 登录状态。没有账户或网络不可用时显示 `?`，不会弹出登录框。

## 参考

- [Pi 扩展与 RPC 状态栏 API](https://github.com/earendil-works/pi)
- [pi-web provider-usage](https://github.com/agegr/pi-web/blob/main/lib/provider-usage.ts)
- [pi-usage](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-usage)
- [pi-antigravity](https://github.com/Rahularya01/pi-antigravity)

本项目不依赖这些扩展的私有代码或运行时状态，也不调用另一个扩展的命令。
