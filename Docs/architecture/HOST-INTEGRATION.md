---
type: architecture
covers: [Facade/HeronAI.Facade/**, packages/common/runtime/src/heron-ai/host.mjs, packages/common/runtime/src/dsh/launch.mjs]
external: [AiHost/, Resources/, Web/]
---

# Heron.AI 宿主接入契约

本文定义公共 Facade、独立 App 与其他 WebView 或浏览器宿主之间的进程和页面协议。具体产品的宿主适配器消费这些接口，并在自己的交付边界维护兼容性。

## H1 基本模型

宿主负责三件事，其余全部归产品：

1. **启动进程**并传入参数；
2. **承载返回的 URL**；
3. **管理进程生命周期**。

聊天、模型、工具、权限、历史、模板、技能和主题渲染由 DSH 与产品插件持有。宿主进程负责承载，业务扩展通过插件和桥接参与组合，产品统一管理运行状态和持久化。

```text
宿主                          AiHost 进程
 │  spawn + 启动参数            │
 ├─────────────────────────────►│
 │                              │ 解析/校验参数 → 组装 → 启动 DSH
 │  stdout 逐行 JSON            │
 │◄─────────────────────────────┤ {"event":"ready","port":..,"url":..}
 │  加载 url（WebView2 等）       │
 │                              │
 │  stdin（可选输入）            │
 ├─────────────────────────────►│
 │                              │
 │  关闭 stdin（正常退出）        │
 ├─────────────────────────────►│ 取消 → 持久化 → 退出
```

## H2 启动参数

命令行形式：

```text
node <app>/AiHost/main.mjs --state-dir <data> --local-root <host-data> --ready-file <ready.json>
```

- 发布包内使用 `<app>/node/node.exe`，**不要依赖用户系统 Node**。宿主侧的解析顺序见 `AiProductRuntime.ResolveNode`：显式 `NodeExecutable` → `<productRoot>/node/node.exe` → `<productRoot>/../node/node.exe` → PATH 上的 `node`。
- **运行目录与数据目录必须分开**：`WorkingDirectory` 设为 productRoot，数据写 `stateDir`，**不要把数据写回发布包**。
- 默认绑定 `127.0.0.1`，在 `49152–65535` 动态端口范围内探测空闲端口，避免操作系统分配到浏览器禁用端口；`--port` 可显式指定。

### H2.1 参数白名单（严格）

`dsh/launch.mjs` 的 `accepted` 集合是**白名单**。出现未知参数或参数缺值会**直接抛错**（不是忽略）：

| 参数 | 语义 |
| --- | --- |
| `--state-dir <dir>` | 产品状态根。默认 `~/.heronAi` |
| `--local-root <dir>` | 宿主侧数据根（工作区缓存、身份等）。默认等于 `stateDir` |
| `--ready-file <file>` | 把 `ready` 事件同时写入该文件 |
| `--workspace <dir>` | 启动工作区（会 `chdir`）。默认 `process.cwd()` |
| `--port <n>` | 监听端口，`0` 表示随机 |
| `--host-theme light\|dark` | 首屏跟随宿主主题 |
| `--host-integration <已注册标识>` | 宿主身份，决定宿主包与默认业务包，见 H2.2 |
| `--host-edition <标识>` | 宿主声明的版型，默认 user；公共层校验标识格式，具体用途与权限策略由接入方解释 |
| `--server-url <url>` | 覆盖部署方提供的服务地址；公共载荷没有默认部署端点。JSON 的 `providerCatalogUrl` 可覆盖统一目录入口；详见 [Provider 目录](../guides/provider-catalog.md) |
| `--credential-root <dir>` | 旧凭据导入位置。默认 `stateDir` |
| `--identity-file <file>` | 外部身份文件；请求头和身份字段由集成包提供，公共层只消费显式配置，不推测公司账号或身份文件位置 |
| `--config <file>` | JSON 配置文件，**相对路径以该文件所在目录为基准**解析 |
| `--skills-dir` / `--templates-dir` | 覆盖随包内容目录 |
| `--mcp-config <file>` | MCP 配置文件 |
| `--static-root` / `--dev-origin` | 静态资源 / 开发来源（调试用） |
| `--token <hex>` | 宿主控制令牌，必须匹配 `^[0-9a-f]{16,128}$`；传入后开启 H5.1 宿主控制接口 |
| `--reserved-mcp-endpoint <url>` | 可重复。宿主只经自己受管工具提供的端点；MCP Manager 对指向同一监听（host:port，`localhost`/`[::1]` 视同 `127.0.0.1`，任意路径）的条目不加载、不连接、不授权，无论条目叫什么 |


宿主来源通过可选环境变量 `HERON_AI_HOST_METADATA` 传递 JSON `{ "source": "heron", "version": "2.2.43", "build": "release" }`；JSON 配置的 `hostMetadata` 可显式覆盖。Facade 从调用者的 `AiProductOptions.HostSource/HostVersion` 取得产品标识与版本，构建类型读取入口程序集的 `AssemblyConfiguration`，不按目录或进程名称推测。接入方提供自身版本，独立 App 标为 `heron-ai-app`；其他宿主使用各自稳定的来源标识。未提供的信息保持未知。旧载荷忽略此环境变量，新增信息不改变宿主控制与 DSH 协议。



### H2.2 宿主身份

公共运行时从已启用插件的 `heron-ai.hostProfiles` 读取宿主实现，每个宿主 ID 对应包内的 compose 入口和默认业务选择；它不按标识导入某个固定业务包。未安装业务包的独立 App 使用中性组合。所选宿主的提供包是当前宿主的必要组成，插件管理器保护该包；业务内容的其他启停选择沿用原生 profile。

配置中的 `aspects` 是贡献者解释的选择标签，不隐式形成 npm 包名。内容、默认 MCP 和运行入口分别由通用贡献机制合并，缺失或冲突直接报错。宿主提供的技能通过原生 DSH 文件系统提供器挂载。

## H3 就绪协议

- **stdout 是逐行 JSON**，不是纯文本；日志写 stderr。
- 宿主**等待** `{ "event": "ready", "port": ..., "url": ..., "runtime": "dsh" }`，然后加载其中的 `url`。
- **不要自行拼接认证 URL。** `url` 由产品生成，含认证 query。
- `ready` 还带 `pid`、`startupMs`；若传了 `--ready-file`，同一份 JSON 也会写进该文件。

### H3.1 事件类型

| `event` | 载荷 | 含义 |
| --- | --- | --- |
| `ready` | `port`、`url`、`runtime`、`pid`、`startupMs`、`hmr` | 可加载页面；hmr 表示自动热更新是否开启 |
| `activity` | `busy: boolean` | Agent 或工具是否在忙（只在变化时发） |
| `migration` | 阶段文案 | 迁移进度 |

```json
{"event":"ready","port":51823,"pid":41200,"url":"http://127.0.0.1:51823/?...","runtime":"dsh","startupMs":1830}
{"event":"activity","busy":true}
```

### H3.2 宿主的校验义务

Heron.AI 的 C# 运行时在收到 `ready` 时会做以下校验，任何一项失败都视为**启动失败**（`InvalidDataException`），宿主实现应照做或更严格：

- `port` 必须是 1–65535 的整数；
- `url` 必须可解析为绝对 URI；
- `url.Scheme == http`；
- `url.Port == port`；
- `url.UserInfo` 必须为空；
- `url.Host` 必须是 loopback。

超时建议 30 秒（当前宿主实现值）；`HeronAI.App` 的 UI 加载态上限是 45 秒。

### H3.3 外部浏览器与授权窗口

Windows Facade 统一承接普通外链和 MCP 授权，Debug 与发布版使用同一路径：先打开系统浏览器；启动失败，或返回的浏览器进程在三秒内异常退出时，再打开独立 WebView。退出码零和 Chromium 的正常实例交接码 24 都视为成功交接；系统没有返回可观察进程时保持系统交接结果。交接成功仍须通过用户可见页面和授权回调确认，不能据此宣称授权已完成。

Facade 启动 Node 时以 `DSH_EXTERNAL_BROWSER_BRIDGE=stdio-v1` 声明这项可选能力。MCP 授权通过 stdout 的 `external-browser-request` 控制消息传递随机请求 ID 和地址；Facade 消费后，经 stdin 返回匹配 ID 的 `external-browser-result`，说明成功与打开方式。授权地址只经过当前进程的私有管道，不进入公共事件转发、日志或诊断面板。未声明能力的宿主继续使用 Node 的系统浏览器启动器，因此不提高发布包的最低 bridge 版本。

独立 WebView 由 AI 运行时持有，与 AI 页面共用 WebView2 profile；OAuth 继续使用原有 loopback 回调和令牌处理。授权页请求关闭时关闭对应窗口，AI 重启或退出时关闭其持有的外链窗口，系统浏览器由用户管理。

## H4 退出协议

**正常退出 = 关闭 stdin。**

1. 宿主关闭 stdin；
2. 产品侧 `exitOnStdinEnd` 触发，DSH 正常取消并持久化；
3. 宿主等待进程退出。

`AiProductRuntime.StopAsync` 关闭 stdin 后等待 10 秒，超时再结束进程树。UE 关闭面板时先使用 H7.1.4 的显式 stop 完成在途结算。

多个实例分别使用自己的 `stateDir`，运行期间独占该目录。

## H5 页面桥接

### H5.1 宿主控制接口：预设工作区

宿主直接向 sidecar 推送工作区候选，不经过页面。只有传了 `--token` 才注册；请求必须来自 loopback，并带 `Authorization: Bearer <token>`。无令牌启动时接口不存在（404），令牌错误返回 401。

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `PUT` | `/heron-ai-host/workspaces/{source}` | 以 `{ candidates: Candidate[] }` 整体替换该来源的预设；返回 `{ items, errors }` |
| `GET` | `/heron-ai-host/workspaces` | 返回当前全部项目（含普通文件夹） |

`source` 匹配 `^[a-z0-9][a-z0-9-]{0,63}---
type: architecture
covers: [Facade/HeronAI.Facade/**, packages/common/runtime/src/heron-ai/host.mjs, packages/common/runtime/src/dsh/launch.mjs]
external: [AiHost/, Resources/, Web/]
---

# Heron.AI 宿主接入契约

本文定义公共 Facade、独立 App 与其他 WebView 或浏览器宿主之间的进程和页面协议。具体产品的宿主适配器消费这些接口，并在自己的交付边界维护兼容性。

## H1 基本模型

宿主负责三件事，其余全部归产品：

1. **启动进程**并传入参数；
2. **承载返回的 URL**；
3. **管理进程生命周期**。

聊天、模型、工具、权限、历史、模板、技能和主题渲染由 DSH 与产品插件持有。宿主进程负责承载，业务扩展通过插件和桥接参与组合，产品统一管理运行状态和持久化。

```text
宿主                          AiHost 进程
 │  spawn + 启动参数            │
 ├─────────────────────────────►│
 │                              │ 解析/校验参数 → 组装 → 启动 DSH
 │  stdout 逐行 JSON            │
 │◄─────────────────────────────┤ {"event":"ready","port":..,"url":..}
 │  加载 url（WebView2 等）       │
 │                              │
 │  stdin（可选输入）            │
 ├─────────────────────────────►│
 │                              │
 │  关闭 stdin（正常退出）        │
 ├─────────────────────────────►│ 取消 → 持久化 → 退出
```

## H2 启动参数

命令行形式：

```text
node <app>/AiHost/main.mjs --state-dir <data> --local-root <host-data> --ready-file <ready.json>
```

- 发布包内使用 `<app>/node/node.exe`，**不要依赖用户系统 Node**。宿主侧的解析顺序见 `AiProductRuntime.ResolveNode`：显式 `NodeExecutable` → `<productRoot>/node/node.exe` → `<productRoot>/../node/node.exe` → PATH 上的 `node`。
- **运行目录与数据目录必须分开**：`WorkingDirectory` 设为 productRoot，数据写 `stateDir`，**不要把数据写回发布包**。
- 默认绑定 `127.0.0.1`，在 `49152–65535` 动态端口范围内探测空闲端口，避免操作系统分配到浏览器禁用端口；`--port` 可显式指定。

### H2.1 参数白名单（严格）

`dsh/launch.mjs` 的 `accepted` 集合是**白名单**。出现未知参数或参数缺值会**直接抛错**（不是忽略）：

| 参数 | 语义 |
| --- | --- |
| `--state-dir <dir>` | 产品状态根。默认 `~/.heronAi` |
| `--local-root <dir>` | 宿主侧数据根（工作区缓存、身份等）。默认等于 `stateDir` |
| `--ready-file <file>` | 把 `ready` 事件同时写入该文件 |
| `--workspace <dir>` | 启动工作区（会 `chdir`）。默认 `process.cwd()` |
| `--port <n>` | 监听端口，`0` 表示随机 |
| `--host-theme light\|dark` | 首屏跟随宿主主题 |
| `--host-integration <已注册标识>` | 宿主身份，决定宿主包与默认业务包，见 H2.2 |
| `--host-edition user\|agent\|FL` | 宿主版型，默认 user；版型只声明宿主用途；私有企业插件可为 agent 提供共享模型和机器身份策略 |
| `--server-url <url>` | 覆盖部署方提供的服务地址；公共载荷没有默认部署端点。JSON 的 `providerCatalogUrl` 可覆盖统一目录入口；详见 [Provider 目录](../guides/provider-catalog.md) |
| `--credential-root <dir>` | 旧凭据导入位置。默认 `stateDir` |
| `--identity-file <file>` | 外部身份文件；请求头和身份字段由集成包提供，公共层只消费显式配置，不推测公司账号或身份文件位置 |
| `--config <file>` | JSON 配置文件，**相对路径以该文件所在目录为基准**解析 |
| `--skills-dir` / `--templates-dir` | 覆盖随包内容目录 |
| `--mcp-config <file>` | MCP 配置文件 |
| `--static-root` / `--dev-origin` | 静态资源 / 开发来源（调试用） |
| `--token <hex>` | 宿主控制令牌，必须匹配 `^[0-9a-f]{16,128}$`；传入后开启 H5.1 宿主控制接口 |
| `--reserved-mcp-endpoint <url>` | 可重复。宿主只经自己受管工具提供的端点；MCP Manager 对指向同一监听（host:port，`localhost`/`[::1]` 视同 `127.0.0.1`，任意路径）的条目不加载、不连接、不授权，无论条目叫什么 |


宿主来源通过可选环境变量 `HERON_AI_HOST_METADATA` 传递 JSON `{ "source": "heron", "version": "2.2.43", "build": "release" }`；JSON 配置的 `hostMetadata` 可显式覆盖。Facade 从调用者的 `AiProductOptions.HostSource/HostVersion` 取得产品标识与版本，构建类型读取入口程序集的 `AssemblyConfiguration`，不按目录或进程名称推测。 Heron插件传自身环境版本，独立 App 标为 `heron-ai-app`；其他宿主可提供 `u1` 等稳定来源标识。未提供的信息保持未知。旧载荷忽略此环境变量，新增信息不改变宿主控制与 DSH 协议。



### H2.2 宿主身份

公共运行时从已启用插件的 `heron-ai.hostProfiles` 读取宿主实现，每个宿主 ID 对应包内的 compose 入口和默认业务选择；它不按标识导入某个固定业务包。未安装业务包的独立 App 使用中性组合。所选宿主的提供包是当前宿主的必要组成，插件管理器保护该包；业务内容的其他启停选择沿用原生 profile。

配置中的 `aspects` 是贡献者解释的选择标签，不隐式形成 npm 包名。内容、默认 MCP 和运行入口分别由通用贡献机制合并，缺失或冲突直接报错。宿主提供的技能通过原生 DSH 文件系统提供器挂载。

## H3 就绪协议

- **stdout 是逐行 JSON**，不是纯文本；日志写 stderr。
- 宿主**等待** `{ "event": "ready", "port": ..., "url": ..., "runtime": "dsh" }`，然后加载其中的 `url`。
- **不要自行拼接认证 URL。** `url` 由产品生成，含认证 query。
- `ready` 还带 `pid`、`startupMs`；若传了 `--ready-file`，同一份 JSON 也会写进该文件。

### H3.1 事件类型

| `event` | 载荷 | 含义 |
| --- | --- | --- |
| `ready` | `port`、`url`、`runtime`、`pid`、`startupMs`、`hmr` | 可加载页面；hmr 表示自动热更新是否开启 |
| `activity` | `busy: boolean` | Agent 或工具是否在忙（只在变化时发） |
| `migration` | 阶段文案 | 迁移进度 |

```json
{"event":"ready","port":51823,"pid":41200,"url":"http://127.0.0.1:51823/?...","runtime":"dsh","startupMs":1830}
{"event":"activity","busy":true}
```

### H3.2 宿主的校验义务

Heron.AI 的 C# 运行时在收到 `ready` 时会做以下校验，任何一项失败都视为**启动失败**（`InvalidDataException`），宿主实现应照做或更严格：

- `port` 必须是 1–65535 的整数；
- `url` 必须可解析为绝对 URI；
- `url.Scheme == http`；
- `url.Port == port`；
- `url.UserInfo` 必须为空；
- `url.Host` 必须是 loopback。

超时建议 30 秒（当前宿主实现值）；`HeronAI.App` 的 UI 加载态上限是 45 秒。

### H3.3 外部浏览器与授权窗口

Windows Facade 统一承接普通外链和 MCP 授权，Debug 与发布版使用同一路径：先打开系统浏览器；启动失败，或返回的浏览器进程在三秒内异常退出时，再打开独立 WebView。退出码零和 Chromium 的正常实例交接码 24 都视为成功交接；系统没有返回可观察进程时保持系统交接结果。交接成功仍须通过用户可见页面和授权回调确认，不能据此宣称授权已完成。

Facade 启动 Node 时以 `DSH_EXTERNAL_BROWSER_BRIDGE=stdio-v1` 声明这项可选能力。MCP 授权通过 stdout 的 `external-browser-request` 控制消息传递随机请求 ID 和地址；Facade 消费后，经 stdin 返回匹配 ID 的 `external-browser-result`，说明成功与打开方式。授权地址只经过当前进程的私有管道，不进入公共事件转发、日志或诊断面板。未声明能力的宿主继续使用 Node 的系统浏览器启动器，因此不提高发布包的最低 bridge 版本。

独立 WebView 由 AI 运行时持有，与 AI 页面共用 WebView2 profile；OAuth 继续使用原有 loopback 回调和令牌处理。授权页请求关闭时关闭对应窗口，AI 重启或退出时关闭其持有的外链窗口，系统浏览器由用户管理。

## H4 退出协议

**正常退出 = 关闭 stdin。**

1. 宿主关闭 stdin；
2. 产品侧 `exitOnStdinEnd` 触发，DSH 正常取消并持久化；
3. 宿主等待进程退出。

`AiProductRuntime.StopAsync` 关闭 stdin 后等待 10 秒，超时再结束进程树。UE 关闭面板时先使用 H7.1.4 的显式 stop 完成在途结算。

多个实例分别使用自己的 `stateDir`，运行期间独占该目录。

## H5 页面桥接

### H5.1 宿主控制接口：预设工作区

宿主直接向 sidecar 推送工作区候选，不经过页面。只有传了 `--token` 才注册；请求必须来自 loopback，并带 `Authorization: Bearer <token>`。无令牌启动时接口不存在（404），令牌错误返回 401。

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `PUT` | `/heron-ai-host/workspaces/{source}` | 以 `{ candidates: Candidate[] }` 整体替换该来源的预设；返回 `{ items, errors }` |
| `GET` | `/heron-ai-host/workspaces` | 返回当前全部项目（含普通文件夹） |

，各来源互不影响。工作区来源的推送频率、图标及业务会话的展示策略由贡献方维护。

```ts
type Candidate = {
  id: string            // 来源内唯一且稳定
  name: string          // 显示名；用户在产品内改过的名字保留
  kind?: string         // 宿主分类，只用于展示与会话上下文
  ready: boolean        // false 不注册
  projectFile?: string  // 绝对路径，必须位于首个根目录内
  roots: { label: string; path: string }[]   // 1–8 个已存在的绝对目录；首项是工作区目录
  adoptSessions?: boolean // true：产品每 15 秒及每次推送后，把 cwd 等于工作区目录、且不属于任何工作区的已存会话收编进来
}
```

产品只做通用校验（绝对路径、目录存在、项目文件归属、数量上限 200）；项目布局、引擎版本等宿主规则由宿主负责。单个候选不合格时进入 `errors`，其余照常注册；页面侧栏显示最近一次推送的错误。

注册、去重、排序、重命名、会话上下文 `heron-ai:workspace-roots` 与持久化 `<stateDir>/dsh/heron-ai-workspaces.json` 归产品，实现见 `packages/common/runtime/src/heron-ai/workspaces/index.mjs`。预设排序、会话收编及工作区编辑只由主 Sidecar 承担：自动化 ACP 启动器在本次 `heron-ai` 组合行配置 `workspaceOwner: false`，保留目录映射、沙盒与上下文读取，停用上述写操作及工作区写接口，避免多个进程用各自缓存覆盖归属。移除预设不删除文件或聊天记录。用户通过页面认证的 `POST /heron-ai-workspaces` 编辑名称、源文件夹、主要目录或移除本地注册；此接口不接受预设候选，后续宿主推送保留用户编辑。详见 [多目录工作区](../guides/multi-folder-workspaces.md)。


### H5.2 呈现桥接（单会话侧窗）

页面就绪后经 WebView2 发 `heron-ai-presentation-ready`；宿主随后调用：

```js
window.heronAiPresentation.request({ id, action, value })
```

结果通过 `heron-ai-presentation-result` 返回，含原请求 `id`、`ok`，以及 `value` 或 `error`。

| `action` | `value` | 行为 |
| --- | --- | --- |
| `selection` | 无 | 返回完整视图当前 `sessionId`；没有当前会话时**创建临时会话**。不发模型请求，不改草稿 |
| `open` | `{ sessionId }` | 在目标视图打开该会话，等会话与输入框就绪后确认 |

单会话页面通过 `ready.url` 保留认证参数并追加片段 `#heron-ai-view=session`（片段可在 DSH 清理认证 query 的重定向后保留）；已认证页面也接受 `view=session` query。

URL 模式由产品插件 `heron-ai-session-view`（`packages/common/runtime/src/heron-ai/heron-ai-session-view/`）在页面启动前转成通用选项 `__DSH_LAYOUT_OPTIONS__.sidebar` 与 `__DSH_WORKSPACE_OPTIONS__.restoreOnStartup`；DSH 布局与导航只消费这些选项，**不识别 Heron.AI 专用 URL**。单会话视图不挂载工作区侧栏、不自动恢复历史会话，等待宿主经 `open` 显式指定；模型、权限、工具、模板仍用同一个 DSH Session 上下文。

### H5.3 主题

- 首屏：`--host-theme light|dark`；
- 之后：Facade 发送 `heron-ai-theme:light|dark`，宿主的页面模块接收后调用通用主题机制更新呈现；
- **用户手动选过主题后，产品保留其选择**，宿主不得强行覆盖。

产品内置亮暗主题，宿主 profile 可以贡献外部主题映射；用户手动选择后的保留规则不变。

## H6 多窗口与生命周期

- **一个宿主的多个 WebView 共用一个 sidecar**；不得为每个窗口重复启动相同 dataRoot。
- 同一 sidecar 可同时承载完整工作区与单会话 WebView，两边同时可见、可输入。
- 会话消息和运行状态通过 DSH 原有服务同步；**各页面保留自己的导航、未发送草稿和附件**，不搬运或覆盖编辑器状态。
- 打开侧窗**不隐藏也不冻结**完整工作区；关闭侧窗只隐藏该窗口；退出时由**运行时所有者**统一释放。
- 运行时更新后需要重新初始化（`RestartAtAsync`）。调用方先准备并激活目标产物，重启直接使用该目录，不再调用首次启动的准备回调，避免重复准备或覆盖已选定的目标；不在重启过程中编译或组装。
- **浏览不等于执行**：打开或恢复历史页面只读消息与配置，不恢复 Agent、不申请会话日志写入所有权；只有发送消息才把草稿配置交给 Agent，同一会话的并发发送共享一次激活。草稿与正式日志的存储边界见 [ARCHITECTURE](ARCHITECTURE.md)，宿主不得读写草稿目录。

## H6.1 开发入口

所有宿主共用自动热更新门控：Debug 始终启用后端文件监听和前端插件 HMR；Release 与未报告构建类型的宿主默认关闭。原生重载引擎在两种构建中均保留，以支持显式手动重载（H6.3）。构建类型取启动环境 `HERON_AI_HOST_METADATA.build`，优先于私人配置中的同名报告字段。Facade 根据宿主入口程序集自动传递；原生宿主与直接启动 Node 的宿主须按自身实际构建类型传递该标记，不能根据连接的调试器、安装路径或宿主名称推断。

发布版的本地插件开发是显式例外：宿主可调用 Facade 提供的插件开发选项，将选择保存到当前 AI 状态目录，并在下一次启动或重启 AI 时通过独立启动选项启用同一套 HMR。取消后也需重启才能停止监听；修改开关不会即时中断正在运行的 AI。普通发布用户不操作就没有自动监听成本。该选项只改变 AI/DSH 插件开发模式，不改变宿主的 Release 身份或启用 Avalonia 原生 XAML 热载；私人配置中的版本报告字段不能替代此显式选择。

Debug 的 HMR 监听产品包、DSH 与社区插件、组合模块及当前 profile 中的插件；前端同步插件图并替换更新的浏览器 bundle，后端沿用 DSH 的模块与配置重载。运行代码经过已安装包和包装模块，Debug 因此显式启用已安装包的依赖遍历；DSH 的默认源码监听行为保持不变。它消费已经更新的 JS 产物；TS/TSX/Vue 的源码监视编译和需要重启的启动依赖仍有各自的开发流程。热重载后的组件使用新状态，会话与工作区由持久层持有。

`dev ai-chat` 构建并启动 Debug 独立 App，`npm run dev` 标记为 Debug；两者均启用上述运行时 HMR。common UI 的 Vite 开发入口为 `HERON_AI_UI_DEV_SERVER`（仅接受 `http://127.0.0.1:<port>`）及 `packages/common/ui` 的 `vite.dev.config.ts`，只在 Debug 宿主中注入；发布宿主忽略此环境变量。源码自动编译与运行时重载的边界见 [开发者工作流](developer-workflow.md#3-当前开发循环)。

手机预览在 Heron.AI 根运行 `npm run dev:mobile`，构建后启动本地 sidecar 并打开浏览器手机视口。具体用法见 [本地开发](../../DEVELOPMENT.md#手机预览)。

## H6.2 Windows 网页交互诊断

Windows facade 在产品页面加载前安装被动交互观察脚本，以有界缓冲保留鼠标按下、抬起、点击、拖放、捕获、滚轮、焦点及选区状态变化；键盘仅记事件元数据和计数，不采集按键内容。默认 Information 级别的输入探针仅记录安装、异常与恢复，常态探针只检查 JavaScript 能否返回，不构造 DOM 快照或写交互日志。Debug 日志级别启用后，宿主才采样读取缓冲及视图状态；该能力同时适用于 Debug 和发布构建。观察不会取消事件、改变焦点或修复页面状态。

在宿主现有日志中搜索 `AI WebView input diagnostic`，按 `ViewId` 与 `View=workspace/session` 对照主页面和侧窗。Debug 级别的 `sample` 包含事件累计计数、有限事件尾部、点击位置的元素标签/角色/矩形、`inert`、禁用状态、`pointer-events` 和模态层数量，空闲心跳也只写 Debug。`probe-timeout` 表示该视图的 JavaScript 探针未及时返回，同一异常不重复刷屏；恢复后记录 `probe-recovered`，并额外保留一次 Information 级别的详细快照。探针保持单飞，诊断失败不会阻止产品导航。只记超时不能覆盖 JavaScript 仍响应、点击却被遮挡的故障，此类复现需预先开启详细日志。

只记录白名单中的类型、布尔值和有界数字，不记录聊天或选中文本、输入值、按键内容、元素 ID/类名、URL 和凭据。原页面收到事件但命中遮罩或禁用元素时检查前端；事件缺失时结合故障时间、采样心跳及宿主状态检查输入链路，不能仅凭事件缺失归因于 C# 或 WebView2。

外链点击另有即时的 `[browser]` 诊断，同时写入宿主日志与 AI 调试面板；按 `ViewId` 对照页面点击、WebView2 原生新窗口、Avalonia 转发、系统 Shell 交接、浏览器进程退出和独立 WebView 兜底。只记录协议、布尔值、PID、耗时及错误码。`shell-request-accepted` 和 MCP 的浏览器启动器退出成功只证明系统接受了请求，不能证明授权页已经显示或 OAuth 回调已经到达；后者须以 MCP 的回调、授权结果和连接状态确认。

## H6.3 AI 调试面板与手动重载


手动热更新通过仅限 loopback、带宿主令牌的 `POST /heron-ai-host/reload` 进入 DSH 的串行 profile 重组，比较已加载模块、刷新配置与插件，并更新前端 bundle 的内容版本。Facade 与重启共享生命周期锁，成功后重新导航已打开的 AI 视图；热更新保持进程不变。启动依赖等无法安全替换的模块保留旧代码，结果明确要求重启，不静默改成进程重启。重启或模块替换可能中断运行中的 AI 任务，持久聊天记录沿用原数据目录。


## H7 安全与数据

日志记录阶段、耗时和诊断状态，认证 URL、token、用户凭据与外部身份文件从日志和版本库中排除。验证材料放在本地临时目录。宿主控制令牌通过启动参数传递；ready 回执返回连接所需的认证 URL，宿主侧日志沿用同一脱敏规则。

用户配置、会话和缓存独立于应用载荷，升级、重建与回退沿用原数据目录。

## H7.1 原生宿主

原生宿主可以使用独立入口组装自己的 DSH profile，并在同一个 Node 进程启动公共运行时。stdin、stdout、退出和停止回执沿用本契约，宿主业务与部署策略由其自身维护。

## H8 宿主实现检查清单

给接入 Heron.AI 的新宿主逐条对：

- [ ] 用发布包内的 `node.exe`，不依赖系统 Node
- [ ] `WorkingDirectory` = productRoot，数据写 `stateDir`，不回写发布包
- [ ] 只传白名单里的参数；`--host-integration` 只用 H2.2 的取值
- [ ] 解析 stdout 的**逐行 JSON**，日志从 stderr 读
- [ ] 等 `ready` 事件，用 `url` 字段加载，不拼 URL
- [ ] 校验 port / loopback / 无 UserInfo（H3.2）
- [ ] 正常退出关闭 stdin，强杀只作兜底
- [ ] 多窗口共用一个 sidecar
- [ ] 主题切换走所属宿主包约定的消息，尊重用户手动选择
- [ ] 需要预设工作区时：每次启动生成新令牌传 `--token`，经 H5.1 推送
- [ ] 日志不含认证 URL / Token / 凭据 / 对话内容
- [ ] UE 宿主：写操作只经一次性准入；用户关闭走 `stop` 并等 `stopped` 回执，编辑器退出才关 stdin（H7.1）

## H9 原生自动化进程接口

运行时提供命名扩展入口，不内置某种自动化业务。启用的插件通过 `heron-ai.entrypoints` 将名字映射到包内脚本；宿主以随包 Node 执行 `AiHost/heron-ai/entrypoints.mjs <名字> --state-dir <状态目录> [业务参数...]`。解析使用同一 profile 的启停选择，目标必须在插件目录内，缺失和重名直接失败。

子进程使用当前宿主的依赖树和独立业务参数。业务请求、结果格式、模型策略和任务存储由贡献该入口的插件维护，公共运行时不导入它们的实现。宿主仍负责进程超时、取消及生命周期。
