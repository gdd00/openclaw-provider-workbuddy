# openclaw-provider-workbuddy

OpenClaw Provider 插件：将 **腾讯 WorkBuddy / CodeBuddy（国内版 & 国际版）** 的账号与积分额度直接接入 OpenClaw，无需额外运行本地 HTTP 反代进程。

> 参考并移植自 [`lorlike/pi-provider-workbuddy`](https://github.com/lorlike/pi-provider-workbuddy)。

## 功能特性

- **双区双 Provider**：
  - `workbuddy` — 国内版网关（`copilot.tencent.com` / `www.codebuddy.cn`）
  - `workbuddy-global` — 国际版网关（`www.workbuddy.ai` / `www.codebuddy.ai`）
- **多种凭据来源（自动优先级）**：
  1. 插件自身刷新后的 Token（保存在 `~/.openclaw/workbuddy/auth.<region>.json`）
  2. WorkBuddy 桌面端登录态只读复用（自动识别 `workbuddy-desktop.info`，支持 Windows/macOS `5.6.0+` `$wbEncrypted` 字段解密）
  3. OpenClaw 原生 OAuth 浏览器/扫码登录（`openclaw models auth login --provider workbuddy` / `workbuddy-global`）
- **动态模型目录与积分倍率**：从上游 `/v3/config`（国内版降级 `/v2/enterprises/personal/models`）拉取模型列表，模型名自动附带消耗倍率（如 `GLM-5.3 · x0.79`），并按实际能力映射 `thinkingLevelMap` 与视觉输入。
- **DSML 工具调用恢复**：流式拦截并还原模型在 `delta.content` 中输出的 `<｜DSML｜invoke>` 标记为原生 `delta.tool_calls`。
- **OpenClaw 用量与斜杠命令**：
  - 原生接入 `/usage` 额度快照（`fetchUsageSnapshot`）
  - `/workbuddy-status`：查看国内版/国际版登录状态、Token 过期时间、剩余积分与今日签到状态
  - `/workbuddy-sign`：国内版每日签到领积分
  - `/workbuddy-refresh`：手动刷新模型目录
  - `/workbuddy-logout [cn|global]`：清除插件本地凭据（不影响桌面端）

## 安装与构建

```bash
npm install
npm run typecheck
npm test
npm run build
```

在 OpenClaw 中安装本地插件：

```bash
openclaw plugins install /path/to/openclaw-provider-workbuddy
```

登录账号（如本机未登录 WorkBuddy 桌面端）：

```bash
# 国内版（微信扫码）
openclaw models auth login --provider workbuddy

# 国际版（浏览器登录）
openclaw models auth login --provider workbuddy-global
```

## 风险提示

WorkBuddy 上游对非官方客户端存在风控与渠道限制，上游协议变更可能导致插件失效；所有调用均消耗你本人账号的 WorkBuddy 积分，请勿用于高频滥用或重要生产账号。
