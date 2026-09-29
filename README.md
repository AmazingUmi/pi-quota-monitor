# Pi Quota Monitor

[中文](#中文) · [English](#english)

## 中文

在 Pi 状态栏、`/quota` 和本机控制台查看 OpenAI Codex / Claude / Antigravity 额度与本地 Token 用量。

### 安装

需要 Node.js 22+。额度查询需要对应服务商的登录凭据；本机 Antigravity `agy` 模式还需要 `agy` 可执行文件。

```bash
pi install npm:pi-quota-monitor
```

安装后重启 Pi 或重新加载扩展。仓库开发可运行 `pi --extension ./extensions/index.ts`，或 `pi install .`。`extensions/index.ts` 是包的唯一 Pi 入口；实现与控制台静态文件放在 `src/`，测试放在 `test/`，发布检查脚本放在 `scripts/`。`package.json` 的 `pi.extensions` 显式指向入口，npm 包须包含 `extensions/` 和 `src/`。

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

- 状态栏 OAI / CLA / AGY 显示 **5 小时 / 每周剩余额度**；未知值为 `-`。控制台的三个额度卡片底部可分别选择是否在 pi-web 状态栏显示对应额度片段（TUI 保持显示）。启用倒计时后，OAI 的 `↻` 对 Pro 使用每周窗口，其他套餐使用 5 小时窗口。
- 控制台默认地址：`http://127.0.0.1:38457`，仅监听本机。远程查看可使用 SSH 端口转发；不要将端口暴露到局域网。
- OAI 额度卡片显示账号剩余额度；逐期趋势按 Codex 账号分别记录 5 小时和每周窗口。Claude 卡片只显示 Pi 当前 Anthropic OAuth 账号的额度，与 Codex 账本视图无关；5 小时/每周金额按相邻读数与可归属的 Pi Token 使用同一**条件估算**算法。额度增加或重置时间明显变化时开启新一期。
- 账号额度下降包含其他 Pi 进程、Codex CLI 等客户端，**不能直接归因于本 Pi**。同一周期内逐对比较相邻读数和对应时间戳的 Pi Token：仅额度下降、无本地 Token 的区间排除；**累计所有可用区间的 Pi 金额与对应额度下降**后提供明确标注的**条件估算**，并不证明全部额度下降由 Pi 造成。混合外部用量仍可能使结果偏差；无可计价记录、读数不足或账本不完整时显示 `—`。旧版未经标注的金额以及未考虑周额度延迟下降的旧周估算会在更新时移除。周额度若连续读数不变，会将其间 Pi Token 暂存并在下一次额度下降时合并校准；最近一次下降后尚未匹配的 Token 不计入分母。两次查询之间的重置只能在下一次读数时发现。
- 本地 Token 金额按公开 API 标价估算，**不是订阅实付、账户余额或服务商额度**。价格表（核对于 2026-09-25）涵盖 [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/)、[OpenAI](https://platform.openai.com/docs/pricing)、[Gemini API](https://ai.google.dev/gemini-api/docs/pricing)、[Claude API](https://platform.claude.com/docs/en/about-claude/pricing) 的部分主流精确模型 ID；`openai-codex` 与 `antigravity` 也仅套用相应公开 API 标价，并非 OAuth 订阅账单。完整模型与来源见 [`src/tokens/pricing.ts`](src/tokens/pricing.ts)。
- DeepSeek 每百万 Token 谷时 / 峰时价格（缓存命中输入、未命中输入、输出）：`deepseek-flash` 为 $0.003 / $0.006、$0.15 / $0.30、$0.60 / $1.20；`deepseek-v4-pro` 为 $0.022 / $0.044、$0.66 / $1.32、$1.98 / $3.96。**峰时为周一至周五 UTC 01:00–04:00、06:00–10:00，中国法定假日除外**；其余为谷时。按消息时间戳选档，已内置 [2026 年官方假期](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)；其他年份尚未内置假期，工作日峰时可能高估。跨档请求也只能近似。DeepSeek 缓存写入按未命中输入计价。
- `google-vertex / gemini-3.8-flash` 按 [Google Cloud 官方定价](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) 的全球区域 2026 年底前推广价估算（每百万 Input / Cached input / Output Token 分别为 $0.75 / $0.075 / $3.75）；自 2027-01-01 起使用已公布的 $1.50 / $0.15 / $7.50；Gemini API 的 3.6–3.8 Flash 亦按各自已公布的促销/后续价格切换。非全球区域、批量、Grounding、音频和缓存存储等额外收费不在账本内；Claude 缓存写入按 5 分钟档估算，无法分辨 1 小时档。未知模型或无法确定费率的缓存写入不臆测价格。

### 账号与本地数据

- 使用 Pi 的 `/login` 登录 Codex 后，可保存或切换账号。使用 Pi 的 `/login anthropic` 登录 Claude Pro/Max；本插件暂不管理 Claude 多账号，Anthropic API Key 不具备订阅额度。Claude OAuth 额度与账号资料接口并非 Anthropic 公开稳定 API，可能失效；资料无法确认时不保存跨账号读数或估算金额，未归属及其他账号的 Token 不参与校准。凭据由 Pi 刷新，本插件不另存 OAuth token。切换会验证凭据并在失败时回滚；同一 Pi 数据目录的其他进程也会读取共享的 `auth.json`，请勿在其请求期间切换。
- 只有当前登录账号可查询 Codex 实时额度；已记录的逐期估算可按历史账号查看。Antigravity 用量在账号视图间共享。
- Token 账本位于 `pi-quota-monitor/usage/`：主 Agent 的 `message_end` 与可用的 pi-subagents cost RPC 合并；按 child session 的模型消息去重，无法读取会话的 CLI child 按 runId 记录为未计价用量，不猜测其模型。无法可靠确定 child 使用的 Codex 账号时，该 child 仅在「总体用量」中显示；缺失的运行元数据、子会话不可读或未加载 pi-subagents 时本地汇总仍是下界；不保存提示词或凭据。Reasoning 已计入 Output，不重复累计。
- 控制台「各模型明细」可按 Provider / Model 删除**现有本地账本记录**，删除前自动备份；账号视图只删除该账号的 Codex 记录，其他 Provider 在视图间共享。总量、趋势及金额随之变化；若删除 Codex 记录，相关账号的历史周期估算会作废（当期可在有足够样本时重新估算）。服务商实际额度不受影响；未来的新用量仍会写入，已删除的可识别 subagent 运行不会因重复同步而重现。恢复旧备份可能重新导入已删除的记录。
- 额度读数位于 `quota-readings/`，OAI 逐期记录位于 `codex-periods/`。这两个目录目前不在账号/账本备份中。
- **账号备份包含 OAuth token**：请保存在私有目录，勿分享或提交。重置本地用量不会重置服务商额度。
- 配置位于 `~/.pi/agent/pi-quota-monitor/config.json`；`PI_CODING_AGENT_DIR` 可更改 Pi 数据目录。

### 发布与画廊收录

```bash
npm ci
npm run check # 包含 npm 打包清单与静态资源检查
npm view pi-quota-monitor@latest version keywords pi --json
```

Pi 画廊以**已公开发布的 npm 版本**为准：`pi-package` 关键字使其有资格被检索，并不保证立即出现在搜索结果。可检查 [包详情页](https://pi.dev/packages/pi-quota-monitor) 与[名称筛选](https://pi.dev/packages?name=pi-quota-monitor)；若详情可访问、筛选却缺失，通常不是 `extensions/` 布局问题。仓库改动不会更新已发布版本；测试通过后需提升版本号并由有 npm 发布权限的维护者发布，随后再检查索引。请勿为了收录而重复发布相同版本或提交本地凭据。

## English

View OpenAI Codex / Claude / Antigravity quotas and local token usage in Pi's status bar, `/quota`, and a local dashboard.

### Install

Requires Node.js 22+ and credentials for the providers you query. Local Antigravity `agy` mode also requires the `agy` executable.

```bash
pi install npm:pi-quota-monitor
```

Restart Pi or reload extensions. For repository development, use `pi --extension ./extensions/index.ts` or `pi install .`. `extensions/index.ts` is the sole Pi entry point; implementation and dashboard assets live in `src/`, tests in `test/`, and packaging checks in `scripts/`. The explicit `pi.extensions` manifest points to the entry, and both `extensions/` and `src/` must be packed.

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

- OAI / CLA / AGY status-bar values are **5-hour / weekly remaining quota**; unknown values show `-`. When countdowns are enabled, OAI's `↻` uses the weekly window for Pro and the 5-hour window for other plans.
- The dashboard defaults to `http://127.0.0.1:38457` and listens on loopback only. Use SSH forwarding for remote access; do not expose it to the LAN.
- Claude quota and conditional amount estimates use Pi's current Anthropic Pro/Max OAuth login (`/login anthropic`) and only account-attributed Pi usage. Anthropic OAuth usage/profile endpoints are undocumented and can change; when identity is unavailable, amounts are withheld. API-key usage is not a subscription quota. The dashboard has independent pi-web OAI/CLA/AGY status-bar switches; TUI keeps the provider segments.
- OAI cards show account remaining quota. The collapsible period chart tracks 5-hour and weekly windows per Codex account; an observed increase or substantial reset-time change starts a new period.
- Account quota drops include Codex CLI, other Pi processes and other clients; they **cannot be directly attributed to this Pi**. Adjacent readings are matched to timestamped local Pi usage. Intervals with a quota drop but no local tokens are excluded; costs and quota drops are summed across all eligible intervals to produce a clearly labeled **conditional estimate**, not proof that Pi caused the whole drop. Concurrent external usage can still skew it. Unpriced/incomplete ledgers or insufficient samples show `—`; unlabeled legacy quotes and older weekly quotes that ignored quota plateaus are removed on update. For a weekly quota plateau, local tokens are paired with the next observed decline; tokens after the latest decline remain pending rather than being charged to an earlier denominator. Resets between queries are detected only at the next observation.
- Local Token amounts use public API list prices, **not subscription charges, balances, or provider limits**. The catalogue (checked 2026-09-25) covers exact mainstream model IDs from [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/), [OpenAI](https://platform.openai.com/docs/pricing), [Gemini API](https://ai.google.dev/gemini-api/docs/pricing), and [Claude API](https://platform.claude.com/docs/en/about-claude/pricing). `openai-codex` and `antigravity` use corresponding API list prices, not OAuth subscription bills. See [`src/tokens/pricing.ts`](src/tokens/pricing.ts) for models and sources.
- DeepSeek off-peak / peak prices per million cache-hit input, cache-miss input, output tokens: `deepseek-flash` $0.003 / $0.006, $0.15 / $0.30, $0.60 / $1.20; `deepseek-v4-pro` $0.022 / $0.044, $0.66 / $1.32, $1.98 / $3.96. **Peak: Monday–Friday, 01:00–04:00 and 06:00–10:00 UTC, excluding Chinese public holidays**; all other times are off-peak. Pricing uses message timestamps and the [official 2026 holiday calendar](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm); holidays in other years are not yet encoded, so weekday peak estimates may be high. Requests spanning a tier boundary are approximate. DeepSeek cache writes use cache-miss input rates.
- `google-vertex / gemini-3.8-flash` uses [Google Cloud's](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) promotional global rates through 2026 ($0.75 / $0.075 / $3.75 per million input / cached-input / output tokens), changing to published $1.50 / $0.15 / $7.50 on 2027-01-01. Gemini API 3.6–3.8 Flash models similarly switch at their published dates. Non-global regions, batch, grounding, audio and cache storage are not inferred. Claude cache writes assume the 5-minute tier; the ledger cannot distinguish 1-hour writes. Unknown models or unsupported cache writes remain unpriced.

### Accounts and local data

- Log in to Codex with Pi's `/login` before saving or switching accounts. Switching verifies the credential and rolls back on failure; avoid switching while another Pi process sharing `auth.json` is making requests.
- Live Codex quota is available only for the active account; recorded period estimates remain viewable per historical account. Antigravity usage is shared across account views.
- Token ledgers in `pi-quota-monitor/usage/` combine main-agent `message_end` with the optional pi-subagents cost RPC. Child session turns are deduplicated against ambient events; CLI children without readable sessions are recorded by run ID as unpriced usage, without guessing a model. Children without a verifiable Codex account appear only under overall usage, not in an account-filtered view. Missing run metadata, unreadable sessions, or an absent pi-subagents extension make local totals a lower bound. No prompts or credentials are stored. Reasoning is included in Output, not counted twice.
- The dashboard's model breakdown can delete **existing local ledger records** by Provider / Model after an automatic backup. An account view removes only that account's Codex records; other providers are shared. Totals, trends, and estimates update without affecting provider quotas; deleting Codex usage invalidates cached period quotes for affected accounts (the current period may be estimated again if enough data remains). Future usage is still collected, while identifiable deleted subagent runs are not re-imported on reconciliation. Restoring an older backup may re-import deleted records.
- Quota readings live in `quota-readings/`; OAI period records live in `codex-periods/`. Neither is currently included in account/ledger backups.
- **Account backups contain OAuth tokens**: keep them private. Resetting the local usage ledger does not reset provider quotas.
- Configuration lives in `~/.pi/agent/pi-quota-monitor/config.json`; `PI_CODING_AGENT_DIR` changes the Pi data directory.

### Publishing and gallery discovery

```bash
npm ci
npm run check # includes a packed-file and dashboard-asset check
npm view pi-quota-monitor@latest version keywords pi --json
```

The Pi gallery uses the **published public npm version**. The `pi-package` keyword makes it eligible for discovery but does not guarantee an immediate search result. Compare the [direct package page](https://pi.dev/packages/pi-quota-monitor) with the [name filter](https://pi.dev/packages?name=pi-quota-monitor); a working detail page with a missing search result is not fixed by changing the local directory layout. Repository changes do not update npm: after checks pass, a maintainer with npm publishing access must bump the version and publish, then recheck indexing. Do not republish the same version or commit local credentials.
