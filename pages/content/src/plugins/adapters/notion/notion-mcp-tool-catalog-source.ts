/**
 * NotionMcpToolCatalogSource — Notion implementation of the ToolCatalogSource port.
 *
 * Wraps mcpClient.getAvailableTools() + normalizeToolDescriptors() to produce
 * normalized ToolDescriptor[] for the InMemoryToolRegistry.
 *
 * Design (Option Y+, GPT 4C verdict, Slice M):
 *   - Implements ToolCatalogSource (mcp-runtime port)
 *   - Encapsulates all Notion-specific shape conversion (normalizeToolDescriptors)
 *   - Controller never calls normalizeToolDescriptors directly
 *   - Rejects propagate to caller (Controller should .catch() and warn)
 *
 * Plan: plans/slice-m-tool-catalog-source-plan.md
 * Committee: Gemini OO ✅ + OPUS ReOO ✅ + GPT 4C ✅ (Option Y+)
 */

import type { ToolCatalogSource } from '../../../../../../../mcp-runtime/src/core/tool-catalog-source.ts';
import type { McpClientToolShape } from './notion-tool-shape-adapter.ts';
import { normalizeToolDescriptors } from './notion-tool-shape-adapter.ts';

// ---------------------------------------------------------------------------
// Minimal mcpClient contract needed by this source
// ---------------------------------------------------------------------------

/**
 * Minimal mcpClient interface required by NotionMcpToolCatalogSource.
 * Supports partial mcpClient (only getAvailableTools is needed).
 */
export interface ToolCatalogMcpClient {
    getAvailableTools(): Promise<McpClientToolShape[]>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class NotionMcpToolCatalogSource implements ToolCatalogSource {
  private readonly mcpClient: ToolCatalogMcpClient;

  constructor(mcpClient: ToolCatalogMcpClient) {
    this.mcpClient = mcpClient;
  }

    async getTools() {
        const raw = await this.mcpClient.getAvailableTools();
        return normalizeToolDescriptors(raw);
    }
}
