# Pi Quota Monitor

显示 OpenAI Codex、Antigravity 的剩余额度与本地 Token 用量的 [Pi package](https://pi.dev/packages)。支持 Pi TUI / pi-web 状态栏、`/quota` 命令和本机 Web 控制台。

## 安装

需要 Node.js 22+ 和使用 `@earendil-works/pi-coding-agent` API 的 Pi。额度查询依赖已登录的 `openai-codex` / `antigravity` Provider；本扩展不会代替 Provider 登录。

```bash
pi install npm:pi-quota-monitor
```

安装后启动新 Pi 会话；pi-web 中可在「设置 → 插件」重新加载会话。`pi --extension ./src/index.ts` 仅供仓库内临时调试，不会安装到 pi-web。源码安装使用 `pi install .`。

Antigravity 需另外安装并登录相应 Provider。本机 `agy://local-stream-json` 模式需要可执行的 `agy` 及其登录会话；旧版 OAuth Provider 则通过 Cloud Code Assist API 查询。未登录或网络不可用时，未知额度显示为 `-`。

## 命令

| 命令 | 功能 |
| --- | --- |
| `/quota` | 查看额度、重置时间、当前会话与当日 Token 用量 |
| `/quota-refresh` | 立即刷新两个 Provider |
| `/quota-interval 180` | 设置后台刷新间隔（60–3600 秒） |
| `/quota-console` | 打开本机 Web 控制台 |
| `/quota-account-list` | 列出已保存的 Codex 账号 |
| `/quota-account-use pro` | 切换账号并开启新 Pi 会话（其余命令见下） |

状态栏示例：`OAI 73%/61% ↻1h20m | AGY 95%/83% ↻2h17m | ↑284k ↓37k`。比例分别表示 **5 小时 / 每周**的剩余百分比；AGY 状态栏只显示 Gemini，其他额度可在 `/quota` 或控制台查看。OAI 和 AGY 的未知窗口都用 `-` 代替 `?`，已有的百分比保持不变，例如 `OAI ?/11%` 显示为 `OAI -/11%`、`AGY ?/11%` 显示为 `AGY -/11%`；都未知时为 `-/-`。Pro 未提供 5 小时窗口时显示 `-/周额度`（如 `OAI -/13%`）。若 Pro 仅返回一个未标明时长的窗口，按周额度显示；其他套餐不猜测。查询失败时，本会话仍显示最后一次成功结果。

控制台展示额度、按 Provider/模型汇总的账本用量、24 小时/30 天趋势、当前上下文占用及费用估算。地址只监听 Pi 所在机器的 `127.0.0.1`，会话结束后关闭；远程 pi-web 用户需要自行使用 SSH 端口转发，**不要将端口公开到局域网**。控制台每 5 秒读取本机缓存与账本，不会因此反复调用额度 API。

## Codex 多账号

先用 Pi 原生 `/login` 登录账号，再用 `/quota-account-save pro` 保存当前 OAuth；登录另一个账号后用 `/quota-account-save plus`。也可用 `/quota-account-import <名称> <本地JSON路径>` 导入现有 `pi-auth` 的单个 OAuth profile（不依赖该脚本）。`/quota-account-use pro` 会等待回复和账本写入、备份、同步当前凭据、切换并开启新会话。请勿在其他 Pi 进程正在请求时切换：`auth.json` 对同一数据目录全局生效。控制台的“账号管理与历史备份”也提供这些操作；切换和删除须在 Pi 窗口确认。

- `/quota-account-list` / `/quota-account-current`：查看账号；数据以 OAuth `accountId` 隔离。
- `/quota-account-backup` / `/quota-account-backups`：备份用量和 OAuth profiles、列出备份。
- `/quota-account-restore <备份路径>`：合并历史；重复导入不重复计数，同名不同账号拒绝导入。
- `/quota-account-delete <名称>`：备份后删除非当前账号的保存凭据，不删除历史用量或撤销 OAuth。
- `/quota-account-reset-cache`：重新查询当前 Codex 额度。
- `/quota-account-reset-usage <名称>`：备份后清除该账号的本地用量；**不会重置 OpenAI 额度或登录**。当前会话计数保留至新会话。

保存、导入、切换、恢复及用量重置前会自动备份。备份和 profiles 存放于插件私有目录（文件权限 `0600`），**其中包含 OAuth token**，不会自动删除；不要分享或提交，注意磁盘占用。控制台可切换查看各账号的历史账本；仅查询当前账号的实时额度。升级前未记录账号 ID 的 Codex 用量单列为“未归属历史”，不会猜测归属；Antigravity 用量在各账号视图中共享显示。

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

两个状态栏开关仅控制 pi-web 的 OAI/AGY 片段，不停止查询或隐藏控制台数据。Token 账本是同目录下按本地日期存放的 `usage-YYYY-MM-DD.jsonl`，只记录时间戳、Provider、模型和 Token 计数；不记录提示词或凭据。用量总计仅涵盖**安装本插件后记录的消息**，不回填 Pi 历史；Codex 记录按账号筛选。Reasoning 已包含在 Output 中，不重复计入总量。

费用按 `src/tokens/pricing.ts` 中的公开 API 标价估算（价格核对日期：2026-09-23），**不是订阅实付、余额或预算上限**。未知模型或缺少价格分量的记录标为未计价；缓存时长、非文本、折扣及历史价格变化可能造成偏差。额度窗口的金额是根据本插件已记录的可计价用量和 Provider 返回的使用百分比外推，数据不完整时尤其不可靠。

Codex 凭据仅用于 `https://chatgpt.com/backend-api/wham/usage`；旧版 OAuth Antigravity 凭据仅发送至代码中固定的 Cloud Code Assist 域名，HTTP 跳转被禁用。本机 agy 模式调用其自身登录会话，不读取 OAuth 凭据。

## 开发

```bash
npm ci
npm run check
npm pack --dry-run
```

Pi 根据 `package.json` 的 `pi.extensions` 直接加载 TypeScript，无需编译。发布包包含 `src/`、README 和 LICENSE。
