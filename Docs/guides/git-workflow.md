---
type: guide
---

# Git 子模块工作流

Heron.AI 的 master 保存产品实现、组合与四个子模块指针。固定版本只认父仓 gitlink；初始化见 [本地开发指南](../../DEVELOPMENT.md)。首次检出子模块处于 detached HEAD 是正常状态，不在其上留下未命名提交。

| 子模块 | 来源与维护方式 |
| --- | --- |
| packages/dsh | 官方 DeepSeek Harness 为基线，可叠加不含业务的通用口子、修复与通用功能（规则见 [业务定制如何接入 DSH](../architecture/dsh-customization.md)） |
| packages/community/dsh-mcp-manager | 社区插件的 GitHub 公开 fork（`master`），可直接改源码，不要求提上游（见 [社区子模块](../architecture/dsh-customization.md#社区子模块)） |
| packages/community/dsh-skill-manager | 社区插件的 GitHub 公开 fork（`master`），可直接改源码，不要求提上游 |
| packages/community/dsh-better-sidebar | 第三个社区插件；直接固定官方 Tag，不维护 fork |

产品行为在 Heron.AI 的 common、业务或宿主包中修改；DSH 源码只接受不含业务的通用口子、修复与通用功能，产物不接受任何改写。补丁提交存 GitHub fork。DSH 升级先按下文"DSH 分支模型"在 fork 上准备新开发线，将子模块切到新开发线的提交，同步 config/upstreams.json，再运行 npm run dsh:lock 更新官方预编译产物锁，审查官方版本和完整性；同步依赖清单与根锁文件后，仅用 pnpm install --frozen-lockfile 安装，运行 npm run build 完整构建与对应运行验证；最后提交产品适配及 gitlink。旧的 fork 分支和点修标签可以保留供历史追溯，运行与构建不依赖它们。

## DSH 分支模型

DSH fork 为 `github.com/ornithologist-love/deepseek-harness`，配置为 `origin`；分支各有固定职责：

| 引用 | 职责 | 规则 |
| --- | --- | --- |
| `upstream/dsh-v<版本>` 分支 | 基线 | 指向官方 Tag `dsh-v<版本>` 的提交（Tag 同步到 fork），只读，永不提交或移动 |
| `feature/dsh-v<版本>` | 开发线兼交付线，Heron.AI gitlink 取自这里 | 从基线 Tag 开出，通用口子、修复与通用功能逐个提交在这里；每个提交只做一件事、不含业务，提交说明只写标题与几行要点，不写 `Upstream-PR` 等尾注 |
| `archive/<版本>/<日期>` Tag | 归档 | 改写已推送的开发线前给旧 tip 打 Tag |

归档 Tag 的原因：Heron.AI 按提交固定 DSH，旧提交一旦不在任何分支或 Tag 上，对应版本的 Heron.AI 就无法再检出。失去可取引用的提交会让历史版本无法恢复。开发线平时只追加提交；确需改写时先打归档 Tag，再更新分支，最后提交父仓 gitlink。


**升级到新的官方 Tag**：

1. 从 `upstream` 拉取新 Tag，推到 fork，并在该 Tag 上建 `upstream/dsh-v<新版本>` 基线分支。
2. 从基线开 `feature/dsh-v<新版本>`，按顺序 cherry-pick 旧开发线 `<旧Tag>..feature/dsh-v<旧版本>` 的提交；上游已合入的口子跳过，冲突就地解决。
3. 用 `git range-diff <旧Tag>..feature/dsh-v<旧版本> <新Tag>..feature/dsh-v<新版本>` 逐个核对：哪些搬过来、哪些丢弃、哪些改过。
4. 经用户授权后推送基线与新开发线到 fork。
5. 父仓同步 gitlink 与 `config/upstreams.json`（记录官方基线 Tag 与提交），按上文完成依赖、构建与验证后提交。

旧开发线保留，不删除。

MCP 与技能管理器的改动直接提交在社区子模块，先提交子模块，再提交父仓指针；产品名与产品专用取值经配置传入，不硬编码。复制文件与基准的维护规则见 [业务定制如何接入 DSH](../architecture/dsh-customization.md)。不新增或执行测试，不复制产物覆盖已安装 SDK。

## BSB 官方版本

BSB 子模块直接指向官方仓库 `github.com/omdsh-dev/DSH-better-sidebar`，固定在官方 Tag 的提交上，不做本地提交；`origin` 与 `upstream` 都只读。

**升级到新的官方 Tag**：子模块检出新 Tag；同步两份 `forks.json` 中 BSB 的 `version` 与 `upstreamCommit`，以及 `config/upstreams.json` 的 Tag 与提交；官方新增构建前置步骤时写进 `prepareScripts`，产物文件变化时更新 `artifacts`；再按上文完成依赖、构建与运行验证后提交父仓。

.gitmodules 记录克隆地址，config/upstreams.json 记录官方/社区来源、上游基准及许可证路径。DSH 从 GitHub fork `github.com/ornithologist-love/deepseek-harness` 克隆，BSB 从官方仓库克隆，MCP 与技能管理器从 GitHub fork `github.com/ornithologist-love/dsh-mcp-manager`、`dsh-skill-manager` 克隆（`master`，公开仓）；官方仓库只作只读 `upstream` 拉取新版本。未经用户授权不推送；维护提交须先确认远端可取，再交付父仓指针。
