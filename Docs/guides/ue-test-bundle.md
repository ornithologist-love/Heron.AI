---
type: guide
covers: [Facade/HeronAI.Facade, packages/common/runtime/src/heron-ai/host.mjs]
---

# 编辑器宿主接入

所有宿主消费已构建的 AI 载荷，通过薄适配器启动进程、承载就绪 URL 并管理生命周期。工作区、主题和宿主身份由接入方明确提供；公共产品不包含特定游戏工程的路径、构建规则或企业工具。

接入方提供匹配版本的 SDK 与宿主构建入口，沿用自己的编辑器编译工具链。AI 载荷仍从 Heron.AI 标准构建取得，不在编辑器工程里维护另一份产品实现。

先核对实际加载的载荷和版本，再验证工作区、主题、会话打开与正常退出。独立浏览器验证只能证明运行时服务，不能代替编辑器中的原生承载检查。协议和适配边界见[宿主契约](../architecture/HOST-INTEGRATION.md)。
