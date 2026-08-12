import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

// scrypt is intentionally expensive.  Keep one process from turning an
// unauthenticated request burst into unbounded libuv memory/CPU work.
const SCRYPT_CONCURRENCY = 2;
const SCRYPT_QUEUE_LIMIT = 8;
let running = 0;
const waiters: Array<() => void> = [];

export class PasswordHashBusyError extends Error {
  constructor() { super('PASSWORD_HASH_BUSY'); }
}

async function withScryptSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= SCRYPT_CONCURRENCY) {
    if (waiters.length >= SCRYPT_QUEUE_LIMIT) throw new PasswordHashBusyError();
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  running += 1;
  try { return await work(); }
  finally {
    running -= 1;
    waiters.shift()?.();
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await withScryptSlot(async () => (await scryptAsync(password, salt, 64)) as Buffer);
  return `${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashHex] = stored.split('$');
  if (!salt || !hashHex) return false;
  const hash = await withScryptSlot(async () => (await scryptAsync(password, salt, 64)) as Buffer);
  const storedHash = Buffer.from(hashHex, 'hex');
  if (hash.length !== storedHash.length) return false;
  return timingSafeEqual(hash, storedHash);
}
