# pi-relay-fast

[English](README.md)

为 [Pi](https://pi.dev) 提供 Fast 模式，并支持第三方 OpenAI 兼容中转站。
执行 `/fast on`，通过 Pi 原生请求钩子为匹配的中转模型请求添加
`service_tier: "priority"`。

**发布状态：** 独立项目首版暂定 `0.1.0`，当前尚未发布到 npm，请使用下方本地安装方式。

## 功能

- 自动支持 `openai-responses` 和 `openai-completions` 中转接口。
- 默认匹配 `gpt-*`，支持自定义模型通配符及可选 provider/baseURL 白名单。
- 默认请求 `priority`，可统一配置为 `fast`。
- 默认保留已有档位，可显式允许覆盖中转请求的档位。
- 本地命令、会话内开关、注入计数与跳过原因。
- 保留 pi-fast 原有官方 OpenAI、Codex、Anthropic Fast 和受限的官方 Ultrafast 路径。

Fast **默认关闭**。字段进入请求体只证明本地修改成功，不能证明中转转发、上游应用加速，
或实际账单费率；可用性与费用取决于中转站和上游。

## 环境要求

- Node.js **22.19.0 或更新版本**。
- 支持原生请求体/请求头钩子的 Pi；兼容性验证基线为
  `@earendil-works/pi-coding-agent` **1.1.0**。
- 已配置好可用的 Pi 模型和 provider。本扩展不配置中转连接或凭据。

宿主 peer dependency 按 Pi 的包约定声明为 `*`，不代表兼容所有 Pi 版本；
当前测试基线是 1.1.0。

## 安装

克隆仓库并在项目根目录安装：

```sh
git clone https://github.com/wbxs2077/pi-relay-fast.git
cd pi-relay-fast
pi install .
```

Pi 直接引用该目录，不复制源码，因此安装后请保留目录。
在 Pi 中使用不需要编译，也不必先安装开发依赖。已打开的 Pi 会话执行：

```text
/reload
/fast on
/fast status
```

不要同时加载上游 `pi-fast`、扩展合集中的 fast，或其他注册 `/fast` 的扩展。
请先关闭或移除重名扩展。

卸载本地版时，在同一项目根目录执行 `pi remove .`，然后 `/reload`。
该命令不会删除你的 `fast.json` 配置。

## 配置

自动匹配无需额外配置。需要调整时，将 [examples/fast.json](examples/fast.json) 合并到：

- 全局：`~/.pi/agent/extensions/fast.json`。
- 项目：当前目录或祖先目录中最近的 `.pi/fast.json`，仅在 Pi 信任该项目后读取。
  信任项目前请检查其配置。

如果 Pi 使用自定义 agent/config 目录，请使用对应位置。修改后重启或 `/reload`。

```json
{
  "enabled": false,
  "showStatus": true,
  "relay": {
    "mode": "auto",
    "models": ["gpt-*"],
    "serviceTier": "priority",
    "overwriteServiceTier": false
  }
}
```

如需限制目标，请参考 [白名单示例](examples/fast.allowlist.json)。
[models.json 示例](examples/models.json) 演示用环境变量配置中转连接；替换示例 URL 和模型，
单独合并到 Pi 的 `models.json`，不要写进 `fast.json`。

加载顺序为默认值、全局配置、受信任的项目配置；字段合并，数组整体替换。
JSON 无效、字段未知或类型错误都会停用注入，`/fast on` 也不能绕过。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 会话开始时的 Fast 默认状态 |
| `showStatus` | `true` | 生效时显示底部状态提示 |
| `relay.mode` | `"auto"` | `auto` 自动匹配兼容中转；`allowlist` 限制目标 |
| `relay.models` | `["gpt-*"]` | 区分大小写，仅 `*` 是通配符；`[]` 匹配所有模型 |
| `relay.serviceTier` | `"priority"` | 请求的中转档位，可选 `priority` 或 `fast` |
| `relay.overwriteServiceTier` | `false` | 仅为 true 时覆盖中转请求的已有档位 |
| `relay.providers` | `[]` | 白名单模式使用的精确 provider ID |
| `relay.baseURLs` | `[]` | 白名单模式的额外 URL 目标 |

`auto` 忽略目标列表；`allowlist` 要求 provider 或 URL 至少匹配一项，空列表不选中任何中转。
某层配置填写任一目标列表却省略 `mode` 时，该层采用 `allowlist`。模型和 API 过滤仍然生效。
URL 必须是 HTTP(S)，不得包含凭据、查询参数或片段；按规范化后的完整 origin 和路径匹配，
忽略末尾斜杠，不做 URL 前缀匹配。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/fast`、`/fast toggle` | 切换普通 Fast；当前是 Ultrafast 时关闭 Ultrafast |
| `/fast on` | 开启普通 Fast，并退出 Ultrafast |
| `/fast off` | 停止本扩展的 Fast 与 Ultrafast 注入 |
| `/fast status` | 显示适用性、过滤、档位、覆盖策略、计数及最近结果 |
| `/ultrafast`、`/fast ultrafast` | 切换原有受限官方 Ultrafast |

命令本地执行，不发送模型请求。普通 Fast 开关随同一会话中的模型切换保留，每次请求重新
检查匹配条件。重启或重载后开关恢复配置默认值，计数清零。`/fast off` 不删除其他扩展或
模型配置原本设置的档位。

## 排查与限制

- **不生效：** 查看 `/fast status` 中的 API、模型过滤和白名单模式。带前缀的模型名如
  `openai/gpt-6-astra`，需要 `*/gpt-*` 之类的过滤模式。
- **保留已有档位：** 确实需要替换中转请求档位时，设置 `overwriteServiceTier: true`。
- **配置错误：** 使用合法 JSON 和支持的字段，然后 `/reload`。错误配置会停用注入，
  `/fast on` 也不能绕过。
- **中转拒绝字段：** 关闭 Fast 或排除该模型；扩展不会自动删字段重试或降档。
- **计数增加但没有加速：** 计数表示 payload 修改次数，不是成功响应数、有效加速数或 HTTP 重试数。
- **官方路径：** 受内置模型/API 限制，官方 Codex 要求 OAuth。中转配置不能绕过官方限制或
  覆盖官方路径的已有档位。OpenAI provider ID 使用第三方地址时遵循中转规则，包括排除项。
- **Ultrafast：** 要求 `openai`、`openai-responses`、`gpt-6-astra`、API-key 认证，
  且地址必须为 `https://api.openai.com/v1`（允许一个尾部斜杠）。配置不能启用它；
  切换到不支持的模型/地址后，两种模式都保持关闭，直到手动开启。Pi 显示的费用可能不包含档位溢价。

本次中转支持不包括第三方 Anthropic、Azure/Gemini API、Codex 专用认证协议或中转 Ultrafast。
扩展不记录请求正文、凭据或完整 URL。

## 开发

```sh
npm ci --ignore-scripts
npm run check
```

公开检查只执行 TypeScript 检查和打包预览；`npm pack` 打包前也会执行这些检查，
不调用模型服务。问题可通过 [Issues](https://github.com/wbxs2077/pi-relay-fast/issues) 反馈，
请移除凭据和私人配置。安全漏洞请先请求私下联系渠道，不要公开漏洞细节。

## 来源与许可证

基于 [Diego Petrucci 的 pi-fast](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/fast)。
中转思路参考 [wbxs2077/opencode-relay-fast](https://github.com/wbxs2077/opencode-relay-fast)。
实现采用 Pi 原生钩子，不包装全局 fetch。

使用 [MIT 许可证](LICENSE)，保留上游版权，来源说明见 [NOTICE](NOTICE)。
