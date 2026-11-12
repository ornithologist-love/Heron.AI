---
type: lesson
---

# Heron.AI 开发坑位

> 只收**踩过才知道**的：现象 → 为什么 → 怎么做。代码里一眼能看出来的不写。
> 编号 `K-0xx` 只追加，不改既有编号（外部文档会引用）。

## GIT

**K-001 子模块提交了，父仓没提交** — 固定版本只认父仓 gitlink，子模块分支只是本机状态。先子模块 commit，再 `git add packages/dsh` 提交指针。

**K-002 detached HEAD 上提交** — 提交"消失"。先 `git switch -c feature/<主题>` 再提交。

**K-009 DSH 升级做成 merge** — 曾导致冲突与定制散落：业务逻辑写进 DSH，升级时分不清哪些是通用修复、哪些是业务。DSH 里只允许不含业务的通用口子、修复与通用功能，一事一提交（规则见 [业务定制如何接入 DSH](dsh-customization.md)）；升级时把这些提交重放到新的官方版本上，上游已提供的口子直接丢弃，再完整构建。

## 构建与载荷

**K-041 MCP 页面 404 可能是初始化被遗留写锁阻塞** — 管理插件等待集成服务，集成服务又等待配置文件的写锁时，主进程仍可能报告 ready；界面能加载不代表管理接口已挂载。空写锁没有持有者 PID，不能按已退出进程自动接管。排查时先核对配置仍在、锁的时间与内容，并确认没有写入者；确认是遗留空锁后移除该锁、重启 AI，再验证管理接口及服务列表。不要删除连接配置或放宽通用锁的持有者校验来绕过故障。

**K-040 Public 报告 ready，仍可能混入个人预设** — 调度提示词与委派策略曾误放 common 并默认装配，在 Public 缺少相应模型目录时只留下插件激活告警。个人预设应连同依赖、默认行与路由策略一起移出 Public 和 Team 组合；通用预设派生机制继续公开。首启验收须同时核对插件激活警告和实际预设列表，不能只检查 ready。

**K-039 插件文件存在却报找不到 `file:///...` 模块** — 组合贡献可以使用 file URL，而 `createRequire().resolve()` 接受文件系统路径或包名，不接受 file URL。启动器将行名称交给 CommonJS 解析前，须先把 file URL 转成文件路径，再将解析结果交给原生 ESM 加载器。静态导入校验不会走到动态组合行；迁移入口后仍须在真实宿主中核对 ready。

**K-038 Debug 启动被文件监听拖慢** — 载荷、组合缓存与用户 profile 的 node_modules 会通过 junction 指向相同包；递归跟随它们会重复扫描依赖，并阻塞启动对监听器 ready 的等待。启动时枚举载荷包、生成包及 profile 已安装插件，将包根解析为真实路径并去重；包根单独监听，不再递归跟随链接或扫描包内 node_modules。profile 的配置仍由原生 HMR 监听，重组配置后补充新安装包的真实目录。Windows 路径须转成 `/` 后交给 glob；监听基准外的目录还要用绝对路径补充匹配，避免 `../` 段使 glob-star 排除项失效。缩小扫描范围不能用关闭 HMR 或跳过监听器就绪来代替。

**K-035 主聊天能用，原生 AI 节点却在创建会话时失败** — 自动化适配器曾在 `agent/created` 中调用旧 `tools.presentAs()`，DSH 改为执行器插件后，这条路径会抛 `presentAs is not a function`。自动化组合沿用 base 的 native 执行器，按 Agent 限制可见工具即可。JS 文件的构建和普通聊天启动都不会执行这条分支；升级后还须核对实际自动化入口的会话创建。

**K-037 Debug 已启用前端 HMR，后端却没有重载** — 后端 HMR 的 base 按 URL 解析，Windows 路径须转换为带结尾分隔符的 file URL。源码重载默认跳过 node_modules，包内运行代码还须启用已安装包的依赖遍历；否则可能收到变更并逐出模块，却没有找到需要重新启动的插件。Debug 的 ready 回执须等待 HMR 服务可用，不能仅依据配置开关报告成功。

**K-036 缓存命中正常，重编 Client 却报 Missing field `code`** — 父仓与 DSH 子仓的独立安装可以加载同版本的两份 tsdown；配置插件返回的原生 MagicString 对象无法通过另一份打包器的实例检查。编译器须从 DSH 配置所在仓解析，Web 构建也使用 Web 包自己的 Vite；版本号相同不能替代模块实例一致。

**K-032 esbuild 删除临时文件时 Access is denied** — 先核对 Windows 完整性级别，不能只看 DACL 或重装 Node。本机曾因工作区继承 Low 标签，使官方 esbuild.exe 以 Low（RID 4096）运行，而父 Node 是 High（12288）；普通 Temp 的有效完整性级别较高，esbuild 因此无法删除 Node 写入的临时输入。官方包哈希一致也会发生。用 `icacls <实际 esbuild.exe>` 和进程 Token 核对；仅在确认是可信构建工具后，用 `icacls <实际 esbuild.exe> /setintegritylevel M` 恢复该文件的 Medium 标签，再运行标准 `npm run build`。不递归修改工作区、磁盘或 Temp 的权限；依赖重装后若再次继承 Low，须重新核对。机制见 [Windows Mandatory Integrity Control](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)。

**K-003 改了代码但构建秒过、产物没变** — 依赖与 UI 都按内容指纹跳过。**新增一类输入时必须加进指纹列表**，否则永远不触发。怀疑时删 `.cache/*.source.json` 重跑。

**K-004 源码有文件，载荷里没有** — `removeOrphans` 会删掉不在 `keep` 集合里的 runtime 文件。**别手动往 `dist` 塞文件**，走 `assets/` 或 `content/`。

**K-005 `[ai-payload] 校验失败`** — `verify-payload` 沿静态 import 图检查引用能否解析到载荷文件。语法检查通过仍可能缺文件，按报错中的“被 X 引用”追到装配来源，修正构建输入或保留规则。

**K-006 组合缓存不重建 / 总是重建** — 缓存键**覆盖 `heron-ai/` 代码但跳过 `content/`**。改内容不触发重建是**故意的**；要重建就改代码或删 `<stateDir>/runtime/modules-<key>`。

**K-007 token/端口被复用到下一次启动** — 运行期值必须留在 `<pid>` include 里。新增字段时确认它没被写进 `composition.json`。

**K-008 `The pinned DSH runtime is required`** — `DSH_VERSION` 常量与实际安装版本不等。升级要同时改常量、`upstreams.json`、lockfile。

**K-010 改了 `forks.json` 校验不过** — `marker` 与产物哈希是绑定的，改 marker 就必须重编该 fork，否则 `heron-ai-fork.json` 对不上。

**K-015 无符号链接权限的机器构建失败** — 依赖靠 junction 复用。**别改成复制**，复制会让依赖变两份且违背"已安装包只读"。

**K-014 替换 `dist/heron.ai` 报 EPERM/EBUSY** — 宿主正占用它。脚本有重试但别指望，**先关掉占用它的进程**。

**K-026 DSH 源码恢复后，产物仍是改动中的版本** — 旧源码增量构建只看修改时间，曾把残留的中间产物装入载荷。现在 DSH 不参与日常编译；官方产物准备按固定 tarball 完整性及文件哈希校验，恢复缺失或变动的生成目录。不要再通过 touch、手动复制 lib 或调用 DSH 编译解决；先核对 `config/dsh-artifacts.lock.json`，再运行 `npm run dsh:prepare`。

**K-027 产品自有的 DSH 插件类型扩充不生效** — 放在 DSH 子模块外、由 `scripts/dsh-build` 以 `owner: "heron-ai"` 编译的产品自有包，若 tsconfig 沿用 `preserveSymlinks: true`，同一个 `@deepseek-ai/*` 包会经不同链接路径解析成两份模块，`declare module` 扩充（如会话投影 `agentPreset`）落不到使用处。这类包的 tsconfig 用 `preserveSymlinks: false`。

**K-028 薄替换构建通过，启动却找不到常量枚举导出** — 从上游 `src/*` 直接引用的辅助文件由打包器转译，可能保留本应由 TypeScript 内联的跨包 `const enum` 访问。预设目录辅助文件的 `FiberState.ACTIVE` 就会变成对 Cordis 不存在的运行时导出的引用。将需要内联的辅助文件纳入薄替换的 TypeScript 编译，并登记上游来源；完整构建后仍须启动实际产物验证。

**K-023 运行时 ready，但 WebView 瞬间加载失败** — 系统自动分配端口也可能得到 Chromium 禁用的端口（如 6667），后端 HTTP 正常而浏览器报 `ERR_UNSAFE_PORT`。产品自动选端口限定动态高位范围，不通过放宽浏览器限制解决；显式 `--port` 仍由调用者选择。

**K-031 Debug 多次重启后，AI 页面返回 HTTP 431** — Cookie 按主机而非端口发送。DSH 为各随机端口保存的 `dsh-auth-*` 会一起发往 `127.0.0.1`；长期共用 WebView2 profile 会使请求头超过 Node 限制。Windows facade 在带鉴权 URL 导航前，通过 CookieManager 撤下已无监听端口对应的旧 AI Cookie，保留当前端口、其他仍监听的端口及无关 Cookie。排障记录原生 `WebErrorStatus`、HTTP 状态、清理数量与请求头字节数，不记录 Cookie 值或鉴权 URL；不要用清空 profile、会话数据或放宽请求头限制解决。

**K-033 补丁改到的 DSH 包编译报 `Cannot find module '@deepseek-ai/dsh-...'`** — 上游个别包 import 了 package.json 没声明的包（如 `tool-workflow` 引用 `dsh-util-values`），在 DSH 自己的 pnpm 工作区里靠依赖提升能编过；补丁构建单独编译该包，只能解析声明过的依赖，就会失败。补上声明（package.json 依赖与 tsconfig 引用）作为独立的一个补丁提交，不要为绕过它撤掉功能改动。experimental 包在补丁构建里同样可能缺依赖，产品不加载的包尽量不碰。

**K-034 在 Git Bash 里 `npm run build` 报 `tar (child): Cannot connect to E: resolve failed`** — Git Bash 的 PATH 先找到 GNU tar，它把 `E:\...` 里的盘符当成远程主机名。在 PowerShell 或 cmd 里运行构建，使用 Windows 自带的 tar。

**K-022 业务包内容改完组合没变** — `compose()` 与 persona 已移出 `heron-ai/`，缓存键靠载荷 `.heron-ai-assembly.json` 兜住。新增业务包输入却没进依赖装配时，缓存会误命中；改业务包后仍看到旧结果，删 `<stateDir>/runtime/modules-<key>`。

## 数据与兼容

**K-039 MCP 前置校验通过，周报拉取仍超时** — 授权和握手成功不能保证之后每个读取请求都成功。错误须保留具体方法与耗时，传输层只对明确的只读方法有限重试，避免给写入结果不明的请求叠加隐式重发。SSE 收到对应请求的完整回执即可结束读取，不能等待服务端关闭长连接；通知和进度事件不等于请求回执。

**K-011 会话格式被当普通数据改** — 会话日志的**已发布**代际由 DSH 的 `dsh-session-format-*` 包守护，产品不另写转换器。草稿配置与正式日志分开存，草稿绝不写进日志格式。

**K-012 拿真实数据目录调试** — `stateDir` 默认是 `~/.heronAi`。一律 `--state-dir <临时目录>`；验证数据、认证 URL、`tof_identity.json` 都不提交。

**K-013 数据目录出现在工作区列表里** — 历史启动路径的残留，`host.mjs` 每轮启动自愈删除。**不要"优化"掉这段，也不要顺手删聊天记录。**

**K-017 凭据进了日志** — `main.mjs` 的脱敏正则只是兜底，不是许可。

**K-019 重命名后设置或密钥失效** — 一些 fl/heronAi 标识参与 profile 匹配或凭据解密，目录迁移仍需沿用。典型例子是生图命名空间与 DPAPI 熵：改名会让已存设置失配或密钥无法解开。对应关系见 [扩展架构 §5](extensions.md#5-稳定标识)。
**K-021 宿主工作区改动只改一半** — 页面桥接（`readWorkspaces`）已删除且**无兼容期**。只改 C# 适配器或只改 Node 载荷，快速启动工作区都不会出现；两者必须联合发布。

**K-024 第二个能力技能挂载消失** — `@common/capabilities/skills` 同时接入知识发现观察者，而观察者只接受一个来源。重复挂载会在 `apply` 中失败。当前唯一来源是 P4 编辑器桥的 FL 技能；其他目录需要过滤时，使用 `FileSystemSkillProvider` 与 `delegateSkillProvider`。排查时核对实际目录或精确目录条目，模型概括可能漏项。

**K-025 拦截服务后状态停在“连接中”** — `dsh-mcp-manager` 在连接的 `try` 之外调用 `transformEntry`，在这里抛错无法进入正常错误状态。保留端点使用 `isAvailable` 策略处理，在加载、连接和授权之前决定条目是否可用。

## 文档与验证

**K-016 启用了运行时 HMR，修改源码却没有变化** — Debug 宿主的 HMR 消费运行载荷及插件产物，不能代替 TS/TSX/Vue 编译，也不会自动同步业务源码副本。`dev ai-chat` 负责构建并启动独立 App；common UI 的 Vite 入口与宿主门控见 [HOST-INTEGRATION H6.1](HOST-INTEGRATION.md#h61-开发入口)。验收以真实宿主中的产物更新与重载为准。

**K-018 依赖装两套** — 只用根 `pnpm-lock.yaml` + `--frozen-lockfile`。不跑 `npm install`/`npm ci`，不覆盖 `node_modules` 里的 SDK。

**K-020 文档混着旧路线与新结论** — 架构正文按最终实现更新，执行结果和证据收进 `.work`。交接清单写当前状态、版本和入口，过时建议用新结论替换；读者应能直接判断现在怎么维护。写作约定见工作区 `Docs/DOC-GOVERNANCE.md`。

**K-029 删依赖后 `pnpm install --lockfile-only` 重排整份锁文件，还把 `@common/workspace` 链到仓库根** — 根 `package.json` 的包名也是 `@common/workspace`，与 `packages/common/workspace` 同名；重新解析时 pnpm 会把这个依赖解析成根项目自身（`link:`、`link:../..`），构建随即报 `Dependency is not a local workspace`，组装缓存还会粘住坏链接。同时 pnpm 会重排各 importer 的键序，产生上千行无关 diff。删除工作区依赖时直接从锁文件里删掉对应条目和 importer 块，再用 `pnpm install --frozen-lockfile` 验证；不要用 `--lockfile-only` 重新生成。

## 子代理协作

**K-030 一个子代理跑了 30–45 分钟、烧掉近亿 token，实际命令只占几十秒** — 子代理每一步都把整段上下文重发一遍，耗时与 token 随"上下文大小 × 步数"增长；单包 tsc、vitest、lint 都只要几秒，完整构建约 1 分钟。上下文膨胀来自任务说明本身：一次塞进 README 核对、写测试、补覆盖率几件事；把"覆盖率 100% + 失败就修"放进循环却没有收敛条件，最后剩下的防御分支补不完；整包测试的逐用例输出与全量覆盖率表留在上下文里；长文件被反复整篇读入。主会话的价值是拆解与验收，子代理的价值是把单件琐事快速做完交回来，让人不用守在流程里。派活时：
- **一次一件事**，写明结束条件（例如"某包测试全过即结束"），README 核对、写测试、补覆盖率分开派；子代理很便宜，宁可多派几个。
- **验证只留摘要**：vitest 用 `--reporter=dot`，再用 `Select-String` 只取 `Test Files`、`Tests` 与失败行；覆盖率用 `json-summary` 只看改过的文件。
- **覆盖率最后看一次**，如实汇报未覆盖的行，补不补由主会话决定；需要补时写明"最多补 2 轮"。见 [测试与覆盖率](dsh-customization.md#测试与覆盖率)。
- **给读取范围**：写清读哪个文件的哪几行，或先 grep 定位，不整篇读长文件。
- **限制回合**：写明"最多 N 次工具调用，到了就汇报现状"。
- **禁止项写死且逐条复核**：子代理曾用 `--lockfile-only` 重排锁文件（K-029）、漏写新行为测试、在测试里写 `as unknown`、违规 `git checkout`。提交只由主会话做，提交后核对 `git diff --cached --stat`。
