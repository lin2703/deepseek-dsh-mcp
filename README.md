# DeepSeek DSH MCP

**让 Codex 把具体的编码工作交给 DeepSeek，自己负责规划和验收。**

本仓库是一个 [MCP](https://modelcontextprotocol.io/) 连接器：Codex 通过它启动本机的 DSH（DeepSeek Harness），让 DeepSeek 读取项目、修改文件、运行测试，再接收执行结果。这样，你可以在同一个 Codex 对话中完成需求讨论、任务委派和结果验收。

- 当前版本：**v1.2.2**
- 发布仓库：[lin2703/deepseek-dsh-mcp](https://github.com/lin2703/deepseek-dsh-mcp)
- 许可证：[MIT](LICENSE)
- DSH 文档：<https://deepseek-harness.github.io/deepseek-harness/>

## 工作方式

一次委派的主线：

```mermaid
flowchart LR
  U["你提出需求"] --> C["Codex 规划"]
  C --> M["本 MCP"]
  M --> D["DeepSeek 执行"]
  D --> R["Codex 验收"]
```

## 能获得什么

- **规划与验收仍在主助手。** 需求理解、任务拆分、修改范围和验收标准由 Codex 决定。
- **执行落在本机项目。** DeepSeek 可读取指定路径、编辑获准文件、运行获准命令，适合修复 bug、实现小功能、补充测试等具体任务。
- **按证据交接。** Codex 能拿到执行状态、修改记录、每条命令的退出码、缺失检查和阻塞项，作为验收依据。
- **权限默认收窄。** 写入须在 workspace 内且逐项列出，命令逐条精确授权，不能拼接或联网。

## 快速上手

### 1. 准备环境

| 项目 | 要求 |
| --- | --- |
| 操作系统 | **仅验证 Linux**。 |
| Node.js | **>= 22.16.0**。 |
| 沙箱 | `/usr/bin/bwrap`（bubblewrap）必须存在且可执行；缺失或初始化失败时停止命令执行。 |
| DSH | 独立安装 `@deepseek-ai/dsh`，当前验证版本 **0.2.1-rc.2**，并按官方文档完成认证。 |
| 网络 | DSH 的模型请求需要联网；被委派的命令在无网络沙箱中运行。 |

### 2. 安装并认证 DSH

本适配器不打包 DSH。先安装上游工具：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
```

然后按 [DSH 官方文档](https://deepseek-harness.github.io/deepseek-harness/) 完成认证，认证信息通过环境变量传入。

### 3. 取得本仓库

```sh
git clone https://github.com/lin2703/deepseek-dsh-mcp.git
cd deepseek-dsh-mcp
node --version
```

适配器没有 npm 运行时依赖，也不需要构建，直接运行源码即可。

### 4. 配置 Codex

把 [examples/codex.toml](examples/codex.toml) 中的占位路径换成 `server.mjs` 的真实绝对路径，再合并到 `~/.codex/config.toml`：

```toml
[mcp_servers.deepseek_dsh]
command = "node"
args = ["/absolute/path/to/deepseek-dsh-mcp/server.mjs"]
env_vars = ["PATH", "HOME", "DSH_CLI_PATH", "DEEPSEEK_API_KEY", "DSH_MCP_SEALED_ROOTS", "DSH_MCP_RUNTIME_ROOTS"]
tool_timeout_sec = 960
```

- `env_vars` 把启动 Codex 的 shell 中已有的变量传给 MCP；`DSH_CLI_PATH` 用于显式指定 DSH 入口，也可以使用后文的自动查找方式。
- `tool_timeout_sec = 960` 覆盖单次委派最长 900 秒，并留出退出时间。
- 从带有这些环境变量的 shell 启动 Codex。官方文档：<https://learn.chatgpt.com/docs/extend/mcp?surface=cli>。

若 `dsh` 不在 PATH，可设置 `DSH_CLI_PATH` 指向其 `lib/bin.js`。其他 MCP 客户端使用等价的 stdio 配置：命令 `node`，参数为 `server.mjs` 绝对路径。

## 开始使用

配置只提供 `deepseek_delegate` 工具，不会自动委派；Codex 调用时需给出 `execution`，省略则只返回文本回答，不读写文件、不运行命令。

可以直接用自然语言提出有边界的任务，例如：

> 通过 `deepseek_delegate`，在 `/absolute/path/to/your-project` 中修复 slug 工具对空字符串的处理：仅修改 `src/slug.mjs` 与 `test/slug.test.mjs`，补充测试，并运行 `node --test test/slug.test.mjs`。把实际改动、命令退出码和未完成项交回来。

如果希望 Codex 稳定按此分工，可把下面片段加入你的项目的 `AGENTS.md`：

```text
适合独立验收的子任务，可优先调用 deepseek_delegate。
- 传入 task、context、acceptance、execution；主助手先划范围，完成后验收。
- 同一 workspace 串行执行。
```

### 一次完整的工具调用

通常由 Codex 根据任务生成调用参数。以下示例展示一次调用的内容，路径、文件名和验收要求需按实际项目替换。

```json
{
  "task": "修复 slug 工具对空字符串的处理，并补充对应测试。",
  "context": "项目位于 /absolute/path/to/your-project。实现文件是 src/slug.mjs，测试文件是 test/slug.test.mjs。要求 slugify('') 返回空字符串且不抛异常，保持现有公开 API 不变。只允许修改这两个文件。",
  "acceptance": "改动仅涉及指定文件；node --test test/slug.test.mjs 以退出码 0 结束；交接列出实际改动、每条命令的真实退出码，以及任何未完成项。",
  "execution": {
    "workspace": "/absolute/path/to/your-project",
    "write_paths": [
      "/absolute/path/to/your-project/src/slug.mjs",
      "/absolute/path/to/your-project/test/slug.test.mjs"
    ],
    "commands": [
      "node --test test/slug.test.mjs"
    ],
    "max_steps": 24,
    "timeout_seconds": 600
  }
}
```

### 如何验收返回结果

`completed` 只表示工具层完成；Codex 还要审查 diff 和需求是否真正满足。核对：

- `modified_files.observed` 是否为预期文件。它只记录成功的 write/edit 工具调用，不涵盖命令产生的副作用；`attempted` 非空说明有未成功的写入。
- `commands[]` 的 `status`、`exit_code` 和输出；`not_run`、`unfinished`、`not_executed` 都不算通过。
- `missing_authorized_checks`、`unresolved_failures`、`blockers`、`next_steps` 是否为空或已解释，`verification.acceptance_ready` 是否为 `true`。

完整 diff 由 Codex 在工作区查看，作为交接记录的补充。

## 高级参考

<details>
<summary><code>deepseek_delegate</code> 参数与边界</summary>

必填 `task`、`context`、`acceptance`，可选 `execution`。

| 字段 | 类型与范围 | 说明 |
| --- | --- | --- |
| `workspace` | 绝对、已存在的具体目录 | 读取根和固定工作目录；拒绝 `/`、`/home`、用户 home、`/tmp`、`/usr`、`/etc` 等宽泛位置及私人目录。 |
| `write_paths` | 最多 32 项 | 必须在 workspace 内；空数组表示只读。拒绝 `.git`、`.codex`、`.agents`、`.ssh`、`.aws`、封存根和硬链接。 |
| `read_roots` | 最多 32 项 | 额外读取路径，须为具体任务路径；单个文件根只授权该文件，不授权父目录。 |
| `commands` | 最多 16 条，每条 ≤ 8192 字符 | 逐字匹配的命令字符串，一次一条；不支持 `&&`、`;`、`\|`、命令替换、凭据或网络。 |
| `max_steps` | 整数 1–64，默认 24 | 模型请求次数，不是工具调用次数；约 20%（最多 12）留给验证与交接。 |
| `timeout_seconds` | 整数 10–900，默认 600 | 整次委派的墙钟截止时间，到点停止，不自动重试。 |

命令单次硬上限 **120000 ms**；同一 workspace 同时只允许一个委派，通过私有 `/tmp` 锁协调。

```sh
export DSH_MCP_SEALED_ROOTS='["/absolute/path/to/private-artifacts"]'
export DSH_MCP_RUNTIME_ROOTS='["/absolute/path/to/toolchain/env"]'
```

`DSH_MCP_SEALED_ROOTS` 增加写保护；`DSH_MCP_RUNTIME_ROOTS` 把目录以只读方式挂入 bwrap，不扩大可写范围。两者均为 JSON 数组，须是已存在的绝对目录；无效配置会在启动时报错。

</details>

<details>
<summary>DSH 如何被发现，启动失败怎么办</summary>

DSH 在首次委派时才解析，`initialize`、`tools/list` 和离线测试不要求已安装。顺序：`DSH_CLI_PATH` 的绝对 bin 路径（错误会明确报错）→ 适配器旁的 `node_modules/@deepseek-ai/dsh` → PATH 中的 `dsh`（只查绝对路径条目并解析符号链接）→ Node 与用户 home 推导的全局位置。都失败时返回 `launch_failed`，不会联网安装。非标准位置请显式设置 `DSH_CLI_PATH`。

</details>

<details>
<summary>预算、停止与证据</summary>

每次委派返回 `status`（`completed` / `partial` / `blocked` / `failed`）、`stop_reason`、修改记录、命令结果、未完成项及预算信息。完成状态依据工具记录、已授权检查和交接完整性判定。预算耗尽、超时或取消会停止委派，不自动重新发起任务。

</details>

## v1.2.2 更新

- **命令精确枚举。** 只提供本次授权的命令字符串；workdir 只能是 workspace 或 `"."`，`timeoutMs` 须满足 `0 < timeoutMs <= 120000`；不支持后台任务或提权参数，枚举外的命令在执行前被拒绝并标注为**未执行**。
- **拒绝与未执行更清楚。** 非契约命令、错误 workdir、非法超时和提权请求都会说明命令没有执行；已有执行事实时，不再把输出误判为未执行。
- **真实退出证据优先。** 直接退出码与规范命令证据冲突时标记失败；仅重复执行防护拒绝才可能复用先前结果，一般拒绝不能复用。
- **重复或孤立证据不再被接受。** 按 call id、工具名和调用先后配对；同一 call id 的两组完整证据、无法配对的结果进入 blockers。
- **发布更可移植。** DSH 入口延迟解析，不再从委派 workspace 加载；私人目录由真实用户 home 推导；新增经校验的 `DSH_MCP_SEALED_ROOTS` 与 `DSH_MCP_RUNTIME_ROOTS`；版本元数据更新为 v1.2.2。

## 开发验证

在仓库根目录运行：

```sh
node --check server.mjs
node --check guard.mjs
node --check runtime.mjs
node --test
```

`node --test` 运行仓库内全部 `*.test.mjs`，覆盖入口解析、权限围栏、配置校验、MCP 握手、交接构建和版本元数据等离线逻辑；真实 DeepSeek API 调用和宿主沙箱集成需在装好 DSH 与 bwrap 的机器上验证。

不安装 DSH 也可以做一次 MCP 握手：

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' | node server.mjs
```

预期输出包含 `"serverInfo":{"name":"deepseek-dsh","version":"1.2.2"}`，stdin 关闭后进程正常退出；`tools/list` 只返回 `deepseek_delegate`。

## 许可证与上游

以根目录 [LICENSE](LICENSE) 为准，采用 MIT，Copyright (c) 2026 lin2703。
