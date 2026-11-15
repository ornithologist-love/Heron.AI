---
type: architecture
covers: [packages/common/runtime/src, scripts/build.mjs, scripts/build-receipt.mjs, scripts/payload-inputs.mjs, node-runtime.json]
---

# Heron.AI 架构

本文说明产品的运行形态、装配流程、数据边界与跨仓职责。业务组件与公共组件的分工见 [扩展架构](extensions.md)，协议细节见 [宿主契约](HOST-INTEGRATION.md)。

## 1. 运行形态

```text
宿主（独立 App / WebView2 / 浏览器）
   │ 启动进程 + 承载 URL + 管理生命周期
┌──▼─────────────────────────────────────────┐
│ AiHost（Node）                              │
│   DSH 核心引擎（官方固定版本）                │
│   Heron.AI 产品扩展层（heron-ai/）           │
└──┬─────────────────────────────────────────┘
   │ HTTP 127.0.0.1:<随机端口>（带认证 query）
┌──▼─────────────────────────────────────────┐
│ Web 前端：DSH 官方前端 + Heron.AI 组件       │
└────────────────────────────────────────────┘
```

- **核心引擎与产品扩展分工**：DSH 负责应用主循环、会话与工具调用；Heron.AI 在其上补充产品装配、模型目录与定制界面。
- **DSH 定制边界**：DSH 子模块仅在官方提交上叠加不含业务的通用扩展点、修复与通用能力，不改写官方预编译产物；业务行为统一放在产品包中（见 [业务定制如何接入 DSH](dsh-customization.md)）。`forks.json` 仅登记产品与社区包的构建，日常构建直接使用官方 npm 预编译包（见 [依赖来源](../guides/dependencies.md)）。

## 2. 启动与插件组合

本机启动链路为 `main.mjs → prepareHeron.AI → prepareComposition → launchDsh`，静态模块组合可复用，每次启动按需注入实例配置：

1. 启动参数按宿主契约严格校验，遇到未知参数直接报错。
2. `DSH_VERSION` 必须与已安装版本精确匹配；升级时需同步更新常量、`upstreams.json` 与 lockfile。
3. 组合缓存按内容哈希分目录存放，覆盖产品代码与依赖指纹；`content/` 目录由运行时直接读取。
4. `composition.json` 保存可复用的模块组合，每次进程的 Token、端口与 ready 回调路径放在独立的 include 文件中。

## 3. 产品扩展层职责

产品扩展层通过 `heron-ai/index.mjs` 统一装配模型渠道、工作区、模板与产品设置；业务扩展包提供具体内容，宿主提供运行环境事实，组合层据此生成最终产品。

- **模型目录与执行分离**：模型目录描述可用模型与能力，客户端管理本地凭据、偏好与路由；外部插件可贡献自定义目录和传输实现（公共版不预置团队服务，规则见 [Provider 目录](../guides/provider-catalog.md)）。
- **统一会话循环**：所有会话统一使用 DSH 原生 Agent 循环、Skill 与 MCP；可选模型适配器只负责模型调用，不另建会话循环。模型能力以运行时目录与会话信息为准，不按模型名称硬编码推断。
- **插件生命周期由 DSH 托管**：DSH 负责 Agent/工具调度、取消、会话持久化与插件树销毁。扩展通过 `ctx.plugin()`、`ctx.on()`、`ctx.effect()` 注册子插件与资源，由 owner context 统一释放；`appReady` 提交后向宿主报告就绪，普通退出通过 stdin EOF 触发（见 [H4 退出协议](HOST-INTEGRATION.md#h4-退出协议)）。

## 4. 数据边界：运行包只读，状态全在 stateDir

| 位置 | 内容 |
| --- | --- |
| `<stateDir>/dsh/` | DSH 主目录：profile、会话记录、凭据 |
| `<stateDir>/dsh/session-configurations` | **草稿**配置（模板 / 模型 / 权限 / 工作区） |
| `<stateDir>/runtime/modules-<key>/` | 插件组合缓存 |
| `<stateDir>/content/` | 部署后的技能与模板 |
| 集成包指定的私有位置 | 外部身份与部署凭据（**严禁提交**） |

草稿配置与正式 Session 日志分开存储，仅在发送消息时才将配置事件写入正式日志。

- **旧版配置迁移**：旧数据根的对话导入已移除（早先导入的会话已是普通 DSH 会话）。`migration/config.mjs` 在首次启动时迁移旧版 Skills、MCP 与 OAuth 凭据（在无 `mcp-servers.json` 时用随包列表初始化），并记录完成标记于 `<stateDir>/dsh/migration/heron-ai-v1/`。迁移只读不删原文件，冲突配置另存为 `-legacy-<hash>`，写入完成标记后不再重复扫描。
- **受管 MCP 默认项**：可选内容来源可贡献连接配置，更新仅作用于仍受该来源管理的项，保留用户的启停选择与个人配置；公共版不包含团队服务器地址或凭据。
- **数据目录隔离**：数据目录与用户工程分开管理；启动时会自动清理历史版本误登记的数据目录工作区，同时保留聊天记录与文件。

## 5. 新功能的归属

- **公共运行时**：持有模型与原生 Agent、模板与技能注册、MCP 生命周期、工作区与宿主协议。
- **可选扩展包**：持有业务编排、业务 Skill、远程服务策略、自动化请求与产品更新（装配边界见 [扩展架构](extensions.md)）。

## 6. 构建与发行

- **产物与输入分离**：构建将源码与依赖组装为独立运行包，输出目录与源码输入严格隔离；`mirror` 仅写入已校验的输出范围，发行包以真实文件交付。
- **增量校验与构建回执**：Node 运行包记录组件输入与输出的内容摘要（Git 仅提供源码清单，实际字节决定是否复用，包含未提交文件）；仅在构建成功且输入未变时写入回执至 `.cache/components/`。外部插件须在构建时显式指定，缺少必需输入直接失败；Debug 包随附对应 PDB。
- **依赖装配与增量同步**：装配器先解析完整包路径与版本，再按发行规则过滤开发文件，并逐文件记录输入/输出哈希；构建时仅同步新增、缺失或内容变更的文件，保留嵌套 `node_modules` 以支持并存版本。详细同步记录写入 `.cache/dependency-assembly/`（不随产品交付），运行包中的 `.heron-ai-assembly.json` 仅保留组合缓存所需的指纹。
- **发布入口**：公共构建产出 `dist/app/AiHost`，供独立 App 与外部宿主共同使用；发布通过 `plan / build / verify` 三阶段校验，协议兼容范围由 `tools/release/protocol/` 维护。

## 7. 本地环境与验证

当前主要面向 Windows x64，Node 版本锁定在 `node-runtime.json`；本地依赖通过 junction 复用（需对应系统权限）。修改后需通过标准构建、`verify-payload` 及真实宿主界面渲染验证（命令见 `AGENTS.md`）。

## 8. 宿主集成与分层边界

```text
DSH 核心引擎 → common（产品核心）→ 业务包 / 宿主包（平级、互不引用）
```

- **宿主与扩展平级解耦**：业务包决定“面向哪个团队”，宿主包决定“嵌入哪个宿主”；移除这两层后，公共 App 仍可独立运行。
- **公共 Facade 与独立宿主适配**：公共 Facade 管理进程、WebView、就绪回执、退出与通用宿主控制；具体宿主适配器由接入方通过各自 SDK 独立编译、打包并接入公共运行时。远程登录、机器登记、中继与更新策略由对应插件和服务端独立提供，通过统一的原生会话、工作区与权限协议协作。
- **Profile 与工作区接入**：宿主实现由启用包的 `heron-ai.hostProfiles` 贡献，通用启动层负责校验与选择（`--config` 的 `aspects` 可覆盖默认标签，契约见 [HOST-INTEGRATION](HOST-INTEGRATION.md) H2.2、H5.1）。工作区源目录配置由通用层持有，通过 `sandboxPolicy.registerWorkspaceRoots()` 与 `workspaceRegistry.registerDirectories()` 接入核心引擎，不依赖宿主或业务包（见 [多目录工作区](../guides/multi-folder-workspaces.md)）。
