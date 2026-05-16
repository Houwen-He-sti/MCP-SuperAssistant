export interface NotionBridgeToolDefinition {
    name: string;
    description?: string;
    schema?: string;
}

export interface BuildReadOnlyNotionBridgePromptOptions {
    tools?: NotionBridgeToolDefinition[];
    allowedToolNames?: string[];
}

export const DEFAULT_READ_ONLY_NOTION_BRIDGE_TOOL_NAMES = [
    'echo',
    'get_bridge_info',
    'get_task_status',
    'read_workspace_file',
    'get_child_item',
] as const;

const READ_ONLY_TOOL_HINTS: Record<string, string> = {
    echo: 'message',
    read_workspace_file: 'path, max_bytes',
    get_child_item: 'Path, Depth, max_results',
};

function uniqueToolNames(tools: NotionBridgeToolDefinition[] | undefined): string[] {
    const names = new Set<string>();
    for (const tool of tools || []) {
        if (tool.name) names.add(tool.name);
    }
    return [...names];
}

function selectReadOnlyToolNames(options: BuildReadOnlyNotionBridgePromptOptions): string[] {
    const allowed = new Set(options.allowedToolNames || DEFAULT_READ_ONLY_NOTION_BRIDGE_TOOL_NAMES);
    const provided = uniqueToolNames(options.tools).filter(name => allowed.has(name));
    return provided.length > 0 ? provided : [...DEFAULT_READ_ONLY_NOTION_BRIDGE_TOOL_NAMES];
}

export function buildReadOnlyNotionBridgePrompt(options: BuildReadOnlyNotionBridgePromptOptions = {}): string {
    const toolNames = selectReadOnlyToolNames(options);
    const toolList = toolNames.map(name => {
        const hint = READ_ONLY_TOOL_HINTS[name];
        return hint ? `- ${name} (${hint})` : `- ${name}`;
    }).join('\n');

    return [
        'SuperAssistant Bridge is a browser-extension text protocol.',
        'Do not use Notion native MCP, connected apps, web search, or built-in integrations for this bridge.',
        'When a bridge tool is needed, print exactly one fenced jsonl code block and then stop.',
        '',
        'Allowed read-only bridge tools for this session:',
        toolList,
        '',
        'JSONL line order:',
        '1. function_call_start with name and call_id',
        '2. description',
        '3. parameter for each argument',
        '4. function_call_end with the same call_id',
        '',
        'Format example only. Do not copy this call_id or message:',
        '```jsonl',
        '{"type":"function_call_start","name":"echo","call_id":"EXAMPLE_DO_NOT_EXECUTE"}',
        '{"type":"description","text":"format example only"}',
        '{"type":"parameter","key":"message","value":"example-not-current"}',
        '{"type":"function_call_end","call_id":"EXAMPLE_DO_NOT_EXECUTE"}',
        '```',
        '',
        'After printing the current tool call, wait for the browser extension to insert the result.',
    ].join('\n');
}