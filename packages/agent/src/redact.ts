/**
 * 从**一整段文本里**抹掉密钥长相的东西。
 *
 * 与 `providers/config.ts` 的 `redactSecret` 分工不同：那个抹的是"一个值"，
 * 这个抹的是"一段话里恰好夹着的那半截"。
 *
 * 用途是错误消息。`classifyHttpError` 会把服务端响应正文截 400 字塞进错误消息，
 * 而那条消息会进界面、进日志，还会随 `retry` 事件进 `.mcai` 的对话档案——
 * 而 `.mcai` 是拿来分享的。一个把整个请求（含 `Authorization` 头）回显在 4xx
 * 正文里的中转站，就能顺着这条路把密钥写进一个可分享的文件。
 *
 * 形态取自 `config.ts` 的 `LOOKS_LIKE_SECRET`（`sk-` / `Bearer ` / `eyJ` 开头），
 * 只是这里要在长文本里找，所以两边都放宽了边界。
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(?:sk-|sk_)[A-Za-z0-9._-]{8,}/g, '***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, 'Bearer ***')
    .replace(/\beyJ[A-Za-z0-9._-]{8,}/g, '***')
}
