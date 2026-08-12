import { registerNoReplyHook } from './policy.mjs'

// `definePluginEntry` is an SDK typing helper. The host accepts this native
// entry object directly, avoiding a runtime dependency outside OpenClaw.
export default {
  id: 'xiansuo-openclaw-no-reply',
  name: 'XYY OpenClaw 微信入站静默',
  description: '仅静默拦截 openclaw-weixin 入站回合。',
  register(api) {
    registerNoReplyHook(api)
  },
}
