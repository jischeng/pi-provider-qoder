# @jischeng/pi-provider-qoder

[中文说明](./README.md)

[Pi](https://pi.dev/) provider extension for **Qoder AI**. It connects Pi to Qoder Global and Qoder China, and exposes Qoder's available models directly in the Pi model selector.

## Capabilities

- Qoder Global and Qoder China providers
- PAT login for both Qoder Global and Qoder China (exchanged for a short-lived job token)
- Browser OAuth/device-code login additionally supported by Qoder Global; Qoder China currently uses PAT only
- Multiple independent Qoder accounts (`qoder`, `qoder-2`, `qoder-cn`, `qoder-cn-2`, ...)
- Qoder COSY request signing and WAF-compatible request encoding
- Streaming responses and reasoning/thinking support
- Dynamic model catalog, context limits, vision support, effort options, and price factors

## Install

```bash
pi install npm:@jischeng/pi-provider-qoder
```

## Login and use

Global Qoder:

```text
/login qoder
/model auto
```

Qoder China:

```text
/login qoder-cn
/model qwen3.7-plus
```

You can also start Pi with a provider and model:

```bash
pi --provider qoder --model auto
pi --provider qoder-cn --model qwen3.7-plus
```

After the first account is authenticated, the next account slot becomes available:

```text
/login qoder-2
/login qoder-cn-2
```

Accounts are independent. Select the account explicitly with `qoder/<model-id>`,
`qoder-2/<model-id>`, `qoder-cn/<model-id>`, and so on.

## Model IDs and display names

The model **ID** is the value used by Pi. The display name is shown in the model selector.

Qoder's model catalog API returns server-side model IDs such as `qmodel_latest` and `dmodel`.
Qoder Global uses these native IDs directly. For Qoder China, known server-side IDs are mapped
to friendlier IDs in the model selector and mapped back to Qoder's internal IDs when sending a
request. This is a naming and request-mapping difference, not a difference in model capability.

### Qoder Global

| Model ID | Display name (may include multiplier) |
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

### Qoder China

| Pi model ID | Qoder internal key | Display name (may include multiplier) |
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

Compatibility aliases accepted by the CN request mapper include:

- `qwen3.6-plus` → `qmodel`
- `glm-5.1` → `gm51model`
- `minimax-m3` → `mmodel`

Qoder may add, remove, or rename models. On startup, the extension automatically
fetches Qoder's live model catalog and detects enabled models, context limits,
vision/reasoning support, effort options, and price factors.

When Qoder returns a price multiplier, it is appended to the display name, for example
`Qwen3.7 Max (Qoder) (0.5x)`. This is Qoder's quota/billing multiplier and does not change
Pi's API price. The catalog is cached locally and refreshed when it is stale (currently after one hour).

**To see newly detected models in Pi, exit Pi completely and start it again.**
The model selector is built when the extension is loaded.

## Personal Access Token

PAT login works the same way for Qoder Global and Qoder China: a Qoder PAT (`pt-...`)
is exchanged for a short-lived job token automatically, and the PAT itself is not sent directly
to the chat API. Qoder China currently has no supported browser device-code flow, so it requires
a CN PAT.

Supported environment variables:

| Provider | Account 1 | Additional accounts |
| --- | --- | --- |
| Global | `QODER_PERSONAL_ACCESS_TOKEN`, `QODER_PAT`, or `QODER_API_KEY` | Add `_2`, `_3`, ... |
| China | `QODERCN_PERSONAL_ACCESS_TOKEN`, `QODERCN_PAT`, or `QODERCN_API_KEY` | Add `_2`, `_3`, ... |

For example:

```bash
export QODER_PERSONAL_ACCESS_TOKEN="pt-..."
export QODERCN_PERSONAL_ACCESS_TOKEN="pt-..."
```

You can also configure the global backend with:

```bash
export QODER_REGION=cn
# QODER_BACKEND=cn and QODER_MODE=cn are also supported
```

The explicit `qoder-cn` provider is recommended for China accounts.

## Endpoints

Global:

- Token exchange and account information: `https://openapi.qoder.sh`
- Usage: `https://openapi.qoder.sh/api/v2/quota/usage`
- Model and chat gateway: `https://api3.qoder.sh`

China:

- Token exchange and account information: `https://openapi.qoder.com.cn`
- Usage: `https://openapi.qoder.com.cn/api/v2/quota/usage`
- Model and chat gateway: `https://gateway.qoder.com.cn`

## License

MIT
