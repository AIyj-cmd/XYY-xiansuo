/**
 * H5 只能在构建时读取 VITE_* 配置，不能安全地从 API 请求机器人会话、
 * 登录二维码或凭据。这里仅接受部署方已经核验过的公开长期联系人入口。
 */
function publicHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export const hermesBotEntry = {
  // 两项均为可公开的静态入口，不得填写登录二维码、token、peer 或会话信息。
  url: publicHttpUrl(import.meta.env.VITE_HERMES_BOT_ENTRY_URL),
  imageUrl: publicHttpUrl(import.meta.env.VITE_HERMES_BOT_ENTRY_IMAGE_URL),
};
