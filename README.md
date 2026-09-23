# Pi Quota Monitor

Pi 扩展：显示 Codex / Antigravity 剩余额度和本地 Token 用量。除 Pi TUI / pi-web 状态栏外，也提供独立的本机 Web 控制台（应用户新增需求，超出原 v0.1 任务书范围）。

## 使用

需要 Node.js 22+、Pi（使用 `@earendil-works/pi-coding-agent` API）和已经登录的 `openai-codex` / `antigravity` Provider。Antigravity 需要另外安装并登录 [pi-antigravity](https://github.com/Rahularya01/pi-antigravity)。不代替这两个 Provider 的登录流程。

在仓库目录安装为 Pi 包（供普通 Pi CLI 和 pi-web 会话自动加载）：

```bash
npm install
pi install /Volumes/exDateDisk/projects/pi-usage_rt
pi list
```

上述绝对路径是本机示例；其他机器请换成仓库的绝对路径。**`pi -e ./src/index.ts` 只对这一次 Pi CLI 进程生效，并不会给 pi-web 安装扩展。** 安装后在 pi-web 的「设置 → 插件」里选择「重新加载会话」，或打开新会话；仅刷新浏览器页面不保证现有 Pi 会话重新加载扩展。pi-web 通过 Pi RPC `setStatus` 在**聊天输入框下方的扩展状态栏**显示内容；它不是「工具」按钮。若需更清晰的独立视图，可用 `/quota console`。开发模式下可运行 `npm run check`。

状态示例：`OAI 73%/61% ↻1h20m | AGY G84% C67% | ↑284k ↓37k`。`?` 表示未取得有效额度，而非 0%。Antigravity 汇总额度不可用（如免费账户的 `SUBSCRIPTION_REQUIRED`）时回退至各模型 `remainingFraction`；同一组多个额度窗口取最低剩余值，不误称为专属模型额度。失败时保留**本会话**最后一次成功查询的额度；切换会话则重新查询。

## 命令与配置

- `/quota`：完整额度、重置时间、当前会话及当日 Token 统计。
- `/quota console`：启动本地控制台，返回 `http://127.0.0.1:<随机端口>`；复制链接到浏览器打开。在 pi-web 中运行此命令会隐藏**本扩展**的下栏状态，其他扩展状态不受影响。
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

间隔为后台兜底查询频率；启动自动查询，切换到目标 Provider 时更新，相关 Provider 的回复之后仅在缓存超过 `staleAfterSeconds` 时更新，429 / quota error 则立即尝试。多个同时触发的查询会合并。不会高频轮询；每次状态重绘更新 reset 倒计时。控制台每 5 秒读取一次**本机缓存**，不会因此调用额度 API；可在页面上手动刷新或修改间隔。控制台绑定 **Pi 运行机器**的 `127.0.0.1`、不暴露访问凭据、会话切换/退出时关闭，旧链接届时失效。若 pi-web 运行在远程主机，浏览器无法直接访问远程机器的 localhost；需自行建立 SSH 端口转发，勿将控制台端口公开到局域网。

每日 ledger 文件为 `usage-YYYY-MM-DD.jsonl`（本地日期），仅存时间戳、Provider、模型和 Token 计数；不会在本扩展的文件中写入 access token、refresh token 或 API key。`reasoning` 是 `output` 的子集，不能重复加入 `totalTokens`。Codex 凭据只发送至 `https://chatgpt.com/backend-api/wham/usage`，Antigravity 凭据只发送至硬编码的官方 Cloud Code Assist 域名；响应禁用 HTTP 跳转。没有账户或网络不可用时显示 `?`，不会弹出登录框。

## 参考

- [Pi 扩展与 RPC 状态栏 API](https://github.com/earendil-works/pi)
- [pi-web provider-usage](https://github.com/agegr/pi-web/blob/main/lib/provider-usage.ts)
- [pi-usage](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-usage)
- [pi-antigravity](https://github.com/Rahularya01/pi-antigravity)

本项目不依赖这些扩展的私有代码或运行时状态，也不调用另一个扩展的命令。
