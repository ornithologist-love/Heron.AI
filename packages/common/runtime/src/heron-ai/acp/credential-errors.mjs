// Only inspect backend failures, never assistant text or tool/MCP output.
export function isCredentialFailure(error) {
  const text = String(error?.message ?? error ?? '')
  return /\b401\b|unauthori[sz]ed|authentication (?:failed|required)|(?:invalid|expired|missing|incorrect|revoked)\s+(?:api[ _-]?key|access[ _-]?token|token|credential)|(?:api[ _-]?key|access[ _-]?token|token|credential).{0,30}(?:invalid|expired|missing|incorrect|revoked)|configure an api key|缺少本地凭据|(?:Token|令牌|凭据|密钥).{0,12}(?:无效|失效|过期|错误|缺失)|(?:认证|鉴权)(?:失败|错误)/i.test(text)
}
