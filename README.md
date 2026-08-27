# pi-provider-qoder

A [pi](https://shittycodingagent.ai/) provider extension that connects pi to the **Qoder API**, exposing Qoder Global and Qoder China models through provider surfaces.

## Features

- **Progressive provider entries**:
  - `qoder` — Global / international Qoder account 1.
  - `qoder-2`, `qoder-3`, ... — additional global accounts, exposed one slot at a time after the previous account is logged in.
  - `qoder-cn` — Qoder China, forced to CN endpoints and independent of `QODER_REGION`.
- **Interactive Login**: Global Qoder supports browser device-code flow or Personal Access Token (PAT) login.
- **Qoder CN PAT Login**: China edition uses a separate PAT login entry (`/login qoder-cn`) and CN token exchange endpoints.
- **WAF Bypass**: Built-in WAF obfuscation and body encoding (`Encode=1`).
- **COSY Signing**: Full COSY signature header generation (RSA/AES-CBC/MD5).
- **Dynamic Model Catalog**: Dynamically fetches model limits, effort configurations, and options from the `/algo/api/v2/model/list` endpoint.
- **Reasoning/Thinking Support**: Real-time extraction of thinking process from API reasoning or HTML-like `<think>` tags.

## Quick start

Install the provider:

```bash
pi install npm:pi-provider-qoder
```

Or install it globally with npm:

```bash
npm install -g pi-provider-qoder
```

Then log in from pi.

Global / international edition, account 1:

```text
/login qoder
```

Global / international edition, account 2 (shown after account 1 is logged in):

```text
/login qoder-2
```

After logging in to account 2, the next slot (`qoder-3`) becomes available in
`/login`. The same pattern continues for additional accounts. Switch manually
between `qoder/<model-id>`, `qoder-2/<model-id>`, and so on in the model selector
(or with the corresponding `--model` value). Accounts are stored independently;
quota exhaustion does not switch accounts automatically.

China edition:

```text
/login qoder-cn
```

### Personal Access Token (PAT)

A Qoder PAT (`pt-...`) cannot authenticate API calls directly — the provider
exchanges it for a short-lived job token (mirroring the official `qodercli` /
`qoderclicn` flow) and resolves your account identity automatically.

Global Qoder account 1:

- Run `/login qoder` and choose **Use API Key (PAT)**, then paste the token.
- Or set `QODER_PERSONAL_ACCESS_TOKEN` (or `QODER_PAT`) before starting pi.
- `QODER_API_KEY` is also accepted; when set, pi automatically exchanges it
  and logs the provider in during startup.

Global Qoder account 2 and later accounts:

- Run `/login qoder-2` (then `/login qoder-3`, etc.) and choose **Use API Key (PAT)**, then paste the token for that account.
- Or set the matching suffixed variables before starting pi, for example `QODER_PERSONAL_ACCESS_TOKEN_2` / `QODER_PAT_2` / `QODER_API_KEY_2`.
- The suffix matches the account slot number; the next provider slot is exposed only after the previous slot is authenticated.

Qoder China:

- Run `/login qoder-cn`, then paste the CN PAT.
- Or set `QODERCN_PERSONAL_ACCESS_TOKEN` (or `QODERCN_PAT`) before starting pi.
- `QODERCN_API_KEY` is also accepted and triggers the same automatic startup login.

> The exchanged job token is short-lived; the provider transparently re-exchanges
> the stored PAT when it expires.

### Region environment variables

The provider also understands these optional variables:

```bash
export QODER_REGION=cn       # or QODER_BACKEND=cn / QODER_MODE=cn
```

Setting a CN PAT without a global PAT also auto-selects CN mode for the `qoder`
entry, but the recommended explicit China entry is still `/login qoder-cn` and
`--provider qoder-cn`.

## Endpoints

Global:

- PAT exchange: `https://openapi.qoder.sh/api/v1/jobToken/exchange`
- User info: `https://openapi.qoder.sh/api/v1/userinfo`
- Usage: `https://openapi.qoder.sh/api/v2/quota/usage`
- Model / chat gateway: `https://api3.qoder.sh/algo/api/v2/...`

China:

- PAT exchange: `https://openapi.qoder.com.cn/api/v1/jobToken/exchange`
- User info: `https://openapi.qoder.com.cn/api/v1/userinfo`
- Usage: `https://openapi.qoder.com.cn/api/v2/quota/usage`
- Model / chat gateway: `https://gateway.qoder.com.cn/algo/api/v2/...`

## Models

### Global `qoder` and `qoder-2`

Both global provider entries expose the same backing model keys returned by
Qoder. The selected provider determines which logged-in account is used.

Exposes the backing model keys returned by Qoder, including:

- **Tier Models**: `auto`, `ultimate`, `performance`, `efficient`, `lite`
- **Frontier Models**:
  - `qmodel` (Qwen3.7 Plus)
  - `cmodel` (Cantus)
  - `qmodel_preview` (Qwen3.8 Max Preview)
  - `qmodel_latest` (Qwen3.7 Max)
  - `dmodel` (DeepSeek V4 Pro)
  - `dfmodel` (DeepSeek V4 Flash)
  - `gm51model` (GLM 5.2)
  - `kmodel` (Kimi K2.7 Code)
  - `kmodel_latest` (Kimi K3)
  - `mmodel` (MiniMax M3)

### China `qoder-cn`

The China provider exposes friendly model IDs and maps them back to Qoder CN's
internal keys at request time:

| Friendly ID | Qoder CN key | Context | Images | Reasoning |
| --- | --- | ---: | :---: | :---: |
| `auto` | `auto` | 180K | ✅ | ✅ |
| `qwen3.7-max` | `qmodel_latest` | 1M | ✅ | ✅ |
| `qwen3.7-plus` | `qmodel` | 1M | ❌ | ✅ |
| `qwen3.6-flash` | `q36fmodel` | 1M | ❌ | ✅ |
| `deepseek-v4-pro` | `dmodel` | 1M | ❌ | ✅ |
| `deepseek-v4-flash` | `dfmodel` | 1M | ❌ | ❌ |
| `glm-5.2` | `gm51model` | 200K | ✅ | ✅ |
| `kimi-k2.6` | `kmodel` | 256K | ✅ | ✅ |
| `minimax-m2.7` | `mmodel` | 200K | ❌ | ❌ |

Compatibility aliases are also accepted for request mapping, such as
`qwen3.6-plus` → `qmodel`, `glm-5.1` → `gm51model`, and `minimax-m3` → `mmodel`.

## Usage

Once logged in, select any Qoder model in pi:

```text
/model qwen3.7-plus
```

Or start directly:

```bash
pi --provider qoder-cn --model qwen3.7-plus
```

Global example:

```bash
pi --provider qoder --model auto
```

## Architecture

```text
src/
├── index.ts            # Extension registration
├── cosy.ts             # COSY signature, machine ID, region/endpoints, CN model aliases
├── login.ts            # OAuth device flow + PAT login sequence
├── pat.ts              # PAT → job-token exchange + identity resolution
├── models.ts           # Model definitions and dynamic config cache
├── oauth.ts            # PAT / OAuth callback orchestrator
├── stream.ts           # Main streaming response handler
├── transform.ts        # Message conversions (OpenAI schema mapping)
├── thinking-parser.ts  # Fallback <think> tag parser
└── qoder-encoding.ts   # WAF bypass body encoder
```

## License

MIT
