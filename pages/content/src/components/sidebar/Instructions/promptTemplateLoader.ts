/**
 * promptTemplateLoader — loads and assembles prompt templates from external files.
 *
 * Replaces hardcoded prompt strings in instructionGeneratorJson.ts and notion.adapter.ts.
 * Templates are imported as raw strings at build time (zero async, no race conditions).
 *
 * Wraps the final assembled instruction with <mcp-system-prompt> tag for UI card rendering.
 */

// Raw template imports (build-time inlined as strings)
import baseProtocol from './prompt-templates/base-jsonl-protocol.md?raw';
import notionBridge from './prompt-templates/notion-bridge.md?raw';
import chatgptSupplement from './prompt-templates/chatgpt-supplement.md?raw';
import geminiSupplement from './prompt-templates/gemini-supplement.md?raw';

// ============================================================================
// Constants
// ============================================================================

export const SYSTEM_PROMPT_TAG = 'mcp-system-prompt';
export const SYSTEM_PROMPT_OPEN = `<${SYSTEM_PROMPT_TAG}>`;
export const SYSTEM_PROMPT_CLOSE = `</${SYSTEM_PROMPT_TAG}>`;

// ============================================================================
// Template accessors
// ============================================================================

export function getBaseProtocol(): string {
    return baseProtocol;
}

export function getNotionBridgePrompt(): string {
    return notionBridge;
}

export function getPlatformSupplement(platform: 'chatgpt' | 'gemini' | 'notion' | string): string {
    switch (platform) {
        case 'chatgpt':
            return chatgptSupplement;
        case 'gemini':
            return geminiSupplement;
        default:
            return '';
    }
}

// ============================================================================
// Tool list formatting (extracted from instructionGeneratorJson.ts)
// ============================================================================

interface ToolDefinition {
    name: string;
    description: string;
    schema: string;
}

export function formatToolList(tools: ToolDefinition[]): string {
    if (!tools || tools.length === 0) {
        return '# No tools available\n\nConnect to the MCP server to see available tools.';
    }

    let output = '';
    for (const tool of tools) {
        output += ` - ${tool.name}\n`;
        try {
            const schema = JSON.parse(tool.schema);
            if (tool.description) {
                output += `**Description**: ${tool.description}\n`;
            }
            if (schema.properties && Object.keys(schema.properties).length > 0) {
                output += '**Parameters**:\n';
                const requiredParams = Array.isArray(schema.required) ? schema.required : [];
                for (const [paramName, paramDetails] of Object.entries(schema.properties) as [string, any][]) {
                    const isRequired = requiredParams.includes(paramName);
                    output += `- \`${paramName}\`: ${paramDetails.description || ''} (${paramDetails.type || 'any'}) (${isRequired ? 'required' : 'optional'})\n`;
                    if (paramDetails.type === 'object' && paramDetails.properties) {
                        output += '  - Properties:\n';
                        for (const [nestedName, nestedDetails] of Object.entries(paramDetails.properties) as [string, any][]) {
                            output += `    - \`${nestedName}\`: ${nestedDetails.description || 'No description'} (${nestedDetails.type || 'any'})\n`;
                        }
                    }
                    if (
                        paramDetails.type === 'array' &&
                        paramDetails.items?.type === 'object' &&
                        paramDetails.items?.properties
                    ) {
                        output += '  - Array items (objects) with properties:\n';
                        for (const [itemName, itemDetails] of Object.entries(paramDetails.items.properties) as [string, any][]) {
                            output += `    - \`${itemName}\`: ${itemDetails.description || 'No description'} (${itemDetails.type || 'any'})\n`;
                        }
                    }
                }
                output += '\n';
            }
        } catch {
            output += 'Schema information not available. No Tools Available';
        }
    }
    return output;
}

// ============================================================================
// Assembly
// ============================================================================

interface AssembleOptions {
    tools: ToolDefinition[];
    platform: string;
    customInstructions?: string;
    customInstructionsEnabled?: boolean;
}

/**
 * Assemble the full instruction text from templates.
 * Used by instructionGeneratorJson.ts.
 */
export function assembleInstructions(options: AssembleOptions): string {
    const { tools, platform, customInstructions, customInstructionsEnabled } = options;

    let template = getBaseProtocol();

    // Replace {{PLATFORM_SUPPLEMENT}}
    const supplement = getPlatformSupplement(platform);
    template = template.replace('{{PLATFORM_SUPPLEMENT}}', supplement);

    // Replace {{TOOL_LIST}}
    const toolList = formatToolList(tools);
    template = template.replace('{{TOOL_LIST}}', toolList);

    // Replace {{CUSTOM_INSTRUCTIONS}}
    if (customInstructionsEnabled && customInstructions && customInstructions.trim()) {
        const wrapped = `<custom_instructions>\n${customInstructions.trim()}\n</custom_instructions>`;
        template = template.replace('{{CUSTOM_INSTRUCTIONS}}', wrapped);
    } else {
        template = template.replace('{{CUSTOM_INSTRUCTIONS}}', '');
    }

    return template;
}

/**
 * Wrap a prompt string with <mcp-system-prompt> tags for UI card rendering.
 */
export function wrapWithSystemPromptTag(prompt: string): string {
    return `${SYSTEM_PROMPT_OPEN}\n${prompt}\n${SYSTEM_PROMPT_CLOSE}`;
}

/**
 * Assemble the Notion bridge prompt (used by notion.adapter.ts).
 * Wraps with <mcp-system-prompt> for UI rendering.
 */
export function assembleNotionBridgePrompt(): string {
    return getNotionBridgePrompt();
}
