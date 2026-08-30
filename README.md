# @jischeng/pi-provider-qoder

[English README](./README.en.md)

[Pi](https://pi.dev/) 的 Qoder AI Provider 扩展。它将 Qoder 国际版和中国版接入 Pi，并把 Qoder 可用的模型显示在 Pi 的模型选择器中。

## 主要能力

- 支持 Qoder 国际版和 Qoder 中国版
- 国际版和中国版均支持 PAT 登录（PAT 会先交换为短期 job token）
- 国际版额外支持浏览器 OAuth / device-code 登录；中国版目前仅支持 PAT 登录
- 支持多个独立 Qoder 账号：`qoder`、`qoder-2`、`qoder-cn`、`qoder-cn-2` 等
- 内置 Qoder COSY 请求签名和 WAF 兼容的请求编码
- 支持流式响应和 reasoning/thinking
- 动态获取模型目录、上下文限制、视觉能力、推理能力、effort 选项和价格倍率

## 安装

```bash
pi install npm:@jischeng/pi-provider-qoder
```

## 登录和使用

Qoder 国际版：

```text
/login qoder
/model auto
```

Qoder 中国版：

```text
/login qoder-cn
/model qwen3.7-plus
```

也可以直接指定 Provider 和模型启动 Pi：

```bash
pi --provider qoder --model auto
pi --provider qoder-cn --model qwen3.7-plus
```

登录第一个账号后，下一个账号入口会自动出现：

```text
/login qoder-2
/login qoder-cn-2
```

账号之间相互独立，需要通过 `qoder/<model-id>`、`qoder-2/<model-id>`、
`qoder-cn/<model-id>` 等方式明确选择账号。

## 模型 ID 和模型名称映射

模型 **ID** 是 Pi 实际使用的值，模型名称是模型选择器中显示的名称。

Qoder 的模型目录接口返回的是服务端模型 ID（例如 `qmodel_latest`、`dmodel`）。国际版直接使用这些 Qoder 原生 ID；中国版为了让模型选择器更易读，会将已知的服务端 ID 映射为更友好的模型 ID，并在发送请求时再映射回 Qoder 内部 ID。因此这不是两个版本模型能力不同，而是界面命名和请求映射方式不同。

### Qoder 国际版

| 模型 ID | 显示名称（可能包含倍率） |
| --- | --- |
| `auto` | Qoder Auto |
| `ultimate` | Qoder Ultimate |
| `performance` | Qoder Performance |
| `efficient` | Qoder Efficient |
| `lite` | Qoder Lite |
| `qmodel` | Qwen3.7 Plus (Qoder) |
| `cmodel` | Cantus (Qoder) |
| `qmodel_preview` | Qwen3.8 Max Preview (Qoder) |
| `qmodel_38max` | Qwen3.8 Max (Qoder) |
| `qfmodel` | Qwen3.8 Flash (Qoder) |
| `gmodel` | GLM-5.3 (Qoder) |
| `gfmodel` | GLM-5.3 Flash (Qoder) |
| `qmodel_latest` | Qwen3.7 Max (Qoder) |
| `dmodel` | DeepSeek V4 Pro (Qoder) |
| `dfmodel` | DeepSeek V4 Flash (Qoder) |
| `gm51model` | GLM 5.2 (Qoder) |
| `kmodel` | Kimi K2.7 Code (Qoder) |
| `kmodel_latest` | Kimi K3 (Qoder) |
| `mmodel` | MiniMax M3 (Qoder) |

### Qoder 中国版

| Pi 模型 ID | Qoder 内部 ID | 显示名称（可能包含倍率） |
| --- | --- | --- |
| `auto` | `auto` | Auto · Qoder CN |
| `qwen3.7-max` | `qmodel_latest` | Qwen 3.7 Max · Qoder CN |
| `qwen3.7-plus` | `qmodel` | Qwen 3.7 Plus · Qoder CN |
| `qwen3.6-flash` | `q36fmodel` | Qwen 3.6 Flash · Qoder CN |
| `deepseek-v4-pro` | `dmodel` | DeepSeek V4 Pro · Qoder CN |
| `deepseek-v4-flash` | `dfmodel` | DeepSeek V4 Flash · Qoder CN |
| `glm-5.2` | `gm51model` | GLM 5.2 · Qoder CN |
| `kimi-k2.6` | `kmodel` | Kimi K2.6 · Qoder CN |
| `minimax-m2.7` | `mmodel` | MiniMax M2.7 · Qoder CN |

中国版还兼容以下别名：

- `qwen3.6-plus` → `qmodel`
- `glm-5.1` → `gm51model`
- `minimax-m3` → `mmodel`

### 自动检测新模型

Qoder 可能会新增、移除或重命名模型。插件启动时会自动获取 Qoder 实时模型目录，
检测当前启用的模型及其上下文长度、视觉/推理能力、effort 选项和价格倍率。

如果 Qoder 返回了价格倍率，倍率会直接追加到模型显示名称后面，例如：
`Qwen3.7 Max (Qoder) (0.5x)`。这表示该模型在 Qoder 侧的额度/计费倍率为 `0.5x`，
不代表 Pi 的 API 价格发生了变化。模型目录会缓存在本地，并在缓存过期时刷新（目前为 1 小时）。

**如果要看到新检测到的模型，请完全退出 Pi 后重新启动。**
因为模型选择器会在插件加载时创建。

## Personal Access Token（PAT）

国际版和中国版的 PAT 登录流程一致：Qoder PAT（`pt-...`）会自动交换为短期 job token，PAT 本身不会直接发送到聊天 API。中国版目前没有可用的浏览器 device-code 登录流程，因此需要使用 CN PAT。

支持的环境变量：

| Provider | 第一个账号 | 其他账号 |
| --- | --- | --- |
| 国际版 | `QODER_PERSONAL_ACCESS_TOKEN`、`QODER_PAT` 或 `QODER_API_KEY` | 添加 `_2`、`_3` 等后缀 |
| 中国版 | `QODERCN_PERSONAL_ACCESS_TOKEN`、`QODERCN_PAT` 或 `QODERCN_API_KEY` | 添加 `_2`、`_3` 等后缀 |

例如：

```bash
export QODER_PERSONAL_ACCESS_TOKEN="pt-..."
export QODERCN_PERSONAL_ACCESS_TOKEN="pt-..."
```

也可以配置国际版 Provider 使用的后端：

```bash
export QODER_REGION=cn
# 也支持 QODER_BACKEND=cn 和 QODER_MODE=cn
```

中国账号推荐直接使用 `qoder-cn` Provider。

## 服务端点

国际版：

- Token 交换和账号信息：`https://openapi.qoder.sh`
- 用量查询：`https://openapi.qoder.sh/api/v2/quota/usage`
- 模型和聊天网关：`https://api3.qoder.sh`

中国版：

- Token 交换和账号信息：`https://openapi.qoder.com.cn`
- 用量查询：`https://openapi.qoder.com.cn/api/v2/quota/usage`
- 模型和聊天网关：`https://gateway.qoder.com.cn`

## License

MIT
