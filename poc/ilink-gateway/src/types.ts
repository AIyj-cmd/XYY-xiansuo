import { z } from 'zod'

export const pilotControlSchema = z.object({
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  authorizationId: z.string().uuid(),
  deliveryRequestId: z.string().uuid(),
  previousKeyHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict()

export const deliveryRequestSchema = z.object({
  deliveryId: z.string().uuid(),
  idempotencyKey: z.string().min(16).max(200),
  recipientUserId: z.number().int().positive(),
  /** Required only by the Hermes transport; OpenClaw keeps its published shape. */
  recipientBindingGeneration: z.number().int().positive().optional(),
  title: z.string().min(1).max(40),
  body: z.string().min(1).max(500),
  detailUrl: z.literal('https://xs.tomatopia.top/'),
  // Both values are HMAC-covered by the request body. GatewayService compares
  // them with its real timer before acquiring an idempotency lease.
  gatewaySendTimeoutMs: z.number().int().min(1_000).max(120_000),
  workerTimeoutMs: z.number().int().min(6_000).max(180_000),
  pilotControl: pilotControlSchema.optional()
}).strict()

export type ChannelDeliveryRequest = z.infer<typeof deliveryRequestSchema>
export type AdapterDeliveryRequest = { recipientExternalId: string; recipientUserId?: number; recipientBindingGeneration?: number; message: { title: string; body: string; detailUrl: string }; idempotencyKey: string }

export const deliveryStatusSchema = z.enum([
  'sent', 'deduplicated', 'retryable_failure', 'permanent_failure', 'result_unknown'
])
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>

export type ChannelDeliveryResult = {
  providerMessageId?: string
  status: DeliveryStatus
  errorCode?: string
  latencyMs?: number
}

export type GatewayHealthStatus = 'healthy' | 'degraded' | 'offline' | 'login_required' | 'restricted' | 'unsupported'

export type AdapterHealth = { status: GatewayHealthStatus; code?: string; sessionStatus?: 'authenticated' | 'login_required' | 'expired' | 'restricted' | 'unsupported' | 'unknown' | 'offline'; channelStatus?: 'enabled' | 'disabled' }

export interface ChannelAdapter {
  readonly name: 'fake' | 'ilink' | 'hermes'
  /** A Hermes CLI execution is never safe to retry once a key is acquired. */
  readonly attemptPolicy?: 'single_attempt'
  send(request: AdapterDeliveryRequest, signal: AbortSignal): Promise<ChannelDeliveryResult>
  health(): Promise<AdapterHealth>
}

export type ErrorDisposition = {
  retryable: boolean
  mayDuplicate: boolean
  level: 'warn' | 'error'
  requiresHuman: boolean
}

export const ERROR_DISPOSITIONS: Record<string, ErrorDisposition> = {
  ILINK_CHANNEL_DISABLED: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: false },
  ILINK_LIVE_DISABLED: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: true },
  ILINK_HERMES_DISABLED: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: false },
  ILINK_HERMES_SESSION_UNCHECKED: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: true },
  ILINK_GATEWAY_OFFLINE: { retryable: true, mayDuplicate: false, level: 'warn', requiresHuman: false },
  ILINK_SESSION_EXPIRED: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: true },
  ILINK_LOGIN_REQUIRED: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: true },
  ILINK_ACCOUNT_RESTRICTED: { retryable: false, mayDuplicate: false, level: 'error', requiresHuman: true },
  ILINK_RECIPIENT_NOT_CONFIGURED: { retryable: false, mayDuplicate: false, level: 'error', requiresHuman: true },
  ILINK_RECIPIENT_MISMATCH: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: false },
  ILINK_SYNTHETIC_MESSAGE_REQUIRED: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: false },
  ILINK_MESSAGE_POLICY_REJECTED: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: false },
  ILINK_DETAIL_URL_FORBIDDEN: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: false },
  ILINK_IDEMPOTENCY_CONFLICT: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: true },
  ILINK_MESSAGE_TOO_LONG: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: false },
  ILINK_SEND_TIMEOUT: { retryable: false, mayDuplicate: true, level: 'warn', requiresHuman: true },
  ILINK_SEND_RESULT_UNKNOWN: { retryable: false, mayDuplicate: true, level: 'error', requiresHuman: true },
  ILINK_RATE_LIMITED: { retryable: true, mayDuplicate: false, level: 'warn', requiresHuman: false },
  ILINK_RETRY_IN_PROGRESS: { retryable: true, mayDuplicate: false, level: 'warn', requiresHuman: false },
  ILINK_VERSION_UNSUPPORTED: { retryable: false, mayDuplicate: false, level: 'error', requiresHuman: true },
  ILINK_CAPABILITY_UNSUPPORTED: { retryable: false, mayDuplicate: false, level: 'error', requiresHuman: true },
  ILINK_SEND_CONTRACT_UNVERIFIED: { retryable: false, mayDuplicate: false, level: 'error', requiresHuman: true },
  ILINK_OPENCLAW_NOT_INSTALLED: { retryable: false, mayDuplicate: false, level: 'error', requiresHuman: true },
  ILINK_PLUGIN_NOT_INSTALLED: { retryable: false, mayDuplicate: false, level: 'error', requiresHuman: true },
  ILINK_OFFICIAL_LOGIN_FAILED: { retryable: false, mayDuplicate: false, level: 'error', requiresHuman: true },
  ILINK_PROVIDER_REJECTED: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: true },
  ILINK_DUPLICATE_SUPPRESSED: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: false },
  ILINK_SIGNATURE_INVALID: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: false },
  ILINK_REPLAY_REJECTED: { retryable: false, mayDuplicate: false, level: 'warn', requiresHuman: false },
  ILINK_INTERNAL_ERROR: { retryable: true, mayDuplicate: false, level: 'error', requiresHuman: true }
}
