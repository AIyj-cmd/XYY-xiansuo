import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_HEADERS = {
  timestamp: 'x-ilink-gateway-timestamp', nonce: 'x-ilink-gateway-nonce', signature: 'x-ilink-gateway-signature'
} as const

export function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
export function canonicalRequest(method: string, path: string, timestamp: string, nonce: string, bodySha256: string): string {
  return [method.toUpperCase(), path, timestamp, nonce, bodySha256].join('\n')
}
export function sign(secret: string, canonical: string): string { return createHmac('sha256', secret).update(canonical).digest('hex') }
export function verifySignature(signature: string, canonical: string, secrets: readonly string[]): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false
  const received = Buffer.from(signature, 'hex')
  return secrets.some((secret) => {
    const expected = Buffer.from(sign(secret, canonical), 'hex')
    return expected.length === received.length && timingSafeEqual(expected, received)
  })
}
export function freshNonce(): string { return randomBytes(24).toString('base64url') }
