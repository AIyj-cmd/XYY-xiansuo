export const OPENCLAW_WEIXIN_PROVIDER = 'openclaw-weixin'

/**
 * This policy deliberately ignores message content. A handled result without
 * reply is the documented OpenClaw silent short-circuit before any model call.
 */
export function noReplyDecision(context) {
  if (context?.messageProvider !== OPENCLAW_WEIXIN_PROVIDER) return undefined
  return { handled: true, reason: 'xiansuo_openclaw_weixin_inbound_disabled' }
}

export function registerNoReplyHook(api) {
  api.on('before_agent_reply', (_event, context) => noReplyDecision(context), { priority: 100 })
}
