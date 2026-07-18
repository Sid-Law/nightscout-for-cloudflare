export const REALTIME_ENGINE_PROTOCOL = 4;
export const REALTIME_TRANSPORT = "polling";
export const REALTIME_WEBSOCKET_TRANSPORT = "websocket";
export type RealtimeTransport =
  | typeof REALTIME_TRANSPORT
  | typeof REALTIME_WEBSOCKET_TRANSPORT;

export const REALTIME_PING_INTERVAL_MS = 25_000;
export const REALTIME_PING_TIMEOUT_MS = 20_000;
export const REALTIME_MAX_PAYLOAD_BYTES = 1_000_000;

export const REALTIME_MAX_SESSIONS_PER_TENANT = 256;
export const REALTIME_MAX_QUEUE_PACKETS = 128;
export const REALTIME_MAX_QUEUE_BYTES = REALTIME_MAX_PAYLOAD_BYTES;
export const REALTIME_CLEANUP_BATCH = 32;
// Global per-invocation WebSocket delivery budget. Pending frames remain in
// SQLite until dequeued for one send attempt. There is an intentional
// at-most-once crash window between that durable dequeue and `WebSocket.send`;
// clients recover by reconnecting and requesting a fresh snapshot.
export const REALTIME_WEBSOCKET_FLUSH_MAX_SOCKETS = 16;
export const REALTIME_WEBSOCKET_FLUSH_MAX_FRAMES = 64;
export const REALTIME_WEBSOCKET_FLUSH_MAX_BYTES = REALTIME_MAX_PAYLOAD_BYTES;
// Duplicate hibernation tags may require several bounded close turns. Actual
// close failures use persisted exponential backoff so a broken socket cannot
// keep a Durable Object in a 10 Hz alarm loop.
export const REALTIME_WEBSOCKET_CLOSE_CONTINUATION_MS = 100;
export const REALTIME_WEBSOCKET_CLOSE_RETRY_BASE_MS = 1_000;
export const REALTIME_WEBSOCKET_CLOSE_RETRY_MAX_MS = 5 * 60_000;
// Leaves deterministic headroom for the Socket.IO event wrapper, optional
// websocket status, and the authorize ACK within the advertised 1 MB queue.
export const REALTIME_SNAPSHOT_MAX_BYTES = 900_000;
export const REALTIME_SNAPSHOT_MAX_NODES = 8_000;
export const REALTIME_SNAPSHOT_MAX_DOCUMENTS = 2_000;
export const REALTIME_SNAPSHOT_MAX_DOCUMENT_DEPTH = 24;
export const REALTIME_SNAPSHOT_MAX_STRING_CHARACTERS = 262_144;
export const REALTIME_DEVICE_STATUS_WINDOW_MS = 24 * 60 * 60 * 1_000;

// A poll normally completes when the next server ping is due. The extra
// allowance prevents a scheduler delay from looking like a concurrent poll.
export const REALTIME_POLL_LEASE_MS =
  REALTIME_PING_INTERVAL_MS + 5_000;
export const REALTIME_POST_LEASE_MS = 15_000;
