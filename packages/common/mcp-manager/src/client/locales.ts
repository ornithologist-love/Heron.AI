/**
 * dsh-mcp-manager — locale dictionaries (zh / en).
 *
 * Registered under the `mcpManager` namespace through ctx.locale, following
 * the same pattern as DSH's own settings UI plugins.
 *
 * @module dsh-mcp-manager/client/locales
 */

export type LocaleKey =
  | 'oauthPopupBlocked'
  | 'oauthHttpsRequired'
  | 'oauthPopupClosed'
  | 'oauthStillWaiting'

  | 'nav'
  | 'skillsTab'
  | 'tabsLabel'
  | 'backToConnectors'
  | 'configure'
  | 'connectorConnect'
  | 'connectorConnected'
  | 'connectorWaiting'
  | 'connectorToggle'
  | 'loading'
  | 'loadFailed'
  | 'groupStatus'
  | 'connecting'
  | 'error'
  | 'disconnected'
  | 'reconnect'
  | 'refresh'
  | 'cancel'
  | 'disable'
  | 'retry'
  | 'timeoutMsg'
  | 'toggleFailed'
  | 'oauthRevokeBtn'
  | 'revokeFailed'
  | 'oauthCopyLink'
  | 'oauthLinkCopied'
  | 'subServices'
  | 'connectorTools'
  | 'connectorToolsCount'
  | 'searchTools'
  | 'noTools'
  | 'maintenance'
  | 'agentPluginImport'
  | 'agentPluginDirectory'
  | 'agentPluginBrowse'
  | 'agentPluginZip'
  | 'agentPluginZipInvalid'
  | 'agentPluginDiscover'
  | 'agentPluginDiscoveryEmpty'
  | 'agentPluginPreview'
  | 'agentPluginPreviewLoading'
  | 'agentPluginPreviewFailed'
  | 'agentPluginImportBack'
  | 'agentPluginImportMcp'
  | 'agentPluginStdioCommands'
  | 'agentPluginStdioConfirm'
  | 'agentPluginBrowseFailed'
  | 'agentPluginImportConfirm'
  | 'agentPluginImporting'
  | 'agentPluginImportFailed'
  | 'agentPluginSkills'
  | 'agentPluginSkillSource'
  | 'agentPluginManage'
  | 'agentPluginEnabled'
  | 'agentPluginDisabled'
  | 'agentPluginToggle'
  | 'agentPluginRemove'
  | 'agentPluginExport'
  | 'agentPluginExportFormat'
  | 'agentPluginExportDownload'
  | 'agentPluginExporting'
  | 'agentPluginExportFailed'
  | 'agentPluginChangeFailed'
  | 'customSectionTitle'
  | 'customEmpty'
  | 'customAdd'
  | 'customDelete'
  | 'customDeleteFailed'
  | 'customAddFailed'
  | 'customServerName'
  | 'customTransport'
  | 'customUrl'
  | 'customCommand'
  | 'customArgs'
  | 'customCwd'
  | 'customAuthType'
  | 'customAuthNone'
  | 'customAuthOAuth'
  | 'customSave'
  | 'customNameInvalid'
  | 'customUrlInvalid'
  | 'customCommandRequired'

/** Placeholders in template strings: `{n}`, `{name}` are replaced at render time. */
export const zh: Record<LocaleKey, string> = {
  oauthPopupBlocked: '授权窗口被拦截，请允许弹窗后重试。',
  oauthHttpsRequired: 'OAuth 授权地址必须使用 HTTPS。',
  oauthPopupClosed: '授权窗口已关闭，请重新发起授权。',
  oauthStillWaiting: '等待授权超时，完成登录后请刷新状态。',

  nav: '连接器',
  skillsTab: '技能',
  tabsLabel: '连接器页面选项卡',
  backToConnectors: '返回连接器',
  configure: '配置',
  connectorConnect: '连接',
  connectorConnected: '已连接',
  connectorWaiting: '等待授权',
  connectorToggle: '启用 {name}',
  loading: '加载中…',
  loadFailed: '无法加载连接器，请刷新。',
  groupStatus: '已连接 {n}/{total} 项',
  connecting: '连接中…',
  error: '连接异常',
  disconnected: '未连接',
  reconnect: '重新连接',
  refresh: '刷新',
  cancel: '取消',
  disable: '停用',
  retry: '重试',
  timeoutMsg: '连接超时（{n} 秒），可稍后刷新状态。',
  toggleFailed: '切换状态失败',
  oauthRevokeBtn: '清除授权',
  revokeFailed: '清除授权失败，请重试。',
  oauthCopyLink: '复制授权链接',
  oauthLinkCopied: '已复制授权链接',
  subServices: '包含服务',
  connectorTools: '可用工具',
  connectorToolsCount: '可用工具 ({n})',
  searchTools: '搜索工具…',
  noTools: '暂无已加载工具',
  maintenance: '连接管理',
  agentPluginImport: '导入 Agent Plugin',
  agentPluginDirectory: '本机目录或 ZIP 路径',
  agentPluginBrowse: '选择目录',
  agentPluginZip: '选择 ZIP',
  agentPluginZipInvalid: '请选择不超过 16 MiB 的 ZIP 文件。',
  agentPluginDiscover: '从本机发现',
  agentPluginDiscoveryEmpty: '未找到可导入的插件或配置。',
  agentPluginPreview: '预览',
  agentPluginPreviewLoading: '正在检查…',
  agentPluginPreviewFailed: '无法预览 Agent Plugin。',
  agentPluginImportBack: '返回',
  agentPluginImportMcp: 'MCP 服务（{n}）',
  agentPluginStdioCommands: '将在本机运行的命令',
  agentPluginStdioConfirm: '我确认允许插件运行以上命令。',
  agentPluginBrowseFailed: '无法打开目录选择器，可以直接输入路径。',
  agentPluginImportConfirm: '导入并启用',
  agentPluginImporting: '正在导入…',
  agentPluginImportFailed: '导入 Agent Plugin 失败。',
  agentPluginSkills: '附带技能（{n}）',
  agentPluginSkillSource: '来源 · {name}',
  agentPluginManage: '插件管理',
  agentPluginEnabled: '已启用',
  agentPluginDisabled: '已停用',
  agentPluginToggle: '启用插件 {name}',
  agentPluginRemove: '移除导入',
  agentPluginExport: '导出压缩包…',
  agentPluginExportFormat: '目标格式',
  agentPluginExportDownload: '下载 ZIP',
  agentPluginExporting: '正在导出…',
  agentPluginExportFailed: '无法导出 Agent Plugin。',
  agentPluginChangeFailed: '无法更新 Agent Plugin。',
  customSectionTitle: '自定义 MCP 服务',
  customEmpty: '暂未添加自定义 MCP 服务',
  customAdd: '添加服务',
  customDelete: '删除',
  customDeleteFailed: '删除服务失败，请重试。',
  customAddFailed: '添加服务失败，请检查配置。',
  customServerName: '服务标识',
  customTransport: '传输协议',
  customUrl: '服务地址 (URL)',
  customCommand: '启动命令',
  customArgs: '命令参数（空格分隔）',
  customCwd: '工作目录（可选）',
  customAuthType: '认证方式',
  customAuthNone: '无认证',
  customAuthOAuth: 'OAuth',
  customSave: '确认添加',
  customNameInvalid: '服务标识需为 1-32 位字母、数字、下划线或连字符。',
  customUrlInvalid: '请输入以 http:// 或 https:// 开头的服务地址。',
  customCommandRequired: '请输入启动命令。',
}

export const en: Record<LocaleKey, string> = {
  oauthPopupBlocked: 'Authorization popup was blocked. Allow popups and try again.',
  oauthHttpsRequired: 'OAuth authorization URL must use HTTPS.',
  oauthPopupClosed: 'Authorization window closed before completion.',
  oauthStillWaiting: 'Timed out waiting for authorization. Refresh after signing in.',

  nav: 'Connectors',
  skillsTab: 'Skills',
  tabsLabel: 'Connectors page tabs',
  backToConnectors: 'Back to Connectors',
  configure: 'Configure',
  connectorConnect: 'Connect',
  connectorConnected: 'Connected',
  connectorWaiting: 'Awaiting authorization',
  connectorToggle: 'Enable {name}',
  loading: 'Loading…',
  loadFailed: 'Could not load connectors. Try refreshing.',
  groupStatus: '{n} of {total} connected',
  connecting: 'Connecting…',
  error: 'Connection error',
  disconnected: 'Disconnected',
  reconnect: 'Reconnect',
  refresh: 'Refresh',
  cancel: 'Cancel',
  disable: 'Disable',
  retry: 'Retry',
  timeoutMsg: 'Connection timed out ({n}s). Refresh to check the latest status.',
  toggleFailed: 'Failed to update status',
  oauthRevokeBtn: 'Sign out / Revoke',
  revokeFailed: 'Could not revoke authorization. Try again.',
  oauthCopyLink: 'Copy authorization link',
  oauthLinkCopied: 'Authorization link copied',
  subServices: 'Services',
  connectorTools: 'Tools',
  connectorToolsCount: 'Tools ({n})',
  searchTools: 'Filter tools…',
  noTools: 'No tools loaded yet',
  maintenance: 'Maintenance',
  agentPluginImport: 'Import Agent Plugin',
  agentPluginDirectory: 'Local folder or ZIP path',
  agentPluginBrowse: 'Choose Folder',
  agentPluginZip: 'Choose ZIP',
  agentPluginZipInvalid: 'Choose a ZIP file up to 16 MiB.',
  agentPluginDiscover: 'Discover on this device',
  agentPluginDiscoveryEmpty: 'No importable plugins or settings found.',
  agentPluginPreview: 'Preview',
  agentPluginPreviewLoading: 'Checking…',
  agentPluginPreviewFailed: 'Could not preview the Agent Plugin.',
  agentPluginImportBack: 'Back',
  agentPluginImportMcp: 'MCP servers ({n})',
  agentPluginStdioCommands: 'Commands that will run on this device',
  agentPluginStdioConfirm: 'I allow this plugin to run the commands above.',
  agentPluginBrowseFailed: 'Could not open the folder picker. You can enter the path directly.',
  agentPluginImportConfirm: 'Import and Enable',
  agentPluginImporting: 'Importing…',
  agentPluginImportFailed: 'Could not import the Agent Plugin.',
  agentPluginSkills: 'Included Skills ({n})',
  agentPluginSkillSource: 'Source · {name}',
  agentPluginManage: 'Plugin Management',
  agentPluginEnabled: 'Enabled',
  agentPluginDisabled: 'Disabled',
  agentPluginToggle: 'Enable plugin {name}',
  agentPluginRemove: 'Remove Import',
  agentPluginExport: 'Export ZIP…',
  agentPluginExportFormat: 'Target format',
  agentPluginExportDownload: 'Download ZIP',
  agentPluginExporting: 'Exporting…',
  agentPluginExportFailed: 'Could not export the Agent Plugin.',
  agentPluginChangeFailed: 'Could not update the Agent Plugin.',
  customSectionTitle: 'Custom MCP Servers',
  customEmpty: 'No custom MCP servers configured',
  customAdd: 'Add Server',
  customDelete: 'Delete',
  customDeleteFailed: 'Failed to delete server. Try again.',
  customAddFailed: 'Failed to add server. Check the configuration.',
  customServerName: 'Server ID',
  customTransport: 'Transport',
  customUrl: 'Server URL',
  customCommand: 'Command',
  customArgs: 'Arguments (space-separated)',
  customCwd: 'Working directory (optional)',
  customAuthType: 'Authentication',
  customAuthNone: 'None',
  customAuthOAuth: 'OAuth',
  customSave: 'Add',
  customNameInvalid: 'Server ID must match 1-32 letters, numbers, underscores, or hyphens.',
  customUrlInvalid: 'Enter a URL starting with http:// or https://.',
  customCommandRequired: 'Enter a startup command.',
}

/** Render a template string, replacing `{name}` / `{n}` placeholders. */
export function fmt(template: string, params: Record<string, string | number>): string {
  let out = template
  for (const [key, value] of Object.entries(params)) {
    out = out.replaceAll(`{${key}}`, String(value))
  }
  return out
}
