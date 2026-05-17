/**
 * Migration utilities for MCP connection config.
 *
 * Extracted from background/index.ts for testability.
 * Handles the SSE→streamable-http migration (R2 hardening).
 *
 * Previously the default was SSE with /sse endpoint;
 * now it's streamable-http with /mcp endpoint.
 */

// ── Constants ────────────────────────────────────

export const OLD_SSE_URL = 'http://localhost:3006/sse';
export const NEW_STREAMABLE_HTTP_URL = 'http://localhost:3006/mcp';
export const NEW_CONNECTION_TYPE = 'streamable-http';

// ── Types ─────────────────────────────────────────

export interface StoredConfig {
  mcpServerUrl?: string;
  mcpConnectionType?: string;
}

export interface MigrationResult {
  migrated: boolean;
  newUrl?: string;
  newType?: string;
}

// ── Pure functions ────────────────────────────────

/**
 * Check if stored config needs migration from SSE to streamable-http.
 *
 * Migration is triggered when:
 * - mcpServerUrl is the old SSE default (http://localhost:3006/sse)
 * - AND mcpConnectionType is either undefined or 'sse'
 */
export function needsSseToStreamableHttpMigration(stored: StoredConfig): boolean {
  return stored.mcpServerUrl === OLD_SSE_URL && (!stored.mcpConnectionType || stored.mcpConnectionType === 'sse');
}

/**
 * Compute the migration result for an SSE→streamable-http migration.
 * Pure function, no side effects.
 */
export function computeMigrationResult(): MigrationResult {
  return {
    migrated: true,
    newUrl: NEW_STREAMABLE_HTTP_URL,
    newType: NEW_CONNECTION_TYPE,
  };
}
