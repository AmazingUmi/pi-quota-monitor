# Pi Quota Monitor — v0.1 任务书

## 1. 目标

开发一个轻量级 Pi 插件，用于**常驻显示 OpenAI Codex 与 Antigravity 的剩余额度**，并附带本地 Token 使用统计。

核心原则：

- 不依赖用户手动执行查询命令。
- 额度查询与 Token 统计分离。
- 优先复用现有 Pi 凭据，不保存访问令牌。
- v0.1 只服务当前实际使用场景，不扩展为通用 Provider 框架。

---

## 2. v0.1 功能范围

### 2.1 OpenAI Codex

参考：

- `narumiruna/pi-extensions/packages/pi-usage`
- `agegr/pi-web/lib/provider-usage.ts`

实现：

- 查询 5h 剩余额度。
- 查询 weekly 剩余额度。
- 显示 reset countdown。
- 使用当前 Pi `openai-codex` 登录凭据。
- 仅向官方 `chatgpt.com` usage endpoint 发送凭据。

### 2.2 Antigravity

参考：

- `Rahularya01/pi-antigravity`

实现：

- 查询 Google AI / Antigravity 当前订阅层级。
- 查询 Gemini quota。
- 查询 Claude/GPT shared quota。
- 查询 reset time。
- 必要时使用 per-model `remainingFraction` 作为补充信息。

### 2.3 Token 统计

监听 Pi：

```ts
pi.on("message_end", ...)
```

记录：

- input
- output
- reasoning
- cacheRead
- cacheWrite
- totalTokens
- provider
- model

v0.1 至少提供：

- 当前 session 累计。
- 当日累计。

---

## 3. 状态栏

默认常驻显示，例如：

```text
OAI 73%/61% | AGY G84% C67% | ↑284k ↓37k
```

语义：

- `OAI 73%/61%`：Codex 5h / weekly remaining。
- `AGY G84%`：Gemini quota remaining。
- `C67%`：Claude/GPT shared quota remaining。
- `↑`：input tokens。
- `↓`：output tokens。

空间允许时显示 reset countdown。

---

## 4. 自动刷新策略

触发刷新：

1. `session_start`：立即查询。
2. `model_select`：切换 Provider 后立即查询。
3. `message_end`：缓存超过约 60 秒时刷新相关 Provider。
4. 定时兜底：每 2–5 分钟刷新。
5. 遇到 429 / quota error：立即刷新额度状态。

要求：

- UI 始终保留最近一次成功结果。
- 请求失败不得清空有效缓存。
- 避免重复并发查询。
- `/reload` / session 切换后不得继续使用 stale `ExtensionContext`。

---

## 5. 建议结构

```text
pi-quota-monitor/
├── src/
│   ├── index.ts
│   ├── providers/
│   │   ├── codex.ts
│   │   └── antigravity.ts
│   ├── tokens/
│   │   ├── collector.ts
│   │   └── store.ts
│   ├── scheduler.ts
│   ├── statusline.ts
│   └── types.ts
└── test/
```

---

## 6. 本地数据

建议：

```text
~/.pi/agent/pi-quota-monitor/
├── usage-YYYY-MM-DD.jsonl
└── config.json
```

不得持久化：

- OAuth access token
- refresh token
- API key

Token ledger 仅记录统计数据。

---

## 7. 命令

保留最少命令：

```text
/quota
```

查看完整额度与 Token 统计。

```text
/quota refresh
```

强制刷新全部额度。

日常使用不依赖这些命令。

---

## 8. 明确不做

v0.1 不实现：

- 通用 Provider 插件框架。
- OpenRouter / MiniMax / Kimi / DeepSeek 等其他 Provider。
- Web Dashboard。
- SQLite。
- 云端同步。
- Token 消耗反推订阅额度。
- 高频轮询 Provider API。

---

## 9. 验收标准

完成以下项目即可认为 v0.1 可用：

- [ ] Pi 启动后自动出现状态栏。
- [ ] Codex 5h / weekly quota 可自动刷新。
- [ ] Antigravity Gemini / Claude-GPT quota 可自动刷新。
- [ ] reset time 正确解析。
- [ ] `message_end` 后 Token 累计正确。
- [ ] session / daily Token 统计可查看。
- [ ] Provider 查询失败时保留上一份成功结果。
- [ ] 切换模型后状态栏能正确切换/更新。
- [ ] `/reload` 后无 stale context / timer 异常。
- [ ] 凭据不会写入插件自己的持久化文件。

---

## 10. 实现优先级

```text
P0  Codex quota + statusline
P0  Antigravity quota + statusline
P0  refresh scheduler

P1  Token collector
P1  daily ledger
P1  /quota detail view

P2  UI polish
P2  tests / error classification
```

v0.1 的核心定义：

> **OpenAI Codex + Antigravity 实时剩余额度常驻显示，并附带 Pi 本地 Token 使用统计。**
