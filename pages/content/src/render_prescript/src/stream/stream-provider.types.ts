/**
 * Gate 6-R-B: Stream Provider Adapter Types
 *
 * Provider-specific stream detection and interception configuration.
 * Each web AI provider (Notion, ChatGPT, Claude, etc.) uses different
 * API endpoints, stream formats, and fetch interception strategies.
 *
 * These types define the contract that a provider must implement to
 * integrate with the generic stream interceptor (Gate 6-R-C+).
 *
 * @see plans/gate6-r-a-runtime-extraction-plan.md
 * @see PR #37
 */

import type { FunctionCallIdentity } from './parser';

// ============================================================================
// Stream Format
// ============================================================================

/**
 * Supported stream transport formats across web AI providers.
 *
 * - 'ndjson': Newline-delimited JSON (Notion AI)
 * - 'sse': Server-Sent Events with `data:` prefix (ChatGPT, Claude)
 * - 'websocket': WebSocket-based streaming (some providers)
 * - 'chunked-json': Chunked transfer with JSON objects (fallback)
 */
export type StreamFormat = 'ndjson' | 'sse' | 'websocket' | 'chunked-json';

// ============================================================================
// Stream Content
// ============================================================================

/**
 * Normalized content extracted from a single stream chunk/line.
 * Provider adapters transform raw bytes/text into this common format
 * before passing to the function call scanner.
 */
export interface StreamChunkContent {
  /** Extracted text suitable for function call scanning */
  text: string;
  /** Whether this line represents a complete logical unit (vs partial) */
  complete: boolean;
  /** Provider-specific metadata (opaque to the runtime core) */
  meta?: Record<string, unknown>;
}

// ============================================================================
// Interception Request Context
// ============================================================================

/**
 * Minimal request context for interception decisions.
 * Currently only `url` is required (sufficient for Notion in R-C).
 *
 * Future (R-F+): May be extended with `method`, `contentType`, `headers`
 * to support providers that need more than URL matching (e.g., ChatGPT SSE
 * requires checking Accept headers or response content-type).
 */
export interface InterceptRequestContext {
  /** Full request URL */
  url: string;
  /** HTTP method (GET, POST, etc.) — optional for future use */
  method?: string;
  /** Response content-type header — optional for future use */
  contentType?: string;
}

// ============================================================================
// Stream Provider Adapter Interface
// ============================================================================

/**
 * Provider-specific stream detection and content extraction.
 *
 * Lifecycle:
 * 1. `shouldIntercept(ctx)` — called for every fetch request in MAIN world
 * 2. If true → stream is wrapped, chunks are decoded
 * 3. `parseChunk(raw)` — transform raw decoded text into normalized content
 * 4. Normalized content is passed to `functionCallScanner` (provider-neutral)
 *
 * Architecture note (from GPT review):
 * - This adapter is instantiated in the MAIN world bundle
 * - It is NOT serialized via postMessage
 * - ISOLATED world receives only serializable StreamEvent payloads
 *
 * State ownership (R-C):
 * - Cross-chunk parsing state (e.g., NDJSON line buffer) is managed by the
 *   provider adapter, not the runtime core. This preserves behavioral
 *   equivalence with the current `interceptorMain.ts`.
 * - Future (R-D+): state may migrate to core keyed by stream-id.
 */
export interface StreamProviderAdapter {
  /** Unique provider identifier, e.g. 'notion', 'chatgpt', 'claude' */
  readonly providerId: string;

  /** Stream transport format used by this provider */
  readonly streamFormat: StreamFormat;

  /**
   * Determine if a request should be intercepted for function-call scanning.
   *
   * @param ctx - Request context (currently URL; may expand in R-F+)
   * @returns true if this request's response stream should be observed
   *
   * Example (Notion): `ctx.url` pathname === '/api/v3/runInferenceTranscript'
   */
  shouldIntercept(ctx: InterceptRequestContext): boolean;

  /**
   * Transform raw decoded text from a stream chunk into normalized content lines.
   *
   * The provider adapter handles format-specific parsing:
   * - Notion: split by '\n', trim, skip empty lines
   * - ChatGPT SSE: strip 'data: ' prefix, handle [DONE] sentinel
   * - Claude SSE: strip 'event:' + 'data:', parse content_block_delta
   *
   * Returns an array because one raw chunk may contain multiple logical lines.
   *
   * @param raw - Raw decoded text from a single chunk (TextDecoder output)
   * @returns Array of normalized content items ready for scanner
   */
  parseChunk(raw: string): StreamChunkContent[];

  /**
   * Generate a unique stream ID for a new intercepted stream.
   * Default pattern: `${providerId}-${counter}` (e.g., 'notion-ai-7')
   *
   * @returns Unique stream identifier for event correlation
   */
  createStreamId(): string;

  /**
   * Optional: Determine response content-type eligibility.
   * If not provided, defaults to accepting any response with a body.
   *
   * @param contentType - Response Content-Type header value
   * @returns true if the response format is compatible with this adapter
   */
  isEligibleContentType?(contentType: string): boolean;
}

// ============================================================================
// Provider Registration
// ============================================================================

/**
 * Static provider configuration for registration.
 * Used to associate a StreamProviderAdapter with its host detection
 * (which is separate from BaseAdapterPlugin hostname matching).
 */
export interface StreamProviderRegistration {
  /** The provider adapter instance */
  adapter: StreamProviderAdapter;
  /**
   * Hostnames where this stream adapter is active.
   * Matched against window.location.hostname.
   * Example: ['notion.so', 'www.notion.so']
   */
  hostnames: (string | RegExp)[];
  /** Priority for resolution when multiple adapters match (higher wins) */
  priority?: number;
}

// ============================================================================
// Re-export for convenience
// ============================================================================

export type { FunctionCallIdentity };
