# DeepSeek DSH MCP

一个无运行时依赖的 stdio [MCP](https://modelcontextprotocol.io/) 适配器：把有边界的开发任务交给本机已安装的 **DeepSeek Harness（DSH）** 执行，并把文件写入、命令退出码、缺失检查、阻塞项和证据整理成稳定的结构化交接结果。

- 当前版本：**1.2.2**
- 适配器自身是独立项目，**不打包**上游 DSH 源码或依赖。
- 发布仓库：[lin2703/deepseek-dsh-mcp](https://github.com/lin2703/deepseek-dsh-mcp)。
- 许可证：[MIT](LICENSE)（Copyright (c) 2026 lin2703）。上游 DSH 为 MIT；本适配器代码以仓库根目录的 `LICENSE` 为准。
- DSH 官方文档：<https://deepseek-harness.github.io/deepseek-harness/>。

## 支持条件与边界

| 项目 | 要求 |
| --- | --- |
| 操作系统 | **仅验证 Linux**。未声明支持 macOS / Windows。 |
| Node.js | **22.16.0**（`>=22.16.0`）。显式调用 DSH 的 `runCli()`，因为 Node 22.16 没有 `import.meta.main`。 |
| DSH | 已安装 `@deepseek-ai/dsh`（当前验证版本 **0.2.1-rc.2**）。 |
| 沙箱 | Linux 上的 `/usr/bin/bwrap`（bubblewrap）。命令在无网络、受限文件系统中运行。 |
| 权限 | 不做提权、不启动后台任务；命令执行使用 bwrap，上游 DSH 子进程所需的运行环境按其官方文档配置。 |

**Linux + bwrap 限制（重要）**：命令执行器直接调用 `/usr/bin/bwrap`。如果该路径不存在、不可执行或 bwrap 初始化失败，执行会**立即失败并停止**，错误以 `DSH_EXECUTOR_SANDBOX:` / `bwrap:` 形式保留；适配器不会回退到无沙箱执行。当前范围没有实现跨平台沙箱。

离线测试只覆盖纯逻辑、临时文件、stdio 子进程和静态配置检查；**不覆盖**真实 DeepSeek API 调用、真实宿主沙箱集成、真实模型委派。这些集成需在安装好 DSH 和 bwrap 的机器上单独验证。

## 从零安装

```sh
git clone https://github.com/lin2703/deepseek-dsh-mcp.git
cd deepseek-dsh-mcp
node --version        # 应为 v22.16.0 或更高
```

本项目没有 npm 运行时依赖，也不需要构建步骤：

```sh
# 不需要 npm install；以下命令直接运行源码
node --check server.mjs
node --test
```

如果本机还没有 DSH，请按上游文档安装（示例，版本以实际为准）：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
```

安装后，先按 [DSH 官方文档](https://deepseek-harness.github.io/deepseek-harness/) 完成账号/API 认证配置，再启动本适配器。认证属于上游 DSH 的运行前提；本适配器不提供登录 CLI，也不要求把密钥写入仓库或提交到配置文件中。

MCP 客户端只启动 `server.mjs`；**DSH 是本适配器的外部运行前提**，不是随仓库发布的依赖。

## 找到 DSH：解析顺序

DSH 的入口在真正发起委派时才解析，导入 `server.mjs` 时**不会**要求 DSH 已安装。因此 `initialize`、`tools/list` 和离线测试在没有 DSH 的机器上也能工作。解析顺序：

1. **`DSH_CLI_PATH`**：绝对路径覆盖，必须指向 DSH 的 bin 入口文件。设置错误会明确报错，不会静默回退。
2. **适配器目录的局部依赖**：只从本适配器自身安装目录解析 `node_modules/@deepseek-ai/dsh`，读取其 `package.json` 的 `bin` 或 `lib/bin.js`。委派任务的 workspace 和进程当前目录**不会**被隐式搜索。
3. **PATH 中的 `dsh`**：只检查 PATH 中**绝对路径**条目，相对路径和空条目会被跳过；找到可执行文件后使用其真实路径（解析 npm 符号链接）。
4. **常见全局 `node_modules` 位置**：由当前 Node 可执行文件位置和用户 home 推导。

例如，DSH 已全局安装但不在 PATH 中时：

```sh
export DSH_CLI_PATH="/absolute/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js"
```

如果四步都失败，委派返回 `launch_failed`，不会尝试联网安装。

## 配置 MCP 客户端

适配器使用标准 stdio 传输：客户端启动 `node /绝对路径/server.mjs`，通过 stdin/stdout 交换 JSON-RPC。不要向 stdout 打印日志。

### Codex

把 [`examples/codex.toml`](examples/codex.toml) 中的占位路径替换为真实绝对路径，然后合并到 Codex 配置。最小形式：

```toml
[mcp_servers.deepseek_dsh]
command = "node"
args = ["/absolute/path/to/deepseek-dsh-mcp/server.mjs"]
env_vars = ["PATH", "HOME", "DSH_CLI_PATH", "DEEPSEEK_API_KEY", "DSH_MCP_SEALED_ROOTS", "DSH_MCP_RUNTIME_ROOTS"]
tool_timeout_sec = 960
```

说明：

- `env_vars` 把 DSH 需要的环境变量从启动 Codex 的 shell 传入 MCP 进程；不要把真实 token 写进仓库或提交配置文件。
- `tool_timeout_sec` 需要覆盖适配器允许的最长 900 秒，并留出进程退出宽限；示例为 960 秒。
- Codex 官方 MCP 配置文档：<https://learn.chatgpt.com/docs/extend/mcp?surface=cli>（旧地址：<https://developers.openai.com/codex/mcp/>）。

### 其他 MCP 客户端

配置等价的 stdio server 即可：命令 `node`，参数为 `server.mjs` 的绝对路径，并传入 DSH 所需环境变量。客户端必须支持工具调用和多行 JSON 结果。

## 工具参数

唯一对外工具是 `deepseek_delegate`。必填 `task`、`context`、`acceptance`；可选 `execution`：

| 字段 | 类型 / 范围 | 含义 |
| --- | --- | --- |
| `workspace` | 绝对、已存在的具体目录 | 隐式读取根、固定工作目录。拒绝 `/`、`/home`、用户 home、`/tmp`、`/usr`、`/etc` 等宽泛根和私人目录。 |
| `write_paths` | 数组，最多 32 | 必须在 workspace 内；空数组表示只读。拒绝 `.git`、`.codex`、`.agents`、`.ssh`、`.aws`、额外封存根和硬链接文件。 |
| `read_roots` | 数组，最多 32 | 额外读取路径，必须是具体任务路径；**单个文件根只授权该文件，不授权其父目录**。拒绝凭据目录和宽泛根。 |
| `commands` | 数组，最多 16，每条 ≤8192 字符 | 精确授权的命令字符串。每条命令单独一次调用，按字面匹配；不支持 `&&`、`;`、`|`、命令替换、凭据或网络。 |
| `max_steps` | 整数 1..64，默认 24 | 模型请求硬上限。约 20%（最多 12）保留给验证与交接；最后一个请求只允许总结，工具被禁用。 |
| `timeout_seconds` | 整数 10..900，默认 600 | 整次委派的硬截止时间；到点停止，不自动重试。 |

省略 `execution` 时只返回文本答案，不执行工具；这是兼容模式。

### 模型可见的 bash schema（v1.2.2）

授权 `commands` 存在时，适配器会重写 bash 工具 schema：

- `command` 是**枚举**，值恰好等于本次授权的命令字符串。枚举外命令在执行前被拒绝，结果明确标注**未执行**；模型不得自行改写、拼接或扩大命令。
- `workdir` 枚举为 `workspace` 或 `"."`；工作目录固定为 workspace，其他目录未授权。
- `timeoutMs` 是整数，必须 `> 0` 且 `<= 120000`；零、负数、非整数和更大值都在执行前被拒绝。
- `additionalProperties: false`：后台任务、提权、额外参数不可用。
- 依赖/环境探测必须放进已授权的实现或检查命令，不能追加独立探测命令。

这些拒绝是**执行前**的分类。真实执行输出里出现“拒绝”字样，不代表命令未执行；只要存在执行事实（退出码或命令证据），就按真实结果判断。

## 预算与交接语义

每次委派都会返回稳定的 JSON 交接，包含：

- `status`：`completed` / `partial` / `blocked` / `failed`。
- `stop_reason`：完成、预算耗尽、截止时间、取消、输出上限、JSONL 损坏、缺失最终回复、未完成工具调用、未解决失败、未配对结果、重复证据、契约冲突、缺失检查、未验证命令等。
- `modified_files.observed`：仅记录成功的 `write`/`edit` 工具调用；`attempted` 记录未成功的写入。**不生成 diff**，命令副作用需人工复核。
- `commands[]`：每条授权命令的 `status`、`exit_code`、`attempts` 和输出摘录。状态包括 `not_run`、`unfinished`、`not_executed`、`succeeded`、`succeeded_unverified`、`failed`、`unknown`。
- `missing_authorized_checks`、`unresolved_failures`、`warnings`、`duplicate_pairs`、`unfinished_tool_calls`、`unverified_commands`、`blockers`、`next_steps`。
- `budget` 与 `deadline`：请求预算、保留区、当前阶段和剩余时间。
- `verification.acceptance_ready`：只有 `completed` 才为 `true`。
- `evidence`：会话、边界、最终回复、工具调用/结果转录和原始事件。

判定原则：

1. **执行事实优先于模型文本**：真实零退出码可判成功，即使输出看起来像拒绝；非零退出码、超时、信号、显式结构化错误始终是失败。
2. **矛盾证据不通过**：顶层退出码与规范命令证据冲突、同一 call id 出现两组完整调用/结果、结果无法配对，都是失败/阻塞证据。
3. **拒绝不等于执行**：只有无任何执行事实的执行前拒绝才能归为“未执行”；真实执行输出中的拒绝词不能冒充未执行。
4. **模型声称完成不算完成**：没有最终回复、检查缺失、失败未解决或证据矛盾时，不会报告 `completed`。
5. **不自动重试**：预算/截止时间/取消/失败都会停止；需先检查证据并做针对性修复。

此外，同一 workspace 同时只允许一个委派；通过私有 `/tmp` 锁目录协调。不要删除不属于自己的锁；强制终止时锁可能保留，需先确认原进程已停止。

## 保护、封存与运行时根

默认保护由**真实用户 home** 推导，不写死任何用户路径：

- 私人目录（不可读）：`$HOME/.codex`、`$HOME/.dsh`、`$HOME/.ssh`、`$HOME/.aws`。
- 受保护写路径：上述私人目录，以及路径中任意位置的 `.git`、`.codex`、`.agents`、`.ssh`、`.aws`；拒绝软链接别名扩大权限。
- 硬链接文件不可通过写路径修改。
- 读路径必须落在 workspace 或显式 `read_roots` 内；`..` 和符号链接按真实路径判定。

### `DSH_MCP_SEALED_ROOTS`

额外封存根，JSON 数组，只增加**写保护**，不会扩大任何权限：

```sh
export DSH_MCP_SEALED_ROOTS='["/absolute/path/to/private-artifacts","/absolute/path/to/sealed-data"]'
```

每个值必须是已存在的绝对目录；无效 JSON、非数组、相对路径、不存在路径、宽泛根（`/`、`/home`、用户 home、`/tmp`、`/usr`、`/etc`、`/var`、`/opt`）以及与凭据目录重叠的路径都会被拒绝。

### `DSH_MCP_RUNTIME_ROOTS`

额外只读运行时挂载，JSON 数组。典型用途是让沙箱内的命令访问某个工具链/环境目录（例如 Python 环境）：

```sh
export DSH_MCP_RUNTIME_ROOTS='["/absolute/path/to/toolchain/env"]'
```

这些目录只以 `--ro-bind` 进入 bwrap，**不会**成为模型可写路径，也不会自动加入 `read_roots`。校验规则与 `DSH_MCP_SEALED_ROOTS` 相同。默认系统只读根为 `/usr`、`/bin`、`/lib`、`/lib64`、`/etc`（存在的才挂载）。

两项配置在启动时解析；无效配置直接报错退出，不会静默忽略。它们只增加封存/只读挂载，不改变 `write_paths` 的 workspace 内约束。

## 验证命令

在仓库根目录执行：

```sh
node --check server.mjs
node --check guard.mjs
node --check runtime.mjs
node --test
```

`node --test` 会运行全部 `*.test.mjs`，包括原有契约/恢复/完整性测试和新增测试：

- 入口解析：`DSH_CLI_PATH` 绝对覆盖、适配器目录局部依赖、绝对 PATH 真实入口、启动脚本，以及委派 workspace 伪造包/相对 PATH 条目被拒绝；
- 保护/配置：home 推导私人目录、`DSH_MCP_SEALED_ROOTS` / `DSH_MCP_RUNTIME_ROOTS` 的校验与“只读、不扩写”行为；
- v1.2.2 元数据：`package.json`、MCP `initialize` 的 `serverInfo.version`、bash 枚举 schema。

离线 MCP 握手（不需要 DSH）：

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' | node server.mjs
```

预期输出包含 `"serverInfo":{"name":"deepseek-dsh","version":"1.2.2"}`；stdin 关闭后进程正常退出。`tools/list` 应返回唯一的 `deepseek_delegate`。

## v1.2.2 更新内容

以下变更依据 v1.2.1 → v1.2.2 的 `server.mjs` / `guard.mjs` 差异整理。

### 1. bash 工具 schema 变为枚举授权

- 模型可见的 bash schema 把 `command` 设为本次 `commands` 的精确枚举；`workdir` 枚举为 workspace 或 `"."`；`timeoutMs` 为 `0 < timeoutMs <= 120000` 的整数；禁止额外参数。
- 工具描述明确：枚举外命令在执行前拒绝且**报告为未执行**；依赖/环境探测必须放进已授权命令，不能作为额外命令发送。
- 命令级描述补充“一次一条、字面匹配、不授权替代命令或扩大范围”。

### 2. 拒绝信息与未执行标记更明确

- 非契约命令、错误 workdir、非法 `timeoutMs`、提权/后台请求都明确说明“命令未执行”。
- 未执行识别模式加入 `timeoutMs`；已知执行事实存在时不再把输出误判为未执行。

### 3. 执行证据优先，冲突即失败

- 直接退出码与规范命令证据分别读取；两者冲突标记为失败（`exit_code_conflict`），不会让递归扫描先遇到的 0 掩盖非零。
- 真实执行事实优先于可读文本：真实 0 退出即使文本像拒绝也算执行成功；非零退出、超时、中止、信号或显式结构化错误始终失败。
- `denied` 仅在没有执行事实时成立；命令证据即使退出码未知也证明执行发生过。

### 4. 重复/孤立证据不再被接受

- 严格配对：call id、工具名兼容且结果在调用之后；缺失结果工具名可容忍，名称不匹配不算证据。
- 同一 call id 出现两组完整调用/结果 → `duplicate_evidence`；结果无法配对 → `unpaired_results`；两者都会出现在 blockers 与 verification 计数中，不能据此报告完成。
- 只有**无执行事实**的“命令已在当前编辑上运行过”拒绝可复用先前结果；真实的重跑仍以最新退出码判定。

### 5. 版本元数据

- MCP `initialize` 的 `serverInfo.version` 从 `1.2.1` 更新为 `1.2.2`。

### 适配器发布整理

- DSH 入口改为**延迟解析**：`DSH_CLI_PATH` / 适配器目录局部依赖 / 绝对 PATH `dsh` / 常见全局位置；导入与 `initialize`/`tools/list` 不再依赖本机安装，也不会从委派 workspace 或进程当前目录隐式加载 DSH。
- guard 的私人目录改由真实用户 home 推导，移除个人机器路径；新增 `DSH_MCP_SEALED_ROOTS` 与 `DSH_MCP_RUNTIME_ROOTS` 两项经校验的 JSON 配置。
- 补齐 `README.md`、`package.json`、`.gitignore`、`examples/codex.toml`、`runtime.mjs` 与测试；`path-scopes.test.mjs` 改为 home 推导。
- 保留 v1.2.2 的证据优先、拒绝分类、命令约束、预算/锁和失败即停语义。

## 目录结构

```text
server.mjs          MCP stdio server、工具 schema、交接构建
guard.mjs           权限围栏、命令沙箱参数、预算/截止时间
runtime.mjs         DSH CLI 延迟解析与启动脚本
*.test.mjs          离线测试
examples/codex.toml Codex MCP 配置示例（含占位路径）
package.json        版本 1.2.2、MIT 许可证、仓库地址、start/test 脚本、type=module
.gitignore          依赖、凭据、本地配置、会话/日志、备份和测试产物
```
