# Pi Quota Monitor

[中文](#中文) · [English](#english)

## 中文

在 Pi 状态栏、`/quota` 和本机控制台查看 OpenAI Codex / Claude / Antigravity / Grok 额度与本地 Token 用量。

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
| `/quota-account-save [provider] [名称]` | 保存对应服务当前 OAuth，名称留空时自动生成 |
| `/quota-account-list` | 列出各服务当前账号、历史身份和保存的 profile |
| `/quota-account-use [provider] <名称>` | 只切换对应服务账号，不切模型、不更换会话 |
| `/quota-account-import [provider] <名称> <本机JSON路径>` | 导入 Pi OAuth profile |
| `/quota-account-note [provider] <名称或current> [备注]` | 设置备注，留空清除；也可用 `account:<身份key>` |

`provider` 支持 `openai-codex` / `anthropic` / `xai`（Codex / Claude / Grok）。省略时使用当前模型的受支持服务商，否则回退 Codex；跨服务操作建议显式指定。profile 名称只用字母、数字、点、下划线或连字符；备注可用中文，不作为账号主键。例：`/quota-account-save anthropic work`、`/quota-account-note anthropic current 工作号`、`/quota-account-use anthropic backup`。

其他操作：`/quota-account-current`、`/quota-account-backup [私有目录]`、`/quota-account-backups`、`/quota-account-restore <路径>`、`/quota-account-delete [provider] <名称>`、`/quota-account-reset-cache [provider]`、`/quota-account-reset-usage [provider] <名称或account:身份key>`。

### 显示与估算

- 状态栏 OAI / CLA / AGY 显示 **5 小时 / 每周剩余额度**；GRK 显示 SuperGrok **共享额度剩余**（不是 5 小时窗口，也不是 xAI API 预付费余额）；未知值为 `-`。控制台「状态与设置」分别控制额度卡片是否显示、对应 pi-web 状态栏片段是否显示，两组开关互不影响（TUI 保持显示）；隐藏卡片不停止采集或改变登录。启用倒计时后，OAI 的 `↻` 对 Pro 使用每周窗口，其他套餐使用 5 小时窗口，GRK 使用共享额度重置时间。
- 额度圆环的百分比显示在右侧图例。四张卡片的圆环尺寸相同，并在卡片顶部对齐；窄屏下一起缩小。
- 控制台默认地址：`http://127.0.0.1:38457`，仅监听本机。远程查看可使用 SSH 端口转发；不要将端口暴露到局域网。
- 额度卡直接显示各服务当前账号；查看历史账号时，另行标明额度所属账号、历史读数及时间（非实时），不自动切换登录。Claude 还显示剩余金额的条件估算；不同订阅额度百分比不相加。
- 账号额度下降包含其他客户端，**不能直接归因于本 Pi**。Claude / Antigravity 的条件估算只累计有本地 Token 的额度下降区间，并不证明全部下降由 Pi 造成；混合外部用量仍可能使结果偏差。无可计价记录、读数不足或账本不完整时显示 `—`。
- 本地 Token 金额按公开 API 标价估算，**不是订阅实付、账户余额或服务商额度**。价格表（2026-10-12 补充 GPT-6.1 Sol，原有费率核对于 2026-09-25）涵盖 [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/)、[OpenAI](https://platform.openai.com/docs/pricing)、[Gemini API](https://ai.google.dev/gemini-api/docs/pricing)、[Claude API](https://platform.claude.com/docs/en/about-claude/pricing)、[xAI](https://docs.x.ai/developers/pricing) 的部分主流精确模型 ID；`openai-codex`、`antigravity` 与 `xai` 也仅套用相应公开 API 标价，并非 OAuth 订阅账单。完整模型与来源见 [`src/tokens/pricing.ts`](src/tokens/pricing.ts)。
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) 每百万 Token 的输入 / 缓存读取 / 缓存写入 / 输出标价为 $2 / $0.10 / $2.50 / $10；提示（含缓存）超过 272K Token 时，整单使用 $4 / $0.20 / $5 / $15。仅匹配 `openai` / `openai-codex` 的精确模型 ID `gpt-6.1-sol`；此前未计价的记录在读取时补算，原有已保存金额（包括零）和历史 Token 总量保持不变，账本文件不改写。
- DeepSeek 每百万 Token 谷时 / 峰时价格（缓存命中输入、未命中输入、输出）：`deepseek-flash` 为 $0.003 / $0.006、$0.15 / $0.30、$0.60 / $1.20；`deepseek-v4-pro` 为 $0.022 / $0.044、$0.66 / $1.32、$1.98 / $3.96。**峰时为周一至周五 UTC 01:00–04:00、06:00–10:00，中国法定假日除外**；其余为谷时。按消息时间戳选档，已内置 [2026 年官方假期](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)；其他年份尚未内置假期，工作日峰时可能高估。跨档请求也只能近似。DeepSeek 缓存写入按未命中输入计价。
- `google-vertex / gemini-3.8-flash` 按 [Google Cloud 官方定价](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) 的全球区域 2026 年底前推广价估算（每百万 Input / Cached input / Output Token 分别为 $0.75 / $0.075 / $3.75）；自 2027-01-01 起使用已公布的 $1.50 / $0.15 / $7.50；Gemini API 的 3.6–3.8 Flash 亦按各自已公布的促销/后续价格切换。非全球区域、批量、Grounding、音频和缓存存储等额外收费不在账本内；Claude 缓存写入按 5 分钟档估算，无法分辨 1 小时档。未知模型或无法确定费率的缓存写入不臆测价格。
- Grok 文本模型按 [xAI 全球按量价格](https://docs.x.ai/developers/pricing) 估算：`grok-4.7` / `grok-4.6` 为每百万 Input / Cached input / Output $2 / $0.50 / $6，提示超过 20 万 Token 时整单改为 $4 / $1 / $12；`grok-4.5` 为 $2 / $0.30 / $6，长上下文为 $4 / $0.60 / $12；`grok-4.3` 为 $1.25 / $0.20 / $2.50，长上下文为 $2.50 / $0.40 / $5。xAI 没有单独的缓存写入价，写入不另加价。美国区域端点的 10% 加价、工具调用和图像/视频不在账本内。账本里没有保存金额的 `xai` 记录，读取时按这张表计价，文件本身不改写。

### 账号与本地数据

- Codex、Claude、Grok 通过 Pi 的 `/login openai-codex`、`/login anthropic`、`/login xai` 登录，可保存同服务多个 OAuth profile，各服务独立维护当前账号。切换只替换该服务凭据，保留模型、会话和账本筛选；不自动轮换或降级模型，目标套餐的模型权限以服务商响应为准。Pi 负责刷新，保存的 profile 也是敏感凭据副本；切换前同步原账号最新凭据，验证 Pi 已加载目标，失败回滚。其他共享 `auth.json` 的进程也受影响，请勿在其请求期间切换。
- 内部身份由服务商及稳定账号/组织标识组成，不使用 token、邮箱、备注或套餐名作为主键。默认显示备注、可靠获取的邮箱，或账号短 ID；同邮箱跨服务商/独立组织分别统计。邮箱与备注保存在私有 `account-identities.json`，不写入用量账本。无需保存 profile 即可统计已识别身份；删除 profile 不删除历史。旧 Codex profile 保持兼容，不批量改写旧账本。
- Claude 通过账号资料接口确认用户与组织；不可用时保持未归属，不猜测。原生 Claude JSON 导入需要有效访问凭据以确认身份。Claude/Grok 额度及资料接口并非公开稳定 API，可能失效；身份不明时不保存跨账号读数或估算金额。API Key 不具备这些订阅额度，也不会被发送到订阅查询接口。只有当前登录账号实时查询，历史账号显示最后读数。agy / Antigravity 暂不参与账号管理，保留既有只读额度查询。
- Token 账本位于 `pi-quota-monitor/usage/`：主 Agent 的 `message_end` 与可用的 pi-subagents cost RPC 合并，按 child session 模型消息去重。账号由请求实际认证头对应的 OAuth 身份确定；子会话只采用自己的请求身份元数据，不继承父账号。无法读取会话的 CLI child 按 runId 记录为未计价、未归属用量，不猜测模型。缺失运行元数据、子会话不可读或未加载 pi-subagents 时汇总仍是下界；不保存提示词或凭据。Reasoning 已计入 Output，不重复累计。
- 控制台默认总体，在「账本概览」卡片右上角选择服务商、严格分账号、其他来源和未归属视图。Codex / Claude / Grok 的账号管理分别位于对应额度卡片标题右侧；切换、新增、备注、删除 profile 和重置用量只列出该服务的账号，agy 仍只读。总量等于各已归属账号、其他来源（含 agy、已确认 API Key）及未归属之和；其他服务用量不会重复混入每个 OAuth 账号。无法确认来源的 API 覆盖和旧无身份记录保留未归属。`/quota` 的会话/今日 Token 是所有来源合计。查看账本不切换登录。
- 「各模型明细」按所选统计范围及 Provider / Model 删除**现有本地记录**，先自动备份（不含凭据）；账号视图仅删除对应服务/账号的记录。总量、趋势及金额随之变化，不影响其他账号或服务商额度；未来新用量仍会写入，已删除的可识别 subagent 运行不会因重复同步重现。恢复旧备份可能重新导入已删除记录。
- 额度读数位于 `quota-readings/`，不在账号/账本备份中。
- **手动账号备份包含 OAuth token**、各服务 profile、账号展示资料及账本；从任一卡片进入的手动完整备份与恢复仍涵盖全部服务，不是单卡片备份。自动用量删除/重置备份不含 token。两者均应保存在私有目录，勿分享或提交。恢复兼容旧备份且不自动切换登录；重置本地用量不会重置服务商额度。
- 配置位于 `~/.pi/agent/pi-quota-monitor/config.json`；`PI_CODING_AGENT_DIR` 可更改 Pi 数据目录。`showCodexCard` / `showClaudeCard` / `showGrokCard` / `showAgyCard` 默认为 `true`，只控制额度卡片；与 `show*InStatusbar` 独立。本地连接指示灯缓慢呼吸，遵循系统「减少动态效果」设置。

### 发布与画廊收录

```bash
npm ci
npm run check # 包含 npm 打包清单与静态资源检查
npm view pi-quota-monitor@latest version keywords pi --json
```

Pi 画廊以**已公开发布的 npm 版本**为准：`pi-package` 关键字使其有资格被检索，并不保证立即出现在搜索结果。可检查 [包详情页](https://pi.dev/packages/pi-quota-monitor) 与[名称筛选](https://pi.dev/packages?name=pi-quota-monitor)；若详情可访问、筛选却缺失，通常不是 `extensions/` 布局问题。仓库改动不会更新已发布版本；测试通过后需提升版本号并由有 npm 发布权限的维护者发布，随后再检查索引。请勿为了收录而重复发布相同版本或提交本地凭据。

## English

View OpenAI Codex / Claude / Antigravity / Grok quotas and local token usage in Pi's status bar, `/quota`, and a local dashboard.

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
| `/quota-account-save [provider] [name]` | Save current OAuth; generate a name if omitted |
| `/quota-account-list` | List current accounts, retained identities and profiles |
| `/quota-account-use [provider] <name>` | Switch that provider's account, preserving model/session |
| `/quota-account-import [provider] <name> <local-JSON-path>` | Import a Pi OAuth profile |
| `/quota-account-note [provider] <name-or-current> [note]` | Set/clear a note; also accepts `account:<identity-key>` |

Providers: `openai-codex`, `anthropic`, `xai`. Omission defaults to the current model's supported provider, otherwise Codex. Use explicit providers for cross-service operations. Profile names use letters, digits, dots, underscores or hyphens; free-form notes are display labels, not identities or plans.

Other commands: `/quota-account-current`, `/quota-account-backup [private-directory]`, `/quota-account-backups`, `/quota-account-restore <path>`, `/quota-account-delete [provider] <name>`, `/quota-account-reset-cache [provider]`, `/quota-account-reset-usage [provider] <name-or-account:key>`.

### Display and estimates

- OAI / CLA / AGY status-bar values are **5-hour / weekly remaining quota**. GRK is the SuperGrok **shared credit remaining**, not a 5-hour window and not an xAI API prepaid balance. Unknown values show `-`. “Status & settings” independently controls quota-card visibility and pi-web status segments; hiding a card does not stop collection or change logins. TUI keeps all provider segments. When countdowns are enabled, OAI's `↻` uses the weekly window for Pro and the 5-hour window for other plans; GRK uses the shared-credit reset.
- The quota-ring percentage is shown in the legend. All four cards use the same ring size, aligned to the top of the card, and shrink together on narrow screens.
- The dashboard defaults to `http://127.0.0.1:38457` and listens on loopback only. Use SSH forwarding for remote access; do not expose it to the LAN.
- Claude quota and conditional amount estimates use Pi's current Anthropic Pro/Max OAuth login (`/login anthropic`) and only account-attributed Pi usage. Anthropic OAuth usage/profile endpoints are undocumented and can change; when identity is unavailable, amounts are withheld. API-key usage is not a subscription quota. Grok quota uses Pi's xAI device-code OAuth (`/login xai`) against the undocumented Grok CLI billing host. Inference and management keys are not sent there and do not represent SuperGrok remaining credit. Readings are not stored across accounts when identity cannot be confirmed. The dashboard has independent pi-web OAI/CLA/AGY/GRK status-bar switches; TUI keeps the provider segments.
- Cards directly identify each service's current account, independently of ledger filters. Historical views separately label the quota owner and last reading/time, never a silent login switch. Claude includes conditional remaining-dollar estimates. Percentages across subscriptions are not added.
- Account quota drops include other clients and **cannot be directly attributed to this Pi**. Claude / Antigravity conditional estimates sum only intervals that also have local tokens. Concurrent external usage can still skew them. Unpriced or incomplete samples show `—`.
- Local Token amounts use public API list prices, **not subscription charges, balances, or provider limits**. The catalogue (GPT-6.1 Sol added 2026-10-12; other rates checked 2026-09-25) covers exact mainstream model IDs from [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/), [OpenAI](https://platform.openai.com/docs/pricing), [Gemini API](https://ai.google.dev/gemini-api/docs/pricing), [Claude API](https://platform.claude.com/docs/en/about-claude/pricing), and [xAI](https://docs.x.ai/developers/pricing). `openai-codex`, `antigravity`, and `xai` use corresponding API list prices, not OAuth subscription bills. See [`src/tokens/pricing.ts`](src/tokens/pricing.ts) for models and sources.
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) costs $2 / $0.10 / $2.50 / $10 per million input / cached-input / cache-write / output tokens. Prompts exceeding 272K tokens (including cache) use $4 / $0.20 / $5 / $15 for the full request. Only the exact `gpt-6.1-sol` ID under `openai` / `openai-codex` is matched. Previously unpriced rows are estimated on read; saved amounts (including zero), historical token totals, and ledger files remain unchanged.
- DeepSeek off-peak / peak prices per million cache-hit input, cache-miss input, output tokens: `deepseek-flash` $0.003 / $0.006, $0.15 / $0.30, $0.60 / $1.20; `deepseek-v4-pro` $0.022 / $0.044, $0.66 / $1.32, $1.98 / $3.96. **Peak: Monday–Friday, 01:00–04:00 and 06:00–10:00 UTC, excluding Chinese public holidays**; all other times are off-peak. Pricing uses message timestamps and the [official 2026 holiday calendar](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm); holidays in other years are not yet encoded, so weekday peak estimates may be high. Requests spanning a tier boundary are approximate. DeepSeek cache writes use cache-miss input rates.
- `google-vertex / gemini-3.8-flash` uses [Google Cloud's](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) promotional global rates through 2026 ($0.75 / $0.075 / $3.75 per million input / cached-input / output tokens), changing to published $1.50 / $0.15 / $7.50 on 2027-01-01. Gemini API 3.6–3.8 Flash models similarly switch at their published dates. Non-global regions, batch, grounding, audio and cache storage are not inferred. Claude cache writes assume the 5-minute tier; the ledger cannot distinguish 1-hour writes. Unknown models or unsupported cache writes remain unpriced.
- Grok text models use [xAI's global on-demand prices](https://docs.x.ai/developers/pricing). Per million input / cached-input / output tokens: `grok-4.7` and `grok-4.6` are $2 / $0.50 / $6, or $4 / $1 / $12 once the prompt exceeds 200k tokens; `grok-4.5` is $2 / $0.30 / $6, or $4 / $0.60 / $12; `grok-4.3` is $1.25 / $0.20 / $2.50, or $2.50 / $0.40 / $5. xAI has no separate cache-write charge. The US endpoint premium, tool calls, and image/video usage are not inferred. `xai` rows without a stored amount are priced from this catalogue when read; the ledger files stay unchanged.

### Accounts and local data

- Codex / Claude / Grok use Pi's `/login openai-codex`, `/login anthropic`, `/login xai`. Multiple profiles/current accounts are independent per provider. Switching preserves model, session and ledger selection, without automatic rotation or model fallback. Pi refreshes credentials; saved profiles are sensitive copies. Switching synchronizes refreshed source credentials, verifies the runtime loaded the target, and rolls back on failure. Avoid switching during other processes' requests sharing `auth.json`.
- Stable provider-qualified account/organization identities own usage, not tokens, emails, notes or plans. Display uses a note, reliably available email, or short ID. Email/notes live in private `account-identities.json`, not token ledgers. Same-email identities across providers/independent organizations stay separate. Attribution does not require a saved profile; deleting credentials retains history. Existing Codex profiles/ledgers remain compatible without rewriting old usage.
- Claude identity requires its profile endpoint; native Claude JSON import needs valid access credentials. Claude/Grok subscription endpoints are undocumented and may fail. Unidentified usage stays unassigned; readings/estimates are not persisted across unidentified accounts. API keys are not subscription quotas and are not sent there. Current accounts query live; historical accounts use timestamped snapshots. agy / Antigravity remains read-only and excluded from OAuth management.
- Ledgers in `pi-quota-monitor/usage/` combine main-agent `message_end` with optional pi-subagents cost RPC, deduplicating child turns. Actual request credentials determine attribution. Children use only their own request-identity metadata, never a parent's current login; unreadable CLI children use run IDs with no invented model/price. Missing metadata/sessions or pi-subagents still makes totals a lower bound. No prompts/credentials are stored. Reasoning is included in Output.
- Dashboard defaults to overall; choose provider, strict account, other-source or unassigned scopes at the top right of the overview card. Codex / Claude / Grok each have an account-management control in their quota-card header. Switching, adding, remarks, profile deletion and usage reset list only that service's accounts; agy remains read-only. Overall equals attributed accounts plus other sources (including agy/verified API keys) plus unassigned usage, without repeating other providers in each account. Unverified overrides/legacy rows stay unassigned. `/quota` session/daily tokens total all sources. Viewing a ledger never switches login.
- Model deletion uses the selected scope and Provider / Model after an automatic ledger backup without credentials. Account views remove only that provider/account's records, not other accounts. Totals/trends/estimates update without changing provider quotas; future usage remains collected and identifiable deleted child runs do not reappear on reconciliation. Older backups can restore removed records.
- Quota readings live in `quota-readings/` and are not included in account/ledger backups.
- **Manual account backups contain OAuth tokens**, all providers' profiles, account metadata and ledgers. Full backups/restores opened from any card still cover all services, not just that card. Automatic usage-deletion/reset backups omit credentials. Keep both private. Old backups remain supported; restore does not switch login and local resets do not reset provider quotas.
- Configuration lives in `~/.pi/agent/pi-quota-monitor/config.json`; `PI_CODING_AGENT_DIR` changes the Pi data directory. `showCodexCard` / `showClaudeCard` / `showGrokCard` / `showAgyCard` default to `true` and are independent of `show*InStatusbar`. The local connection indicator breathes slowly and respects reduced-motion preferences.

### Publishing and gallery discovery

```bash
npm ci
npm run check # includes a packed-file and dashboard-asset check
npm view pi-quota-monitor@latest version keywords pi --json
```

The Pi gallery uses the **published public npm version**. The `pi-package` keyword makes it eligible for discovery but does not guarantee an immediate search result. Compare the [direct package page](https://pi.dev/packages/pi-quota-monitor) with the [name filter](https://pi.dev/packages?name=pi-quota-monitor); a working detail page with a missing search result is not fixed by changing the local directory layout. Repository changes do not update npm: after checks pass, a maintainer with npm publishing access must bump the version and publish, then recheck indexing. Do not republish the same version or commit local credentials.
