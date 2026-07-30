import { SignJWT, jwtVerify } from 'jose';
import { requireJwtSecret } from '../config.js';

const SECRET = new TextEncoder().encode(requireJwtSecret());

export interface JWTPayload {
  id: number;
  // 为兼容旧调用方保留这些可选字段；新签发 token 只包含 id，认证时也只使用 id。
  username?: string;
  name?: string;
  role?: string;
}

export async function signToken(payload: JWTPayload): Promise<string> {
  return new SignJWT({ id: payload.id })
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
  return { id: payload.id };
}
