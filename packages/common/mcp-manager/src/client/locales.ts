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
  | 'title'
  | 'intro'
  | 'loading'
  | 'empty'
  | 'connected'
  | 'connecting'
  | 'error'
  | 'offline'
  | 'disabled'
  | 'disconnected'
  | 'unknown'
  | 'offlineHint'
  | 'reconnect'
  | 'reconnecting'
  | 'edit'
  | 'enabledLabel'
  | 'disabledLabel'
  | 'addServer'
  | 'refresh'
  | 'addTitle'
  | 'editTitle'
  | 'backToList'
  | 'deleteServer'
  | 'deleteTitle'
  | 'confirmDelete'
  | 'deleting'
  | 'deleteHint'
  | 'fieldServerName'
  | 'fieldTransport'
  | 'fieldUrl'
  | 'fieldCommand'
  | 'fieldArgs'
  | 'fieldArgsPlaceholder'
  | 'fieldHeaders'
  | 'fieldTimeout'
  | 'timeoutHint'
  | 'cancel'
  | 'save'
  | 'addAndConnect'
  | 'savingBusy'
  | 'addingBusy'
  | 'invalidHeaders'
  | 'nameRequired'
  | 'urlRequired'
  | 'timeoutMsg'
  | 'addFailed'
  | 'updateFailed'
  | 'toggleFailed'
  | 'serverNameLocked'
  | 'advancedSettings'
  | 'tokenLabel'
  | 'tokenHint'
  | 'authType'
  | 'authTypeNone'
  | 'authTypeOAuth'
  | 'oauthStatus'
  | 'oauthAuthorized'
  | 'oauthNotAuthorized'
  | 'oauthAuthorizeBtn'
  | 'oauthAuthorizing'
  | 'oauthRevokeBtn'
  | 'oauthClientId'
  | 'oauthClientIdHint'
  | 'oauthScopes'
  | 'oauthScopesHint'
  | 'oauthExpiresAt'
  | 'oauthSuccessMsg'
  | 'oauthFailedMsg'

/** Placeholders in template strings: `{n}`, `{name}` are replaced at render time. */
export const zh: Record<LocaleKey, string> = {
  oauthPopupBlocked: '授权窗口被拦截，请允许弹窗后重试。',
  oauthHttpsRequired: 'OAuth 授权地址必须使用 HTTPS。',
  oauthPopupClosed: '授权窗口已关闭，请重新发起授权。',
  oauthStillWaiting: '等待授权超时，完成登录后请刷新状态。',

  nav: 'MCP',
  title: 'MCP 服务器',
  intro: '配置并管理 MCP 工具服务器，连接后可供所有会话使用。',
  loading: '加载中…',
  empty: '暂无 MCP 服务器',
  connected: '已连接 · {n} 个工具',
  connecting: '连接中…',
  error: '连接失败',
  offline: '离线',
  disabled: '已停用',
  disconnected: '未连接',
  unknown: '未知',
  offlineHint: '服务无响应，恢复后将自动重连。',
  reconnect: '重连',
  reconnecting: '重连中…',
  edit: '编辑',
  enabledLabel: '启用',
  disabledLabel: '停用',
  addServer: '添加服务器',
  refresh: '刷新',
  addTitle: '添加服务器',
  editTitle: '编辑 {name}',
  backToList: '返回',
  deleteServer: '删除',
  deleteTitle: '删除 {name}？',
  confirmDelete: '删除',
  deleting: '删除中…',
  deleteHint: '删除后将移除该服务器配置并卸载其工具，无法撤销。',
  fieldServerName: '名称',
  fieldTransport: '传输方式',
  fieldUrl: '服务地址',
  fieldCommand: '启动命令',
  fieldArgs: '参数',
  fieldArgsPlaceholder: '空格分隔，例如 --port 8080',
  fieldHeaders: '请求头（可选）',
  fieldTimeout: '连接超时（秒）',
  timeoutHint: '保存或重连时等待连接的最长时间。',
  cancel: '取消',
  save: '保存',
  addAndConnect: '添加',
  savingBusy: '保存中…',
  addingBusy: '添加中…',
  invalidHeaders: '请求头必须是有效的 JSON 对象。',
  nameRequired: '请输入服务器名称。',
  urlRequired: '请输入服务地址。',
  timeoutMsg: '连接超时（{n} 秒），可稍后刷新状态。',
  addFailed: '添加失败',
  updateFailed: '保存失败',
  toggleFailed: '切换状态失败',
  serverNameLocked: '名称创建后不可修改。',
  advancedSettings: '高级设置',
  tokenLabel: '接口访问令牌（可选）',
  tokenHint: '服务端开启鉴权时填写，留空则不携带令牌。',
  authType: '认证方式',
  authTypeNone: '无 / 自定义请求头',
  authTypeOAuth: 'OAuth 2.0',
  oauthStatus: '授权状态',
  oauthAuthorized: '已授权',
  oauthNotAuthorized: '未授权',
  oauthAuthorizeBtn: '前往授权',
  oauthAuthorizing: '等待授权…',
  oauthRevokeBtn: '清除授权',
  oauthClientId: 'Client ID（可选）',
  oauthClientIdHint: '留空则自动动态注册客户端。',
  oauthScopes: '权限范围（可选）',
  oauthScopesHint: '空格分隔，例如 read write。',
  oauthExpiresAt: '有效期至 {time}',
  oauthSuccessMsg: '授权成功，已连接。',
  oauthFailedMsg: '授权失败：{error}',
}

export const en: Record<LocaleKey, string> = {
  oauthPopupBlocked: 'Authorization popup was blocked. Allow popups and try again.',
  oauthHttpsRequired: 'OAuth authorization URL must use HTTPS.',
  oauthPopupClosed: 'Authorization window closed before completion.',
  oauthStillWaiting: 'Timed out waiting for authorization. Refresh after signing in.',

  nav: 'MCP',
  title: 'MCP Servers',
  intro: 'Configure MCP servers whose tools are available across sessions.',
  loading: 'Loading…',
  empty: 'No MCP servers configured.',
  connected: 'Connected · {n} tools',
  connecting: 'Connecting…',
  error: 'Connection failed',
  offline: 'Offline',
  disabled: 'Disabled',
  disconnected: 'Disconnected',
  unknown: 'Unknown',
  offlineHint: 'Server unreachable; will reconnect automatically when available.',
  reconnect: 'Reconnect',
  reconnecting: 'Reconnecting…',
  edit: 'Edit',
  enabledLabel: 'Enable',
  disabledLabel: 'Disable',
  addServer: 'Add server',
  refresh: 'Refresh',
  addTitle: 'Add server',
  editTitle: 'Edit {name}',
  backToList: 'Back',
  deleteServer: 'Delete',
  deleteTitle: 'Delete {name}?',
  confirmDelete: 'Delete',
  deleting: 'Deleting…',
  deleteHint: 'Removes this server configuration and unloads its tools. This cannot be undone.',
  fieldServerName: 'Name',
  fieldTransport: 'Transport',
  fieldUrl: 'Endpoint URL',
  fieldCommand: 'Command',
  fieldArgs: 'Arguments',
  fieldArgsPlaceholder: 'Space-separated, e.g. --port 8080',
  fieldHeaders: 'Headers (optional)',
  fieldTimeout: 'Connection timeout (s)',
  timeoutHint: 'Maximum time to wait for a connection after saving or reconnecting.',
  cancel: 'Cancel',
  save: 'Save',
  addAndConnect: 'Add',
  savingBusy: 'Saving…',
  addingBusy: 'Adding…',
  invalidHeaders: 'Headers must be a valid JSON object.',
  nameRequired: 'Enter a server name.',
  urlRequired: 'Enter an endpoint URL.',
  timeoutMsg: 'Connection timed out ({n}s). Refresh to check the latest status.',
  addFailed: 'Failed to add server',
  updateFailed: 'Failed to save server',
  toggleFailed: 'Failed to update status',
  serverNameLocked: 'Name cannot be changed after creation.',
  advancedSettings: 'Advanced settings',
  tokenLabel: 'API access token (optional)',
  tokenHint: 'Only needed when the MCP manager API requires a bearer token.',
  authType: 'Authentication',
  authTypeNone: 'None / Headers',
  authTypeOAuth: 'OAuth 2.0',
  oauthStatus: 'Authorization',
  oauthAuthorized: 'Authorized',
  oauthNotAuthorized: 'Not authorized',
  oauthAuthorizeBtn: 'Authorize',
  oauthAuthorizing: 'Authorizing…',
  oauthRevokeBtn: 'Revoke',
  oauthClientId: 'Client ID (optional)',
  oauthClientIdHint: 'Leave blank to use dynamic client registration.',
  oauthScopes: 'Scopes (optional)',
  oauthScopesHint: 'Space-separated, e.g. read write.',
  oauthExpiresAt: 'Expires {time}',
  oauthSuccessMsg: 'Authorized and connected.',
  oauthFailedMsg: 'Authorization failed: {error}',
}

/** Render a template string, replacing `{name}` / `{n}` placeholders. */
export function fmt(template: string, params: Record<string, string | number>): string {
  let out = template
  for (const [key, value] of Object.entries(params)) {
    out = out.replaceAll(`{${key}}`, String(value))
  }
  return out
}
