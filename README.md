# Pi Quota Monitor

[中文](#中文) · [English](#english)

## 中文

在 Pi 状态栏、`/quota` 和本机控制台查看 OpenAI Codex / Antigravity 额度与本地 Token 用量。

### 安装

需要 Node.js 22+。额度查询需要对应服务商的登录凭据；本机 Antigravity `agy` 模式还需要 `agy` 可执行文件。

```bash
pi install npm:pi-quota-monitor
```

安装后重启 Pi 或重新加载扩展。仓库开发可运行 `pi --extension ./src/index.ts`，或 `pi install .`。

### 命令

| 命令 | 作用 |
| --- | --- |
| `/quota` | 查看额度、重置时间及用量 |
| `/quota-refresh` | 立即查询额度 |
| `/quota-interval 180` | 设置查询间隔（60–3600 秒） |
| `/quota-console` | 打开本机控制台 |
| `/quota-account-save <名称>` | 保存当前 Codex OAuth 账号 |
| `/quota-account-list` | 列出已保存账号 |
| `/quota-account-use <名称>` | 切换 Codex 账号，不更换会话 |
| `/quota-account-import <名称> <本机JSON路径>` | 导入 Pi OAuth profile |

其他账号操作见 `/quota-account-current`、`/quota-account-backup`、`/quota-account-backups`、`/quota-account-restore`、`/quota-account-delete`、`/quota-account-reset-cache` 和 `/quota-account-reset-usage`。

### 显示与估算

- 状态栏 OAI / AGY 显示 **5 小时 / 每周剩余额度**；未知值为 `-`。启用倒计时后，OAI 的 `↻` 对 Pro 使用每周窗口，其他套餐使用 5 小时窗口。
- 控制台默认地址：`http://127.0.0.1:38457`，仅监听本机。远程查看可使用 SSH 端口转发；不要将端口暴露到局域网。
- OAI 额度卡片显示账号剩余额度；逐期趋势按 Codex 账号分别记录 5 小时和每周窗口。额度增加或重置时间明显变化时开启新一期。
- 账号额度下降包含其他 Pi 进程、Codex CLI 等客户端，**不能归因于本 Pi**。目前没有独立的 Pi 归因额度来源，因此当期金额/余额外推显示 `—`，污染区间不用于校准；旧版基于账号下降的逐期金额将在更新时移除。两次查询之间的重置只能在下一次读数时发现。
- 本地 Token 金额按公开 API 标价估算，**不是订阅实付、账户余额或服务商额度**。`google-vertex / gemini-3.8-flash` 按 [Google Cloud 官方定价](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) 的全球区域 2026 年底前推广价估算（每百万 Input / Cached input / Output Token 分别为 $0.75 / $0.075 / $3.75）；自 2027-01-01 起使用已公布的 $1.50 / $0.15 / $7.50；非全球区域、批量、Grounding 和缓存存储等额外收费不在账本内。价格表见 [`src/tokens/pricing.ts`](src/tokens/pricing.ts)。

### 账号与本地数据

- 使用 Pi 的 `/login` 登录 Codex 后，可保存或切换账号。切换会验证凭据并在失败时回滚；同一 Pi 数据目录的其他进程也会读取共享的 `auth.json`，请勿在其请求期间切换。
- 只有当前登录账号可查询 Codex 实时额度；已记录的逐期估算可按历史账号查看。Antigravity 用量在账号视图间共享。
- Token 账本位于 `pi-quota-monitor/usage/`：主 Agent 的 `message_end` 与可用的 pi-subagents cost RPC 合并；按 child session 的模型消息去重，无法读取会话的 CLI child 按 runId 记录为未计价用量。无法可靠确定 child 使用的 Codex 账号时，该 child 仅在「总体用量」中显示；缺失的运行元数据、子会话不可读或未加载 pi-subagents 时本地汇总仍是下界；不保存提示词或凭据。Reasoning 已计入 Output，不重复累计。
- 额度读数位于 `quota-readings/`，OAI 逐期记录位于 `codex-periods/`。这两个目录目前不在账号/账本备份中。
- **账号备份包含 OAuth token**：请保存在私有目录，勿分享或提交。重置本地用量不会重置服务商额度。
- 配置位于 `~/.pi/agent/pi-quota-monitor/config.json`；`PI_CODING_AGENT_DIR` 可更改 Pi 数据目录。

### 发布前检查

```bash
npm ci
npm run check
npm pack --dry-run
```

## English

View OpenAI Codex / Antigravity quotas and local token usage in Pi's status bar, `/quota`, and a local dashboard.

### Install

Requires Node.js 22+ and credentials for the providers you query. Local Antigravity `agy` mode also requires the `agy` executable.

```bash
pi install npm:pi-quota-monitor
```

Restart Pi or reload extensions. For repository development, use `pi --extension ./src/index.ts` or `pi install .`.

### Commands

| Command | Purpose |
| --- | --- |
| `/quota` | Show quotas, resets, and usage |
| `/quota-refresh` | Query quotas now |
| `/quota-interval 180` | Set query interval (60–3600 seconds) |
| `/quota-console` | Open the local dashboard |
| `/quota-account-save <name>` | Save the current Codex OAuth account |
| `/quota-account-list` | List saved accounts |
| `/quota-account-use <name>` | Switch Codex account without replacing the session |
| `/quota-account-import <name> <local-JSON-path>` | Import a Pi OAuth profile |

Other account commands: `/quota-account-current`, `/quota-account-backup`, `/quota-account-backups`, `/quota-account-restore`, `/quota-account-delete`, `/quota-account-reset-cache`, and `/quota-account-reset-usage`.

### Display and estimates

- OAI / AGY status-bar values are **5-hour / weekly remaining quota**; unknown values show `-`. When countdowns are enabled, OAI's `↻` uses the weekly window for Pro and the 5-hour window for other plans.
- The dashboard defaults to `http://127.0.0.1:38457` and listens on loopback only. Use SSH forwarding for remote access; do not expose it to the LAN.
- OAI cards show account remaining quota. The collapsible period chart tracks 5-hour and weekly windows per Codex account; an observed increase or substantial reset-time change starts a new period.
- Account quota drops include Codex CLI, other Pi processes and other clients; they are **not attributable to this Pi**. Until an independent Pi-attributed quota source exists, current-period monetary extrapolation displays `—` and contaminated intervals are excluded from calibration. Previously stored account-delta-based period estimates are cleared on update. Resets between queries are detected only at the next observation.
- Local Token amounts use public API list prices, **not subscription charges, balances, or provider limits**. `google-vertex / gemini-3.8-flash` uses [Google Cloud's](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) promotional global rates through 2026 ($0.75 / $0.075 / $3.75 per million input / cached-input / output tokens). The published $1.50 / $0.15 / $7.50 rates apply from 2027-01-01. Non-global regions, batch, grounding, and cache storage are not inferred from the ledger. See [`src/tokens/pricing.ts`](src/tokens/pricing.ts).

### Accounts and local data

- Log in to Codex with Pi's `/login` before saving or switching accounts. Switching verifies the credential and rolls back on failure; avoid switching while another Pi process sharing `auth.json` is making requests.
- Live Codex quota is available only for the active account; recorded period estimates remain viewable per historical account. Antigravity usage is shared across account views.
- Token ledgers in `pi-quota-monitor/usage/` combine main-agent `message_end` with the optional pi-subagents cost RPC. Child session turns are deduplicated against ambient events; CLI children without readable sessions are recorded by run ID as unpriced usage. Children without a verifiable Codex account appear only under overall usage, not in an account-filtered view. Missing run metadata, unreadable sessions, or an absent pi-subagents extension make local totals a lower bound. No prompts or credentials are stored. Reasoning is included in Output, not counted twice.
- Quota readings live in `quota-readings/`; OAI period records live in `codex-periods/`. Neither is currently included in account/ledger backups.
- **Account backups contain OAuth tokens**: keep them private. Resetting the local usage ledger does not reset provider quotas.
- Configuration lives in `~/.pi/agent/pi-quota-monitor/config.json`; `PI_CODING_AGENT_DIR` changes the Pi data directory.

### Pre-publish checks

```bash
npm ci
npm run check
npm pack --dry-run
```
