---
type: guide
covers: [config/upstreams.json, config/dsh-artifacts.lock.json, scripts/dsh-artifacts.mjs, node-runtime.json]
---

# 依赖来源与固定版本

首次拉取使用 `--recurse-submodules`，已有 checkout 执行 `git submodule update --init --recursive`。完整步骤见 [本地部署指南](../../DEVELOPMENT.md)。

| 子模块 | GitHub 上游 | 当前上游基线 |
| --- | --- | --- |
| `packages/dsh` | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`，`dsh-v0.2.2-rc.1` |
| `packages/community/dsh-mcp-manager` | [MCP Manager](https://github.com/Nichts0v0/dsh-mcp-manager) | `335f797c30b9c3880d997c27343c609c8019f040` |
| `packages/community/dsh-skill-manager` | [Skill Manager](https://github.com/AKS1st/dsh-skill-manager) | `fb452031031ea50a3287292d22b54e765d1039dc` |
| `packages/community/dsh-better-sidebar` | [Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | `0b6293f05145d6852428a05035d5ea0f370992be`，`v0.30.1` |

父仓 Gitlink 固定实际提交；DSH 在表中的官方提交上叠加通用口子、修复与通用功能，表中记录官方基线；补丁改到的包从源码编译，其余包用官方预编译产物，MCP 与技能管理器是公开 fork，可直接改源码；BSB 固定官方 Tag，源码构建保留其懒加载包。`config/upstreams.json` 记录上游来源和许可证；分支、Tag 和历史直接在各子模块查看。

产品依赖由根 `pnpm-workspace.yaml` 和 `pnpm-lock.yaml` 固定。DSH 源码子模块保留固定版本，供类型分析、内容和许可证读取；JS、类型声明、Web 与原生预编译文件由官方 npm 发布包提供。标准 `npm run build` 编译补丁涉及的 DSH 包、社区插件和产品组件；补丁涉及静态前端库时同时重建 Web 壳，其余包使用官方预编译产物，不调用原生构建。运行目录的 `package-lock.json` 是发行清单，不是开发依赖的根 lockfile。

`config/dsh-artifacts.lock.json` 固定官方 npm 包的名称、版本、下载地址与 SHA-512，同时绑定官方源码版本。`scripts/dsh-artifacts.mjs` 在首次使用时下载并验证 tarball，把包缓存到 `.cache/dsh-artifacts/`，只在源码包的未跟踪生成目录 `lib/`、`dist/`、原生平台 `bin/` 准备未修改的官方文件。源码、清单、已安装依赖及其他任务的受跟踪文件不被替换。每次构建按官方文件清单和哈希检查生成目录，缺失、变动或混入旧本地编译文件时从缓存恢复；缓存完整时不访问网络，也不回退源码编译。环境需要可执行的 `tar`。

首次构建会自动准备；离线开发前运行 `npm run dsh:prepare`。切换 DSH 版本后同步 gitlink 与 `config/upstreams.json`，运行 `npm run dsh:lock` 读取该版本的官方 npm 发布元数据，审查并提交新的产物锁，再准备、完整构建和验证。官方发布缺包或完整性不匹配会直接失败，不能用本地编译补齐。

DSH 的 `.gitmodules` 地址指向 GitHub fork `github.com/ornithologist-love/deepseek-harness`，BSB 直接指向官方仓库 `github.com/omdsh-dev/DSH-better-sidebar`，MCP 与技能管理器指向公开 fork；官方 GitHub 仓库只作只读来源。子模块的后续修改须先确认提交在对应远端可取，再交付父仓指针。运行包不依赖本机备份路径。

安装由根 `.pnpmfile.cjs` 仅撤下 DSH 源码根包的贡献者钩子安装步骤；依赖的原生生命周期仍保留。普通子模块的 Git 配置不满足上游钩子安装器的 worktree 前提，产品安装不为此迁移用户的 Git 配置，也不要求设置 CI。根构建清单包含补丁编译所需的 sidebar 包。补丁包的开发依赖按源码实际导入排序，避免激活关系或测试关系形成假环后丢掉类型依赖；补丁缓存同时绑定依赖锁，避免使用旧声明的编译结果。

Windows 构建进程将自身及子工具的临时目录放在 `.cache/tmp`，不修改系统环境。esbuild 的大块源码传输会先写临时文件；系统 Temp 出现“可创建但无法删除”时，Web 壳会在转译阶段失败，项目自己的构建缓存目录可以避免这一路径上的限制。

社区包的构建回执写在被忽略的生成目录，组装时再投影到载荷约定的位置。不能依赖开发机的 Git 排除配置来隐藏它：上游仓没有相应忽略项时，首次生成的根目录回执会被误认成新源码，使构建末尾的输入稳定性校验失败。
