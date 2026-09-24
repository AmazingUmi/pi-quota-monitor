# Pi Quota Monitor

[中文](#中文) · [English](#english)

## 中文

显示 OpenAI Codex 与 Antigravity 的剩余额度、Token 用量和 API 标价估算。支持 Pi TUI / pi-web 状态栏、`/quota` 命令及本机 Web 控制台。

### 安装

需要 Node.js 22+、兼容 `@earendil-works/pi-coding-agent` 的 Pi，以及已登录的 Provider。本插件不提供登录服务；Antigravity 需另行安装并登录相应 Provider。本机 agy 模式还需要可执行的 `agy`。

```bash
pi install npm:pi-quota-monitor
```

安装后重启 Pi 或重新加载扩展。仓库开发时可用 `pi --extension ./src/index.ts` 临时加载，或用 `pi install .` 安装本地包。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `/quota` | 查看额度、重置时间及 Token 用量 |
| `/quota-refresh` | 立即刷新额度 |
| `/quota-interval 180` | 设置后台刷新间隔（60–3600 秒） |
| `/quota-console` | 打开本机控制台 |
| `/quota-account-save pro` | 保存当前 Codex OAuth 账号 |
| `/quota-account-list` | 列出已保存账号 |
| `/quota-account-use pro` | 切换 Codex 凭据，保留当前会话 |

状态栏中 OAI / AGY 的两个百分比分别为 **5 小时 / 每周剩余额度**；未知值显示为 `-`。AGY 状态栏显示 Gemini，其他模型额度见 `/quota` 或控制台。查询失败时保留上次成功读数，并标明状态。

### 控制台与账号

控制台默认位于 `http://127.0.0.1:38457`，仅监听 Pi 所在机器的本地地址；远程访问请自行使用 SSH 端口转发，**不要公开到局域网**。端口被占用时会临时使用可用端口。控制台中的端口设置重启 Pi 后生效；页面会定期读取本地缓存，不会因轮询反复请求额度 API。控制台随 Pi 进程运行，不是独立守护进程。

先使用 Pi 原生 `/login` 登录 Codex，再用 `/quota-account-save <名称>` 保存账号；登录其他账号后重复保存。也可用 `/quota-account-import <名称> <本机JSON路径>` 导入单个 Pi OAuth profile。切换账号会先备份、保存当前凭据，再替换 Codex 凭据并验证 Pi 运行时读取的凭据；验证失败会回滚。**不会自动新建会话或重启 Pi**。不要在其他 Pi 进程正在请求时切换：同一 Pi 数据目录的 `auth.json` 是共享的。

控制台可查看总体及各 Codex 账号的账本；切换后默认跟随新账号，手动选定的历史账本不会被覆盖。只有当前账号显示 Codex 实时额度与周期金额估算。无账号归属的旧 Codex 记录只进入总体用量；Antigravity 用量在各账号视图中共享。

其他账号命令：`/quota-account-current`、`/quota-account-delete <名称>`、`/quota-account-reset-cache`、`/quota-account-reset-usage <名称>`、`/quota-account-backup [私有目录绝对路径]`、`/quota-account-backups`、`/quota-account-restore <备份路径>`。删除 profile 不会删除历史用量；重置本地用量**不会重置服务商额度**。恢复以合并方式导入，重复导入不会重复计数。

**备份包含 OAuth token。** 自动备份存于插件私有目录，手动指定的目录必须已存在且权限为 `0700`；备份文件权限为 `0600`。备份不会自动删除，请勿分享或提交到仓库。

### 数据与估算

配置位于 `~/.pi/agent/pi-quota-monitor/config.json`（可用 `PI_CODING_AGENT_DIR` 更改 Pi 数据目录）。默认控制台端口为 `38457`，刷新间隔为 180 秒。Token 账本 `usage-YYYY-MM-DD.jsonl` 只记录**安装本插件后的消息**，不回填以前的 Pi 历史；记录 Token、模型、账号归属和估算金额，不记录提示词或凭据。Reasoning 已包含于 Output，不重复计数。

金额按公开的标准 API 价格估算，**不是订阅实付、余额或预算**。价格表见 [`src/tokens/pricing.ts`](src/tokens/pricing.ts)（核对日期：2026-09-24）。[Google 官方价格](https://ai.google.dev/gemini-api/docs/pricing)中的 Gemini 3.8 Flash 每百万输入 / 输出 / 缓存读取 Token 为 $0.75 / $3.75 / $0.075，适用至 2026-12-31。已有金额的记录保持原值；此前未计价的 3.8 Flash 历史记录会在汇总时补估，原始账本不改写。未知模型、无法可靠计价的记录单独标示。非文本内容、缓存时长、折扣及价格变动可能造成偏差。

周期剩余金额根据**同一额度周期内两次有效读数之间**的本地 Token 消耗和额度下降比例外推；读数不足、额度回升或账本不完整时不外推。其他客户端的消耗也会造成偏差。成功的额度读数单独存于 `quota-readings/`，用于启动时恢复显示；该目录目前不包含在账号与 Token 账本备份中。

### 开发

```bash
npm ci
npm run check
npm pack --dry-run
```

Pi 直接加载 `src/index.ts`；发布包包含 `src/`、README 和 LICENSE。

## English

Show remaining OpenAI Codex and Antigravity quotas, local token usage, and API-list-price estimates in Pi. Available in the Pi TUI / pi-web status bar, `/quota`, and a local web dashboard.

### Install

Requires Node.js 22+, a Pi build compatible with `@earendil-works/pi-coding-agent`, and logged-in providers. This package does not perform provider login. Install and sign in to the Antigravity provider separately; local agy mode also requires the `agy` executable.

```bash
pi install npm:pi-quota-monitor
```

Restart Pi or reload extensions after installation. For repository development, use `pi --extension ./src/index.ts` for a temporary load or `pi install .` for a local package install.

### Commands

| Command | Purpose |
| --- | --- |
| `/quota` | Show quotas, resets, and token usage |
| `/quota-refresh` | Refresh quota readings now |
| `/quota-interval 180` | Set the refresh interval (60–3600 seconds) |
| `/quota-console` | Open the local dashboard |
| `/quota-account-save pro` | Save the current Codex OAuth account |
| `/quota-account-list` | List saved accounts |
| `/quota-account-use pro` | Switch Codex credentials without replacing the session |

The OAI / AGY status-bar percentages are **5-hour / weekly remaining quota**; unknown values appear as `-`. The AGY status bar shows Gemini; see `/quota` or the dashboard for other model groups. Failed queries retain and identify the last successful reading.

### Dashboard and accounts

The dashboard defaults to `http://127.0.0.1:38457` and listens only on the Pi machine's loopback interface. Use SSH port forwarding for remote access; **do not expose the port to the LAN**. If the port is occupied, a free port is used temporarily. Port-setting changes take effect after restarting Pi. Dashboard polling reads local cached data rather than repeatedly calling quota APIs. The dashboard runs inside the Pi process, not as a separate daemon.

Log in to Codex with Pi's native `/login`, then save it with `/quota-account-save <name>`; repeat after logging in to another account. You can also import a single Pi OAuth profile with `/quota-account-import <name> <local-JSON-path>`. Switching backs up and syncs the current credential, replaces only the Codex credential, and verifies what Pi resolves at runtime; failed verification rolls back. It **does not create a session or restart Pi**. Do not switch while another Pi process is making requests: processes sharing a Pi data directory also share `auth.json`.

The dashboard offers overall and per-account Codex ledgers. It follows the new account after a switch unless you deliberately selected a historical ledger. Live Codex quota and period-cost estimates appear only for the active account. Older Codex entries without an account ID appear only in overall totals; Antigravity usage is shared across account views.

Other account commands: `/quota-account-current`, `/quota-account-delete <name>`, `/quota-account-reset-cache`, `/quota-account-reset-usage <name>`, `/quota-account-backup [absolute-private-directory]`, `/quota-account-backups`, and `/quota-account-restore <backup-path>`. Deleting a profile preserves usage history; resetting local usage **does not reset provider quotas**. Restores merge records without double-counting repeated imports.

**Backups contain OAuth tokens.** Automatic backups live in the plugin's private directory. A custom destination must already exist with `0700` permissions; backup files use `0600`. Backups are not automatically deleted. Never share or commit them.

### Data and estimates

Configuration is stored in `~/.pi/agent/pi-quota-monitor/config.json` (`PI_CODING_AGENT_DIR` can change Pi's data directory). The default dashboard port is `38457` and refresh interval is 180 seconds. The `usage-YYYY-MM-DD.jsonl` token ledger covers **messages recorded after installation only**, not older Pi history. It stores token counts, model, account attribution, and estimated cost—not prompts or credentials. Reasoning tokens are included in Output and are not counted twice.

Costs estimate public standard API list prices, **not subscription charges, balances, or budgets**. See [`src/tokens/pricing.ts`](src/tokens/pricing.ts) (checked 2026-09-24). [Google's published price](https://ai.google.dev/gemini-api/docs/pricing) for Gemini 3.8 Flash is $0.75 / $3.75 / $0.075 per million input / output / cache-read tokens through 2026-12-31. Saved amounts remain unchanged. Previously unpriced 3.8 Flash records are estimated during aggregation without rewriting the ledger. Unknown or unsupported usage remains marked unpriced. Non-text usage, cache-storage duration, discounts, and historical price changes can affect accuracy.

Remaining-period cost extrapolates from local token use and quota decline **between two valid readings in the same reset period**. It is withheld when readings are insufficient, quota rises, or the ledger is incomplete; usage from other clients can also distort it. Successful quota readings are stored separately in `quota-readings/` for startup recovery; that directory is not currently included in account/token-ledger backups.

### Development

```bash
npm ci
npm run check
npm pack --dry-run
```

Pi loads `src/index.ts` directly. The published package includes `src/`, README, and LICENSE.
