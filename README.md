# @jischeng/pi-provider-qoder

[English README](./README.en.md)

[Pi](https://pi.dev/) 的 Qoder AI Provider 扩展。它将 Qoder 国际版和中国版接入 Pi，并把 Qoder 可用的模型展示在 Pi 的模型选择器中。

## 主要特性

- **双区域独立支持**：同时支持 Qoder 国际版（`qoder`）和中国版（`qoder-cn`）
- **多账号渐进式支持**：支持多个独立账号（如 `qoder`、`qoder-2`... 与 `qoder-cn`、`qoder-cn-2`...），登录上一账号后自动开启下一账号入口
- **全链路思考深度透传**：支持将 Pi 的推理等级（`low`/`medium`/`high`/`xhigh`/`max`/`off`）完整传递给 Qoder 上游，并动态展示各模型支持的思考档位
- **128K 输出与 1M 上下文**：最大输出提升至 128K（131,072），上下文窗口最大支持 1M，避免推理链截断或过早压缩
- **动态友好模型 ID 与最新模型**：直接使用 Qoder 服务端返回的 `display_name` 作为模型 ID（如 `Qwen3.8-Max`、`Lite`），自动发现服务端当前可用模型（包括最新 Fast 系列），减少硬编码映射过期
- **10605 排队自动重试**：当 Qoder 服务端高峰期返回 10605 排队繁忙时，自动按建议时间重试（最多 4 次），保障稳定性
- **模型计费倍率展示**：动态获取模型并在模型名称后追加倍率标签（如 `[0.5x]`）
- **实时 Credits 计费与账户配额追踪**：解析响应实际 `credits` 与 `billable`，会话级准确统计 Credits 消耗，支持多级账户配额查询与自适应 Footer
- **COSY 版本自动追踪与工具调用兼容**：从 Qoder CLI 发布信息更新签名版本；将内部 tool call ID 转换为 Qoder 接受的格式，避免后续请求因 ID 格式被拒
- **DSML 残留清洗与异常轮次处理**：清洗网关泄露的 DSML 内部标签，并通过 `reasoning_content` out-of-band 回传思考过程
- **极速热路径编码与零拷贝签名**：查表预置索引 Base64 编码，优化 MD5 签名分片，消除大请求内存峰值
- **OMP 与 Pi 0.84+ 深度兼容**：动态注册 `qoder-api` 提供者并支持 systemPrompt 格式自适应

## 安装

```bash
pi install npm:@jischeng/pi-provider-qoder
# 或在 OneMorePrompt 中使用
omp install npm:@jischeng/pi-provider-qoder
```

本包是 ESM 扩展，`package.json` 同时提供 `main` 与 `exports` 两个入口，因此 `import`、`require`、以及 `moduleResolution: node16` 的下游项目都能直接解析裸包名。需要 Node.js >= 22.12（依赖 `require(esm)`）。

## 登录与使用

### 1. 国际版 (`qoder`)
- 登录：`/login qoder`（支持浏览器 OAuth 或 PAT）
- PAT 申请：https://qoder.com/account/integrations
- 环境变量：`QODER_API_KEY`、`QODER_PERSONAL_ACCESS_TOKEN`、`QODER_PAT`（多账号后缀 `_2`、`_3` 等）

### 2. 中国版 (`qoder-cn`)
- 登录：`/login qoder-cn`（PAT 登录）
- PAT 申请：https://qoder.com.cn/account/integrations
- 环境变量：`QODERCN_API_KEY`、`QODERCN_PERSONAL_ACCESS_TOKEN`、`QODERCN_PAT`（多账号后缀 `_2`、`_3` 等）

PAT（`pt-...`）会在启动或登录时自动交换为短期 job token。

### 命令行启动

```bash
pi --provider qoder --model Lite
pi --provider qoder-cn --model Qwen3.7-Plus
```

在 Pi 交互界面中切换模型：

```text
/model Qwen3.8-Max
/model Lite
```

### 多账号登录

登录第一个账号后，下一个账号入口会自动出现在登录列表中：

```text
/login qoder-2
/login qoder-cn-2
```

## 服务端点

| 端点类型 | 国际版 (`qoder`) | 中国版 (`qoder-cn`) |
| --- | --- | --- |
| PAT 交换 | `https://openapi.qoder.sh/api/v1/jobToken/exchange` | `https://openapi.qoder.com.cn/api/v1/jobToken/exchange` |
| 用户信息 | `https://openapi.qoder.sh/api/v1/userinfo` | `https://openapi.qoder.com.cn/api/v1/userinfo` |
| 用量查询 | `https://openapi.qoder.sh/api/v2/quota/usage` | `https://openapi.qoder.com.cn/api/v2/quota/usage` |
| 聊天网关 | `https://api3.qoder.sh/` | `https://gateway.qoder.com.cn/` |

实际对话网关会按账号从 `region/endpoints` 动态解析并优先路由到 `remote_agent` 节点（模型列表仍走上表推理节点），解析结果在 `~/.pi/agent/qoder-endpoints-cache.json` 中缓存 1 小时。若某个节点返回 `403 code 110 "Billing daily count exceeded"`，扩展会自动切换至候选节点重试并记住可用节点。

## Credits 扣费与账户配额展示

底部状态栏可显示**会话实际扣除的 Credits**，从 Qoder 响应的 `usage.credits` 和 `usage.billable` 中累积。非计费请求计为 0。

账户配额代表**全账号周期的额度**（包含其他 Qoder 客户端），将个人配额、加油包配额和企业包配额分开展示。

### 查询与 Footer 开关

在 Pi 交互界面中：

```text
/qoder-usage
/qoder-usage footer on
/qoder-usage footer off
```

或使用启动参数：

```bash
pi --qoder-credit-footer
```

开启后将替换默认具有误导性的 `$0.000 (sub)` 底部信息，改用标注了 Qoder 会话 Credits 消耗及当前账户各级配额的定制 Footer，并在狭窄终端下自适应换行。

### 离线样式预览

```bash
npm run demo:credits
```

### `omp usage` 用量视图

OMP 的内置 `usage` 视图会读取 provider 级 `usage` 接口，登录后的 Qoder / Qoder CN 账号会以统一结构展示个人配额、加油包与企业资源包余额（读取失败仅展示为无数据，不会将正常凭据标为异常）。在 Pi 中请继续使用 `/qoder-usage`。

## 版本更新提示

扩展启动时会在后台非阻塞检查 npm 上 `@jischeng/pi-provider-qoder` 是否有新版本（超时 2s，失败静默，不自动安装），有新版本时打印单行升级提示。设置环境变量 `PI_PROVIDER_QODER_SKIP_UPDATE_CHECK=1` 可关闭该检查。

## License

MIT
