export const REALTIME_ENGINE_PROTOCOL = 4;
export const REALTIME_TRANSPORT = "polling";

export const REALTIME_PING_INTERVAL_MS = 25_000;
export const REALTIME_PING_TIMEOUT_MS = 20_000;
export const REALTIME_MAX_PAYLOAD_BYTES = 1_000_000;

export const REALTIME_MAX_SESSIONS_PER_TENANT = 256;
export const REALTIME_MAX_QUEUE_PACKETS = 128;
export const REALTIME_MAX_QUEUE_BYTES = REALTIME_MAX_PAYLOAD_BYTES;
export const REALTIME_CLEANUP_BATCH = 32;

// A poll normally completes when the next server ping is due. The extra
// allowance prevents a scheduler delay from looking like a concurrent poll.
export const REALTIME_POLL_LEASE_MS =
  REALTIME_PING_INTERVAL_MS + 5_000;
export const REALTIME_POST_LEASE_MS = 15_000;

