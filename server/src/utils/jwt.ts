import { SignJWT, jwtVerify } from 'jose';
import { requireJwtSecret } from '../config.js';

const SECRET = new TextEncoder().encode(requireJwtSecret());

export interface JWTPayload {
  id: number;
  tokenVersion?: number;
  // 为兼容旧调用方保留这些可选字段；认证只信任 id 与 tokenVersion，
  // 用户展示信息和角色始终从数据库实时加载。
  username?: string;
  name?: string;
  role?: string;
}

export async function signToken(payload: JWTPayload): Promise<string> {
  return new SignJWT({ id: payload.id, token_version: payload.tokenVersion ?? 0 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(SECRET);
}

export async function verifyToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, SECRET);
  if (typeof payload.id !== 'number' || !Number.isSafeInteger(payload.id) || payload.id < 1) {
    throw new Error('JWT 缺少有效用户标识');
  }
  // Tokens issued before migration 010 have no token_version and remain valid
  // at version 0 until that account changes its password.
  const tokenVersion = payload.token_version === undefined ? 0 : payload.token_version;
  if (typeof tokenVersion !== 'number' || !Number.isSafeInteger(tokenVersion) || tokenVersion < 0) {
    throw new Error('JWT 缺少有效令牌版本');
  }
  return { id: payload.id, tokenVersion };
}
