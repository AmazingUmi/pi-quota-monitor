# Pi Quota Monitor

显示 OpenAI Codex、Antigravity 的剩余额度与本地 Token 用量的 [Pi package](https://pi.dev/packages)。支持 Pi TUI / pi-web 状态栏、`/quota` 命令和本机 Web 控制台。

## 安装

需要 Node.js 22+ 和使用 `@earendil-works/pi-coding-agent` API 的 Pi。额度查询依赖已登录的 `openai-codex` / `antigravity` Provider；本扩展不会代替 Provider 登录。

```bash
pi install npm:pi-quota-monitor
```

安装后启动新 Pi 会话；pi-web 中可在「设置 → 插件」重新加载会话。`pi --extension ./src/index.ts` 仅供仓库内临时调试，不会安装到 pi-web。源码安装使用 `pi install .`。

Antigravity 需另外安装并登录相应 Provider。本机 `agy://local-stream-json` 模式需要可执行的 `agy` 及其登录会话；旧版 OAuth Provider 则通过 Cloud Code Assist API 查询。未登录或网络不可用时，额度显示为 `?`。

## 命令

| 命令 | 功能 |
| --- | --- |
| `/quota` | 查看额度、重置时间、当前会话与当日 Token 用量 |
| `/quota-refresh` | 立即刷新两个 Provider |
| `/quota-interval 180` | 设置后台刷新间隔（60–3600 秒） |
| `/quota-console` | 打开本机 Web 控制台 |

状态栏示例：`OAI 73%/61% ↻1h20m | AGY 95%/83% ↻2h17m | ↑284k ↓37k`。比例分别表示 **5 小时 / 每周**的剩余百分比；AGY 状态栏只显示 Gemini，其他额度可在 `/quota` 或控制台查看。`?` 表示对应窗口不可识别或尚无数据，不表示 0%。查询失败时，本会话仍显示最后一次成功结果。

控制台展示额度、按 Provider/模型汇总的账本用量、24 小时/30 天趋势、当前上下文占用及费用估算。地址只监听 Pi 所在机器的 `127.0.0.1`，会话结束后关闭；远程 pi-web 用户需要自行使用 SSH 端口转发，**不要将端口公开到局域网**。控制台每 5 秒读取本机缓存与账本，不会因此反复调用额度 API。

## 数据与配置

配置文件位于 `~/.pi/agent/pi-quota-monitor/config.json`（支持 `PI_CODING_AGENT_DIR`）。默认值：

```json
{
  "refreshIntervalSeconds": 180,
  "staleAfterSeconds": 60,
  "requestTimeoutSeconds": 10,
  "showReset": true,
  "showOaiInStatusbar": true,
  "showAgyInStatusbar": true
}
```

两个状态栏开关仅控制 pi-web 的 OAI/AGY 片段，不停止查询或隐藏控制台数据。Token 账本是同目录下按本地日期存放的 `usage-YYYY-MM-DD.jsonl`，只记录时间戳、Provider、模型和 Token 计数；不记录提示词或凭据。用量总计仅涵盖**安装本插件后记录的消息**，不回填 Pi 历史。Reasoning 已包含在 Output 中，不重复计入总量。

费用按 `src/tokens/pricing.ts` 中的公开 API 标价估算（价格核对日期：2026-09-23），**不是订阅实付、余额或预算上限**。未知模型或缺少价格分量的记录标为未计价；缓存时长、非文本、折扣及历史价格变化可能造成偏差。额度窗口的金额是根据本插件已记录的可计价用量和 Provider 返回的使用百分比外推，数据不完整时尤其不可靠。

Codex 凭据仅用于 `https://chatgpt.com/backend-api/wham/usage`；旧版 OAuth Antigravity 凭据仅发送至代码中固定的 Cloud Code Assist 域名，HTTP 跳转被禁用。本机 agy 模式调用其自身登录会话，不读取 OAuth 凭据。

## 开发

```bash
npm ci
npm run check
npm pack --dry-run
```

Pi 根据 `package.json` 的 `pi.extensions` 直接加载 TypeScript，无需编译。发布包包含 `src/`、README 和 LICENSE。
