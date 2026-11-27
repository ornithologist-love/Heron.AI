# Google Connector

可选的 Heron.AI 插件。从左侧导航打开 **连接器 → Google Suite**，在详情中分别启停 Drive、Docs、Sheets、Slides、Calendar 和 Gmail，展开各服务的工具列表查看工具。Drive 和 Docs 默认启用，新增服务由用户开启。Sheets、Slides、Calendar 和 Gmail 提供读取与查找工具。

点击「连接 Google」用默认浏览器授权，或点「复制授权链接」到自己的浏览器打开。浏览器提示已连接后，设置页自动更新连接状态。

发行方可通过 `HERON_GOOGLE_CONNECTOR_CLIENT_FILE` 给宿主预置 Google Desktop OAuth 客户端。该环境变量指向 Google Cloud 下载的桌面应用客户端 JSON 的绝对路径。个人安装可以在设置页导入客户端。启用新服务后，可选择「更新 Google 授权」，一次申请当前启用的服务所需权限。Google Cloud 项目需启用对应 API。 [Google 桌面应用 OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)

插件直接使用 Google Workspace REST API，可以在 Windows、macOS 和 Linux 上使用。会话通过 `search_mcp_tools` 按需发现工具，也可调用随插件提供的 Skill，例如 `/google-sheets`。Docs 的替换支持只读预览，写入由当前会话审批。

插件支持本地路径安装，也可由发行方在组合清单中显式选包。授权、工具和会话的边界见 [扩展架构](../../../Docs/architecture/extensions.md#google-connector)。
