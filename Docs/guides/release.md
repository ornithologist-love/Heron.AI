---
type: guide
covers: [tools/release/**, scripts/build.mjs, scripts/plugin-bundles.mjs, scripts/mcp-build-inputs.mjs]
external: [.heron-ai/build-secrets/]
---

# Heron.AI 载荷交付

本仓构建本地 AI 运行时与独立 App。具体宿主适配器、联合版本策略、更新索引和远程部署由发行方维护，公共产品不引用它们的源码。

普通 npm run build 生成公共载荷，不读取私有插件仓或团队口令。发行方可向构建和发布入口传入 --bundle-manifest，显式选择可选组件；清单版本为 1，目录相对各自声明它们的清单解析。extends 先继承再追加，所有清单参与内容指纹；重复组件、循环或超过八层继承会失败。逐目录的 --bundle-plugin 与清单方式不能混用。

只有选中的内容包声明凭据输入时，构建才读取对应环境变量或私有输入文件。发行方可在组合清单的 build.mcpSecretsFile 中选择文件：相对路径以声明它的清单为基准，~/ 相对当前用户目录，子清单可覆盖继承值。HERON_AI_MCP_SECRETS_FILE 优先于清单；两者都未声明时使用 .heron-ai/build-secrets/mcp.json。直接提供的 Token 环境变量优先于文件。

凭据归发行方管理，公共构建不探测外部发行方的数据目录。必需输入在修改载荷前完成校验，构建与发布指纹使用同一份解析结果；缺少输入立即失败，不生成只能显示而不能连接的默认配置。输入仅进入明确选择的组件副本，不写回源码或构建日志。

## 本地成品

在当前 checkout 使用正式发布入口：

~~~powershell
npm run release -- plan --version 2.3.0-preview.1 --editions user --distribution bundle
npm run release -- build --version 2.3.0-preview.1 --editions user --distribution bundle --node-dir <已校验的Node目录>
npm run release -- verify --version 2.3.0-preview.1
~~~

build 复用标准产品构建，加入固定 Node 与许可证，在发行暂存目录裁剪和校验依赖，随后生成 ZIP、清单与本地导入包。成品位于 dist/releases 下的不可变版本目录，同版本禁止覆盖；签名通过显式证书参数选择。操作不上传、不安装，也不改写用户状态。

清单是成品可见性的提交边界。Windows 文件监听可能阻止整目录改名，因此发布先复制并核对文件，最后原子提交清单。没有清单的中断目录不算已发布版本，完成前不会成为可消费成品。

## 依赖与协议

构建消费固定的 DSH 和社区源码组合，来源与版本见[依赖来源](dependencies.md)。根目录只保留一致的共享依赖；同版本也须核对实际清单和文件内容，内容不同不能通过删除副本掩盖。

发布协议与签名规则在 tools/release/protocol 中维护。消费者在自己的边界验证清单、兼容性和哈希，不依赖同仓类型身份。具体产品可以在此基础上实现自己的联合更新、安装回退和渠道策略。

部署方可以通过 `--product` 显式选择稳定的发布清单身份；默认是 `heron_ai`。该身份与载荷文件名、运行时目录和宿主品牌分开，改产品名称不必同时更改既有更新服务的协议。

旧宿主可能在安装新版之前，按固定目录校验或读取运行时。发行方可通过 `--runtime-alias` 在归档前保留一份兼容目录，其内容与当前运行时一致并纳入同一份大小及哈希清单；默认公共载荷不生成别名。只让新版验证器识别旧布局不能解决旧更新器安装新版的问题，交付仍须经过旧宿主的真实升级入口。
