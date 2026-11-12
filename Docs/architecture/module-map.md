---
type: architecture
covers: [packages/common, Facade]
---

# 客户端模块地图

宿主只负责承载与生命周期，通用运行时统一管理会话、模型和插件。私有能力通过扩展参与组合，不成为公共代码的默认依赖。图源在同目录 module-map.mmd，公开交付直接使用可编辑 Mermaid。

~~~mermaid
flowchart TB
  Host[其他宿主] --> Adapter[薄适配器与公开 SDK]
  Adapter --> Runtime[Heron.AI 本地运行时]
  Runtime --> DSH[DSH 图与 Agent 底座]
  Runtime --> Common[通用界面与插件服务]
  Runtime --> Optional[显式安装的可选插件]
  Common --> MCP[MCP 与 Skills 管理]
  Common --> Workspaces[工作区与会话]
  Optional --> Private[私有身份、业务及数据功能]
~~~
