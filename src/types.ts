/**
 * RESP (Redis Serialization Protocol) Type Definitions & Constants
 */

export const RespTypePrefix = {
  SIMPLE_STRING: 0x2b, // '+'
  ERROR: 0x2d,         // '-'
  INTEGER: 0x3a,       // ':'
  BULK_STRING: 0x24,   // '$'
  ARRAY: 0x2a,         // '*'
} as const;

export type RespTypePrefixByte = typeof RespTypePrefix[keyof typeof RespTypePrefix];

export const CRLF = {
  CR: 0x0d, // '\r'
  LF: 0x0a, // '\n'
} as const;

export interface RespSimpleString {
  type: 'simple_string';
  value: string;
}

export interface RespError {
  type: 'error';
  value: string;
}

export interface RespInteger {
  type: 'integer';
  value: bigint;
}

export interface RespBulkString {
  type: 'bulk_string';
  value: Buffer | null;
}

export interface RespArray {
  type: 'array';
  value: RespValue[] | null;
}

export type RespValue =
  | RespSimpleString
  | RespError
  | RespInteger
  | RespBulkString
  | RespArray;

/**
 * Protocol error thrown when an incoming stream violates RESP grammar or size bounds.
 */
export class ProtocolError extends Error {
  code: string;

  constructor(message: string, code: string = 'ERR_RESP_PROTOCOL') {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    Object.setPrototypeOf(this, ProtocolError.prototype);
  }
}

/**
 * Parser configuration and security limits.
 */
export interface ParserOptions {
  /** Maximum allowable length of an inline header (type prefix through CRLF) in bytes. Default: 64 KB */
  maxInlineLength?: number;
  /** Maximum allowable length of a bulk string payload in bytes. Default: 64 MB */
  maxBulkLength?: number;
  /** Maximum depth of nested RESP arrays. Default: 16 */
  maxArrayDepth?: number;
  /** Initial internal buffer capacity in bytes. Default: 64 KB */
  initialBufferSize?: number;
  /** Maximum internal buffer capacity before memory guard trips. Default: 128 MB */
  maxBufferSize?: number;
}

/**
 * Server configuration options.
 */
export interface ServerOptions extends ParserOptions {
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Port to listen on. Default: 6379 */
  port?: number;
  /** Max simultaneous connections before rejecting. Default: 10,000 */
  maxConnections?: number;
  /** Inactivity timeout for client sockets in milliseconds (0 to disable). Default: 0 */
  idleTimeoutMs?: number;
  /** Graceful shutdown deadline in milliseconds before force-closing. Default: 5000 */
  shutdownTimeoutMs?: number;
  /** Enable TCP Keep-Alive. Default: true */
  keepAlive?: boolean;
  /** Delay in milliseconds before first keep-alive probe. Default: 60000 */
  keepAliveInitialDelayMs?: number;
  /** Disable Nagle's algorithm (TCP_NODELAY) for low-latency command/response. Default: true */
  noDelay?: boolean;
  /** Maximum heap memory usage in bytes before LRU eviction. Default: 0 (disabled) */
  maxMemoryBytes?: number;
  /** Maximum number of keys before LRU eviction. Default: 0 (disabled) */
  maxKeys?: number;
  /** Active TTL background sweep interval in milliseconds. Default: 100 */
  ttlSweepIntervalMs?: number;
  /** Number of random keys to sample per active TTL sweep step. Default: 20 */
  ttlSampleSize?: number;
  /** Time budget in milliseconds per active TTL sweep cycle. Default: 5 */
  ttlSweepMaxTimeMs?: number;
  /** File path to AOF log. If set, AOF durability is enabled. */
  aofPath?: string;
  /** AOF fsync policy: 'always', 'everysec', or 'no'. Default: 'everysec' */
  fsyncPolicy?: 'always' | 'everysec' | 'no';
}

export interface CommandExecutionResult {
  response: Buffer;
  shouldClose?: boolean;
}
