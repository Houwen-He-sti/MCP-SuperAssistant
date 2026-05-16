import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildReadOnlyNotionBridgePrompt } from './notionBridgePromptBuilder.ts';

const CURRENT_READ_ONLY_TOOLS = ['echo', 'get_bridge_info', 'get_task_status', 'read_workspace_file', 'get_child_item'];
const WRITE_TOOL_NAMES = [
    'comment_on_pr',
    'submit_pr_review',
    'merge_pr',
    'git_commit',
    'git_push',
    'create_pr',
    'create_issue',
    'update_issue',
    'post_mailbox_message',
];

function assertNoWriteToolNames(prompt: string): void {
    for (const toolName of WRITE_TOOL_NAMES) {
        assert.equal(prompt.includes(toolName), false, `prompt must not include ${toolName}`);
    }
}

describe('buildReadOnlyNotionBridgePrompt', () => {
    test('emits only the current read-only bridge tools', () => {
        const prompt = buildReadOnlyNotionBridgePrompt({
            tools: CURRENT_READ_ONLY_TOOLS.map(name => ({ name })),
        });

        for (const toolName of CURRENT_READ_ONLY_TOOLS) {
            assert.ok(prompt.includes(toolName), `prompt should include ${toolName}`);
        }
        assert.ok(prompt.includes('get_child_item (Path, Depth, max_results)'));
        assertNoWriteToolNames(prompt);
    });

    test('uses a safe read-only fallback when runtime tools are unavailable', () => {
        const prompt = buildReadOnlyNotionBridgePrompt();

        for (const toolName of CURRENT_READ_ONLY_TOOLS) {
            assert.ok(prompt.includes(toolName), `fallback prompt should include ${toolName}`);
        }
        assertNoWriteToolNames(prompt);
    });

    test('filters out stale or write-capable tools from mixed input', () => {
        const prompt = buildReadOnlyNotionBridgePrompt({
            tools: [
                { name: 'echo' },
                { name: 'comment_on_pr' },
                { name: 'merge_pr' },
                { name: 'get_task_status' },
            ],
        });

        assert.ok(prompt.includes('echo'));
        assert.ok(prompt.includes('get_task_status'));
        assertNoWriteToolNames(prompt);
    });
});

describe('NotionAdapter first-conversation prefix source', () => {
    test('uses the sanitized read-only prompt builder instead of the legacy static template', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const adapterPath = resolve(here, '../../../plugins/adapters/notion.adapter.ts');
        const source = readFileSync(adapterPath, 'utf8');

        assert.ok(source.includes('buildReadOnlyNotionBridgePrompt'));
        assert.equal(source.includes('assembleNotionBridgePrompt'), false);
    });
});