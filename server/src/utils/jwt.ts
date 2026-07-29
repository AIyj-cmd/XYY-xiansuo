import { SignJWT, jwtVerify } from 'jose';

const secretEnv = process.env.JWT_SECRET;
if (!secretEnv) {
  throw new Error('JWT_SECRET 环境变量未设置，拒绝启动（不允许使用不安全的默认密钥）');
}
const SECRET = new TextEncoder().encode(secretEnv);

export interface JWTPayload {
  id: number;
  username: string;
  name: string;
  role: string;
}

export async function signToken(payload: JWTPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(SECRET);
}

export async function verifyToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, SECRET);
  return payload as unknown as JWTPayload;
}
