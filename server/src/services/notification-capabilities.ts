export const NOTIFICATION_CHANNELS = ['mock', 'openclaw', 'hermes'] as const;
export type SupportedNotificationChannel = typeof NOTIFICATION_CHANNELS[number];

// This is the sole event × channel capability table. Runtime switches decide
// whether a supported channel is currently enabled; they never expand this
// product contract.
export const NOTIFICATION_EVENT_CHANNEL_CAPABILITIES = {
  owner_changed: ['mock', 'openclaw', 'hermes'],
  scheduled_follow_overdue: ['mock', 'openclaw'],
  visit_reminder: [],
  status_changed: [],
  daily_report: ['mock', 'openclaw'],
  weekly_report: [],
  inactive_lead: [],
} as const satisfies Record<string, readonly SupportedNotificationChannel[]>;

export function isSupportedNotificationChannel(value: unknown): value is SupportedNotificationChannel {
  return typeof value === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

export function isNotificationEventChannelSupported(eventType: string, channel: unknown): channel is SupportedNotificationChannel {
  const supported: readonly SupportedNotificationChannel[] = NOTIFICATION_EVENT_CHANNEL_CAPABILITIES[eventType as keyof typeof NOTIFICATION_EVENT_CHANNEL_CAPABILITIES] ?? [];
  return isSupportedNotificationChannel(channel) && supported.includes(channel);
}
