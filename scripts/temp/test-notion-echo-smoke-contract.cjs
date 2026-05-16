#!/usr/bin/env node
const assert = require('assert');

const {
    ACK_PATTERN,
    REVIEW_FILE_CONTEXT_MAX_BYTES,
    REVIEW_FILE_CONTEXT_PATH,
    REVIEW_PR_FILE_CONTEXT_MAX_BYTES,
    REVIEW_PR_FILE_CONTEXT_PATH,
    SAFE_FINAL_PREFERENCES,
    INSTRUCTION_FILE_ANSWER_TASK,
    LIST_COMMAND_TASK,
    WORKSPACE_TREE_TASK,
    buildEchoClosedLoopPrompt,
    buildInstructionFileAnswerPrompt,
    buildListCommandPrompt,
    buildListCommandResult,
    buildWorkspaceTreePrompt,
    buildWorkspaceTreeResult,
    buildMultiRoundEchoCountPrompt,
    buildReviewModuleContextPrompt,
    buildReviewModuleFileContextPrompt,
    buildReviewModulePrFileContextPrompt,
    extractFinalResponseTextFromStreamEvents,
    extractFirstJsonBlock,
    extractLastJsonBlock,
    isRuntimeCompleteBeforeFinalRestore,
    isNotionAiRouteUrl,
    isFreshNotionChatUrl,
    validateEchoClosedLoopEvidence,
    validateEchoToolExecutions,
    validateGenericBridgeEvidence,
    validateInstructionFileAnswerEvidence,
    validateListCommandEvidence,
    validateWorkspaceTreeEvidence,
    validateMultiRoundEchoCountEvidence,
    validatePreferenceRestore,
    validateReviewModuleContextEvidence,
    validateReviewModuleFileContextEvidence,
    validateReviewModulePrFileContextEvidence,
} = require('./notion-echo-smoke-contract.cjs');

const nonce = 'ECHO_SMOKE_1778865000000';
const callId = 'call_echo_smoke_1778865000000';
const multiRoundCallIds = [
    'call_echo_count_1_1778865000000',
    'call_echo_count_2_1778865000000',
    'call_echo_count_3_1778865000000',
];
const instructionCallId = 'call_read_workspace_file_1778865000000';
const listCommandCallId = 'call_list_command_1778865000000';
const workspaceTreeCallId = 'call_get_child_item_1778865000000';

function makePassingInstructionFileAnswerEvidence(overrides = {}) {
    return {
        nonce,
        callId: instructionCallId,
        taskKind: INSTRUCTION_FILE_ANSWER_TASK.kind,
        controlStates: [
            { status: 'continue', callIds: [instructionCallId] },
            { status: 'done' },
        ],
        freshChatBefore: true,
        preferencesBefore: { autoInsert: true, autoSubmit: true, autoExecute: false },
        preferencesAfter: { ...SAFE_FINAL_PREFERENCES },
        finallyRestoreAttempted: true,
        autoSubmitCount: 1,
        exposedToolNames: ['read_workspace_file'],
        executedToolCalls: [
            {
                name: 'read_workspace_file',
                callId: instructionCallId,
                args: {
                    path: INSTRUCTION_FILE_ANSWER_TASK.allowedPaths[0],
                    max_bytes: INSTRUCTION_FILE_ANSWER_TASK.maxBytes,
                },
                resultText: INSTRUCTION_FILE_ANSWER_TASK.marker,
            },
        ],
        insertedResults: [
            {
                name: 'read_workspace_file',
                callId: instructionCallId,
                text: `<function_result call_id="${instructionCallId}" name="read_workspace_file" status="success">${INSTRUCTION_FILE_ANSWER_TASK.marker}</function_result>`,
            },
        ],
        events: [
            { type: 'submitForm', method: 'send-button', hasFunctionResult: true },
            { type: 'submitButtonClickResult', result: { ok: true, method: 'send-button-click' } },
            { type: 'submitFormResult', method: 'send-button', result: true },
        ],
        finalResponseText: '```json\n{"status":"done","nonce":"' + nonce + '","answer":"capacitor drift","evidence_path":"' + INSTRUCTION_FILE_ANSWER_TASK.allowedPaths[0] + '","summary":"instruction smoke"}\n```',
        oracleSource: 'turn-scoped',
        ...overrides,
    };
}

function makePassingListCommandEvidence(overrides = {}) {
    const listCommandResult = buildListCommandResult();
    const resultText = JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify(listCommandResult, null, 2) }],
        isError: false,
    });
    return {
        nonce,
        callId: listCommandCallId,
        freshChatBefore: true,
        preferencesBefore: { autoInsert: true, autoSubmit: true, autoExecute: false },
        preferencesAfter: { ...SAFE_FINAL_PREFERENCES },
        finallyRestoreAttempted: true,
        autoSubmitCount: 1,
        exposedToolNames: ['echo', 'get_bridge_info', 'get_task_status', 'read_workspace_file'],
        executedToolCalls: [
            { name: 'list_command', callId: listCommandCallId, args: {}, resultText },
        ],
        insertedResults: [
            { name: 'list_command', callId: listCommandCallId, text: `<function_result call_id="${listCommandCallId}" name="list_command" status="success">${resultText}</function_result>` },
        ],
        events: [
            { type: 'submitForm', method: 'send-button', hasFunctionResult: true },
            { type: 'submitButtonClickResult', result: { ok: true, method: 'send-button-click' } },
            { type: 'submitFormResult', method: 'send-button', result: true },
        ],
        finalResponseText: '```json\n{"status":"done","nonce":"' + nonce + '","tree_command":"Get-ChildItem","read_file_command":"Get-Content","search_text_command":"Select-String","workspace_root":"' + LIST_COMMAND_TASK.workspaceRoot.replaceAll('\\', '\\\\') + '","path_policy_summary":"Use workspace-relative paths only; no .., drive paths, home paths, UNC paths, URLs, or outside-workspace paths.","safety_summary":"read_only=true; write_enabled=false; exec_enabled=false; network_enabled=false"}\n```',
        oracleSource: 'turn-scoped',
        ...overrides,
    };
}

function makePassingWorkspaceTreeEvidence(overrides = {}) {
    const workspaceTreeResult = buildWorkspaceTreeResult();
    const resultText = JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify(workspaceTreeResult, null, 2) }],
        isError: false,
    });
    return {
        nonce,
        callId: workspaceTreeCallId,
        freshChatBefore: true,
        preferencesBefore: { autoInsert: true, autoSubmit: true, autoExecute: false },
        preferencesAfter: { ...SAFE_FINAL_PREFERENCES },
        finallyRestoreAttempted: true,
        autoSubmitCount: 1,
        exposedToolNames: ['echo', 'get_bridge_info', 'get_task_status', 'read_workspace_file', WORKSPACE_TREE_TASK.toolName],
        executedToolCalls: [
            { name: WORKSPACE_TREE_TASK.toolName, callId: workspaceTreeCallId, args: { Path: WORKSPACE_TREE_TASK.path, Depth: WORKSPACE_TREE_TASK.depth }, resultText },
        ],
        insertedResults: [
            { name: WORKSPACE_TREE_TASK.toolName, callId: workspaceTreeCallId, text: `<function_result call_id="${workspaceTreeCallId}" name="${WORKSPACE_TREE_TASK.toolName}" status="success">${resultText}</function_result>` },
        ],
        events: [
            { type: 'submitForm', method: 'send-button', hasFunctionResult: true },
            { type: 'submitButtonClickResult', result: { ok: true, method: 'send-button-click' } },
            { type: 'submitFormResult', method: 'send-button', result: true },
        ],
        finalResponseText: '```json\n{"status":"done","nonce":"' + nonce + '","command_executed":"Get-ChildItem","path":"' + WORKSPACE_TREE_TASK.path + '","entry_count":3,"entries":["alpha.txt","nested","nested/beta.md"],"path_policy_summary":"Use workspace-relative paths only.","safety_summary":"read_only=true; write_enabled=false; exec_enabled=false; network_enabled=false"}\n```',
        oracleSource: 'turn-scoped',
        ...overrides,
    };
}

function makePassingEvidence(overrides = {}) {
    return {
        nonce,
        callId,
        preferencesBefore: { autoInsert: true, autoSubmit: true, autoExecute: false },
        preferencesAfter: { ...SAFE_FINAL_PREFERENCES },
        finallyRestoreAttempted: true,
        autoSubmitCount: 1,
        exposedToolNames: ['echo', 'get_bridge_info', 'get_task_status'],
        executedToolCalls: [
            { name: 'echo', callId, args: { message: nonce }, resultText: nonce },
        ],
        insertedResults: [
            { name: 'echo', callId, text: `<function_result call_id="${callId}" name="echo" status="success">${nonce}</function_result>` },
        ],
        finalResponseText: `ACK ${nonce}`,
        oracleSource: 'turn-scoped',
        ...overrides,
    };
}

function makePassingReviewContextEvidence(overrides = {}) {
    return {
        nonce,
        callId,
        expectedAck: `ACK_${nonce}`,
        freshChatBefore: true,
        preferencesBefore: { autoInsert: true, autoSubmit: true, autoExecute: false },
        preferencesAfter: { ...SAFE_FINAL_PREFERENCES },
        finallyRestoreAttempted: true,
        autoSubmitCount: 1,
        exposedToolNames: ['echo', 'get_bridge_info', 'get_task_status'],
        executedToolCalls: [
            { name: 'get_bridge_info', callId, args: {}, resultText: '{"tools":["get_bridge_info"]}' },
        ],
        insertedResults: [
            { name: 'get_bridge_info', callId, text: `<function_result call_id="${callId}" name="get_bridge_info" status="success">ok</function_result>` },
        ],
        finalResponseText: '```json\n{"status":"done","ack":"ACK_' + nonce + '","recommendation":"COMMENT","scope":"bridge info smoke","findings":[],"summary_markdown":"smoke ' + nonce + '"}\n```',
        oracleSource: 'turn-scoped',
        ...overrides,
    };
}

function makePassingReviewFileContextEvidence(overrides = {}) {
    return {
        nonce,
        callId,
        expectedAck: `ACK_${nonce}`,
        freshChatBefore: true,
        preferencesBefore: { autoInsert: true, autoSubmit: true, autoExecute: false },
        preferencesAfter: { ...SAFE_FINAL_PREFERENCES },
        finallyRestoreAttempted: true,
        autoSubmitCount: 1,
        exposedToolNames: ['echo', 'get_bridge_info', 'get_task_status', 'read_workspace_file'],
        executedToolCalls: [
            { name: 'read_workspace_file', callId, args: { path: REVIEW_FILE_CONTEXT_PATH, max_bytes: REVIEW_FILE_CONTEXT_MAX_BYTES }, resultText: `{"path":"${REVIEW_FILE_CONTEXT_PATH}"}` },
        ],
        insertedResults: [
            { name: 'read_workspace_file', callId, text: `<function_result call_id="${callId}" name="read_workspace_file" status="success">{"path":"${REVIEW_FILE_CONTEXT_PATH}","content":"hello"}</function_result>` },
        ],
        events: [
            { type: 'submitForm', method: 'send-button', hasFunctionResult: true },
            { type: 'submitButtonClickResult', result: { ok: true, method: 'send-button-click' } },
            { type: 'submitFormResult', method: 'send-button', result: true },
        ],
        finalResponseText: '```json\n{"status":"done","ack":"ACK_' + nonce + '","recommendation":"COMMENT","scope":"read_workspace_file ' + REVIEW_FILE_CONTEXT_PATH + '","findings":[],"summary_markdown":"smoke ' + nonce + '"}\n```',
        oracleSource: 'turn-scoped',
        ...overrides,
    };
}

function makePassingReviewPrFileContextEvidence(overrides = {}) {
    return {
        nonce,
        callId,
        expectedAck: `ACK_${nonce}`,
        freshChatBefore: true,
        preferencesBefore: { autoInsert: true, autoSubmit: true, autoExecute: false },
        preferencesAfter: { ...SAFE_FINAL_PREFERENCES },
        finallyRestoreAttempted: true,
        autoSubmitCount: 1,
        exposedToolNames: ['echo', 'get_bridge_info', 'get_task_status', 'read_workspace_file'],
        executedToolCalls: [
            { name: 'read_workspace_file', callId, args: { path: REVIEW_PR_FILE_CONTEXT_PATH, max_bytes: REVIEW_PR_FILE_CONTEXT_MAX_BYTES }, resultText: `{"path":"${REVIEW_PR_FILE_CONTEXT_PATH}"}` },
        ],
        insertedResults: [
            { name: 'read_workspace_file', callId, text: `<function_result call_id="${callId}" name="read_workspace_file" status="success">{"path":"${REVIEW_PR_FILE_CONTEXT_PATH}","content":"def review_target(): pass"}</function_result>` },
        ],
        events: [
            { type: 'submitForm', method: 'send-button', hasFunctionResult: true },
            { type: 'submitButtonClickResult', result: { ok: true, method: 'send-button-click' } },
            { type: 'submitFormResult', method: 'send-button', result: true },
        ],
        finalResponseText: '```json\n{"status":"done","ack":"ACK_' + nonce + '","recommendation":"COMMENT","scope":"read_workspace_file ' + REVIEW_PR_FILE_CONTEXT_PATH + ' review smoke","findings":[],"summary_markdown":"review-pr-file smoke ' + nonce + '"}\n```',
        oracleSource: 'turn-scoped',
        writeBackAttempted: false,
        ...overrides,
    };
}

function makePassingMultiRoundEvidence(overrides = {}) {
    return {
        nonce,
        targetCount: 3,
        expectedCallIds: multiRoundCallIds,
        freshChatBefore: true,
        preferencesBefore: { autoInsert: true, autoSubmit: true, autoExecute: false },
        preferencesAfter: { ...SAFE_FINAL_PREFERENCES },
        finallyRestoreAttempted: true,
        autoSubmitCount: 3,
        exposedToolNames: ['echo', 'get_bridge_info', 'get_task_status'],
        executedToolCalls: multiRoundCallIds.map((id, index) => {
            const step = index + 1;
            const message = `${nonce} COUNT_${step}_OF_3`;
            return { name: 'echo', callId: id, args: { message }, resultText: message };
        }),
        insertedResults: multiRoundCallIds.map((id, index) => {
            const step = index + 1;
            const message = `${nonce} COUNT_${step}_OF_3`;
            return { name: 'echo', callId: id, text: `<function_result call_id="${id}" name="echo" status="success">${message}</function_result>` };
        }),
        events: [
            { type: 'submitForm', method: 'send-button', hasFunctionResult: true },
            { type: 'submitFormResult', method: 'send-button', result: true },
            { type: 'submitForm', method: 'send-button', hasFunctionResult: true },
            { type: 'submitFormResult', method: 'send-button', result: true },
            { type: 'submitForm', method: 'send-button', hasFunctionResult: true },
            { type: 'submitFormResult', method: 'send-button', result: true },
        ],
        streamEvents: [
            { type: 'stream_start' },
            { type: 'stream_start' },
            { type: 'stream_start' },
            { type: 'stream_start' },
        ],
        finalResponseText: [
            '```json',
            '{"status":"continue","nonce":"' + nonce + '","observed_count":1,"target_count":3}',
            '```',
            '```json',
            '{"status":"done","nonce":"' + nonce + '","observed_count":3,"target_count":3,"summary_markdown":"multi-round ' + nonce + '"}',
            '```',
        ].join('\n'),
        oracleSource: 'turn-scoped',
        ...overrides,
    };
}

function assertInvalid(partial, expectedReason) {
    const result = validateEchoClosedLoopEvidence(makePassingEvidence(partial));
    assert.equal(result.ok, false, expectedReason);
    assert.ok(result.failures.includes(expectedReason), `expected ${expectedReason}, got ${result.failures.join(', ')}`);
}

const prompt = buildEchoClosedLoopPrompt({ nonce, callId });
assert.ok(prompt.includes('# 角色'), 'prompt includes the shared bridge trunk header');
assert.ok(prompt.includes('SuperAssistant Bridge'), 'prompt includes the shared bridge identity');
assert.ok(prompt.includes('结果作为下一条用户消息回贴给你'), 'prompt explains bridge results return as the next user message');
assert.ok(prompt.indexOf('SuperAssistant Bridge') < prompt.indexOf('Current tool call'), 'bridge trunk precedes smoke task instructions');
assert.ok(prompt.includes(nonce), 'prompt contains current nonce');
assert.ok(prompt.includes(callId), 'prompt contains current call_id');
assert.ok(prompt.includes('EXAMPLE_DO_NOT_EXECUTE'), 'prompt marks example as non-current');
assert.ok(prompt.includes('"name":"echo"'), 'prompt demonstrates echo only');
assert.ok(!prompt.includes('"name":"comment_on_pr"'), 'prompt does not include a write-capable current call');

const reviewContextPrompt = buildReviewModuleContextPrompt({ ack: `ACK_${nonce}`, nonce, callId });
assert.ok(reviewContextPrompt.includes('SuperAssistant Bridge'), 'review context prompt includes shared trunk');
assert.ok(reviewContextPrompt.includes('# 当前任务：Code Review'), 'review context prompt includes ReviewModule template');
assert.ok(reviewContextPrompt.includes(`ACK_${nonce}`), 'review context prompt includes current ack');
assert.ok(reviewContextPrompt.includes(callId), 'review context prompt includes current call_id');
assert.ok(reviewContextPrompt.includes('get_bridge_info'), 'review context prompt requires read-only bridge info call');

const reviewFileContextPrompt = buildReviewModuleFileContextPrompt({ ack: `ACK_${nonce}`, nonce, callId });
assert.ok(reviewFileContextPrompt.includes('SuperAssistant Bridge'), 'review file-context prompt includes shared trunk');
assert.ok(reviewFileContextPrompt.includes('# 当前任务：Code Review'), 'review file-context prompt includes ReviewModule template');
assert.ok(reviewFileContextPrompt.includes(`ACK_${nonce}`), 'review file-context prompt includes current ack');
assert.ok(reviewFileContextPrompt.includes(callId), 'review file-context prompt includes current call_id');
assert.ok(reviewFileContextPrompt.includes('read_workspace_file'), 'review file-context prompt requires read-only file tool');
assert.ok(reviewFileContextPrompt.includes(REVIEW_FILE_CONTEXT_PATH), 'review file-context prompt names target path');

const reviewPrFileContextPrompt = buildReviewModulePrFileContextPrompt({ ack: `ACK_${nonce}`, nonce, callId });
assert.ok(reviewPrFileContextPrompt.includes('SuperAssistant Bridge'), 'review PR file-context prompt includes shared trunk');
assert.ok(reviewPrFileContextPrompt.includes('# 当前任务：Code Review'), 'review PR file-context prompt includes ReviewModule template');
assert.ok(reviewPrFileContextPrompt.includes(`ACK_${nonce}`), 'review PR file-context prompt includes current ack');
assert.ok(reviewPrFileContextPrompt.includes(callId), 'review PR file-context prompt includes current call_id');
assert.ok(reviewPrFileContextPrompt.includes('read_workspace_file'), 'review PR file-context prompt requires read-only file tool');
assert.ok(reviewPrFileContextPrompt.includes(REVIEW_PR_FILE_CONTEXT_PATH), 'review PR file-context prompt names target changed file path');
assert.ok(reviewPrFileContextPrompt.includes('PR-like'), 'review PR file-context prompt stays review-shaped');

const multiRoundPrompt = buildMultiRoundEchoCountPrompt({ nonce, callIds: multiRoundCallIds, targetCount: 3 });
assert.ok(multiRoundPrompt.includes('Multi-Round Echo Count Smoke'), 'multi-round prompt names the smoke kind');
assert.ok(multiRoundPrompt.includes('it does not decide the next step for you'), 'multi-round prompt keeps decision with the model');
assert.ok(multiRoundPrompt.includes('observed_count is less than target_count'), 'multi-round prompt defines continue condition');
assert.ok(multiRoundPrompt.includes('observed_count is equal to target_count'), 'multi-round prompt defines done condition');
assert.ok(multiRoundPrompt.includes(multiRoundCallIds[2]), 'multi-round prompt includes every call_id');
assert.ok(multiRoundPrompt.includes(`${nonce} COUNT_3_OF_3`), 'multi-round prompt includes deterministic count message');

const instructionPrompt = buildInstructionFileAnswerPrompt({ nonce, callId: instructionCallId });
assert.ok(instructionPrompt.includes('Instruction File Answer Smoke'), 'instruction prompt names the generic smoke kind');
assert.ok(instructionPrompt.includes(INSTRUCTION_FILE_ANSWER_TASK.allowedPaths[0]), 'instruction prompt includes allowed file path');
assert.ok(instructionPrompt.includes(nonce), 'instruction prompt includes nonce');
assert.ok(instructionPrompt.includes('"answer"'), 'instruction prompt includes task-specific final JSON schema');
assert.ok(instructionPrompt.includes('no prose outside it'), 'instruction prompt asks for machine-readable final output');
assert.ok(!instructionPrompt.includes('Code Review'), 'instruction prompt does not reuse review module title');
assert.ok(!instructionPrompt.includes('LGTM'), 'instruction prompt does not include review recommendations');
assert.ok(!instructionPrompt.includes('REQUEST_CHANGES'), 'instruction prompt does not include review-specific states');
assert.ok(!instructionPrompt.includes('GitHub write-back'), 'instruction prompt does not mention GitHub write-back');

const listCommandPrompt = buildListCommandPrompt({ nonce, callId: listCommandCallId });
assert.ok(listCommandPrompt.includes('List Command Discovery Smoke'), 'list_command prompt names the smoke kind');
assert.ok(listCommandPrompt.includes('list_command'), 'list_command prompt requires discovery call');
assert.ok(listCommandPrompt.includes('"status":"continue"'), 'list_command prompt uses continue control block before tool call');
assert.ok(listCommandPrompt.includes(listCommandCallId), 'list_command prompt includes current call_id');
assert.ok(listCommandPrompt.includes(nonce), 'list_command prompt includes nonce');
assert.ok(listCommandPrompt.includes('Get-ChildItem'), 'list_command prompt final schema asks for tree command');
assert.ok(listCommandPrompt.includes('Get-Content'), 'list_command prompt final schema asks for read command');
assert.ok(listCommandPrompt.includes('Select-String'), 'list_command prompt final schema asks for search command');
assert.ok(listCommandPrompt.includes('do not execute any other command'), 'list_command prompt forbids execution beyond discovery');
assert.ok(!listCommandPrompt.includes('Code Review'), 'list_command prompt does not reuse review module title');
assert.ok(!listCommandPrompt.includes('LGTM'), 'list_command prompt does not include review recommendations');
assert.ok(!listCommandPrompt.includes('REQUEST_CHANGES'), 'list_command prompt does not include review-specific states');

const listCommandResult = buildListCommandResult();
assert.equal(listCommandResult.status, 'ok', 'list_command result has ok status');
assert.equal(listCommandResult.workspace_root, LIST_COMMAND_TASK.workspaceRoot, 'list_command result exposes fixed workspace root');
assert.deepEqual(listCommandResult.commands, { tree: 'Get-ChildItem', read_file: 'Get-Content', search_text: 'Select-String' }, 'list_command result exposes only first-slice read-only commands');
assert.ok(listCommandResult.safety.includes('read_only=true'), 'list_command result is read-only');
assert.ok(listCommandResult.safety.includes('exec_enabled=false'), 'list_command result forbids exec');
assert.ok(!JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(listCommandResult, null, 2) }], isError: false }).includes('structuredContent'), 'list_command runner payload does not duplicate structuredContent');
assert.ok(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(listCommandResult, null, 2) }], isError: false }).length < 900, 'list_command runner payload stays compact for Notion continuation');

const workspaceTreePrompt = buildWorkspaceTreePrompt({ nonce, callId: workspaceTreeCallId });
assert.ok(workspaceTreePrompt.includes('Workspace Tree Smoke'), 'workspace_tree prompt names the smoke kind');
assert.ok(workspaceTreePrompt.includes(WORKSPACE_TREE_TASK.toolName), 'workspace_tree prompt requires bounded tree tool');
assert.ok(workspaceTreePrompt.includes('Get-ChildItem'), 'workspace_tree prompt maps to Get-ChildItem');
assert.ok(workspaceTreePrompt.includes(WORKSPACE_TREE_TASK.path), 'workspace_tree prompt fixes the allowed path');
assert.ok(workspaceTreePrompt.includes('"Depth","value":2'), 'workspace_tree prompt fixes the allowed depth');
assert.ok(workspaceTreePrompt.includes('no prose outside'), 'workspace_tree prompt requires machine final JSON');
assert.ok(!workspaceTreePrompt.includes('REQUEST_CHANGES'), 'workspace_tree prompt does not include review-specific states');

const workspaceTreeResult = buildWorkspaceTreeResult();
assert.equal(workspaceTreeResult.status, 'ok', 'workspace_tree result has ok status');
assert.equal(workspaceTreeResult.command, 'Get-ChildItem', 'workspace_tree result reports command');
assert.equal(workspaceTreeResult.path, WORKSPACE_TREE_TASK.path, 'workspace_tree result reports fixed path');
assert.ok(workspaceTreeResult.entries.some((entry) => entry.path === 'alpha.txt' && entry.type === 'file'), 'workspace_tree result includes file entry');
assert.ok(workspaceTreeResult.entries.some((entry) => entry.path === 'nested/beta.md' && entry.type === 'file'), 'workspace_tree result includes nested file entry');
assert.ok(workspaceTreeResult.safety.includes('read_only=true'), 'workspace_tree result is read-only');
assert.ok(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(workspaceTreeResult, null, 2) }], isError: false }).length < 1400, 'workspace_tree runner payload stays compact for Notion continuation');

assert.equal(isNotionAiRouteUrl('https://www.notion.so/chat'), true, 'accepts Notion /chat route');
assert.equal(isNotionAiRouteUrl('https://www.notion.so/ai?targetConfig=1'), true, 'accepts Notion /ai route');
assert.equal(isNotionAiRouteUrl('https://www.notion.so/page/abc'), false, 'rejects non-AI Notion route');
assert.equal(isFreshNotionChatUrl('https://www.notion.so/ai?t=new&targetConfig=1'), true, 'accepts fresh Notion t=new route');
assert.equal(isFreshNotionChatUrl('https://www.notion.so/chat'), true, 'accepts AI route without thread id as fresh');
assert.equal(isFreshNotionChatUrl('https://www.notion.so/chat?t=thread-id&wfv=chat'), false, 'rejects existing Notion thread route');

const reconstructedAck = extractFinalResponseTextFromStreamEvents([
    {
        type: 'stream_chunk_text',
        ts: 10,
        text: JSON.stringify({
            type: 'patch',
            v: [{ o: 'a', p: '/s/-', v: { type: 'agent-inference', value: [{ type: 'text', content: 'D' }] } }],
        }),
    },
    {
        type: 'stream_chunk_text',
        ts: 11,
        text: JSON.stringify({
            type: 'patch',
            v: [{ o: 'x', p: '/s/1/value/0/content', v: `ONE ${nonce}\n\n<mcp_ack nonce="ack_call" />` }],
        }),
    },
    { type: 'stream_chunk_text', ts: 12, text: '{"type":"record-map","truncated":' },
], { afterTs: 9 });
assert.ok(ACK_PATTERN.test(reconstructedAck), 'reconstructs split DONE acknowledgement from Notion patch stream');
assert.ok(reconstructedAck.includes(nonce), 'reconstructed acknowledgement keeps nonce');
assert.equal(reconstructedAck.includes('record-map'), false, 'ignores truncated JSON metadata chunks');

const reconstructedJsonBlock = extractFinalResponseTextFromStreamEvents([
    {
        type: 'stream_chunk_text',
        ts: 20,
        text: JSON.stringify({
            type: 'patch',
            v: [{ o: 'a', p: '/s/1/value/-', v: { type: 'text', content: '```json\n{"status":"done","ack":"ACK_' } }],
        }),
    },
    {
        type: 'stream_chunk_text',
        ts: 21,
        text: JSON.stringify({
            type: 'patch',
            v: [{ o: 'x', p: '/s/1/value/1/content', v: `${nonce}","recommendation":"COMMENT","scope":"read_workspace_file ${REVIEW_FILE_CONTEXT_PATH}","findings":[],"summary_markdown":"${nonce}"}\n\`` + '``' }],
        }),
    },
], { afterTs: 19 });
assert.ok(reconstructedJsonBlock.includes('```json'), 'reconstructs text item appended with /value/-');
assert.ok(reconstructedJsonBlock.includes(`ACK_${nonce}`), 'keeps ack split across text item and content patch');

const fencedJson = extractFirstJsonBlock(makePassingReviewContextEvidence().finalResponseText);
assert.ok(fencedJson.includes('"status":"done"'), 'extracts first fenced json block');
const lastJson = extractLastJsonBlock(makePassingMultiRoundEvidence().finalResponseText);
assert.ok(lastJson.includes('"status":"done"'), 'extracts last fenced json block for multi-round streams');

const reviewContextPass = validateReviewModuleContextEvidence(makePassingReviewContextEvidence());
assert.equal(reviewContextPass.ok, true, reviewContextPass.failures.join(', '));

const reviewContextPassWithInsertedCallIdOnly = validateReviewModuleContextEvidence(makePassingReviewContextEvidence({
    executedToolCalls: [{ name: 'get_bridge_info', callId: null, args: {}, resultText: '{"tools":["get_bridge_info"]}' }],
}));
assert.equal(reviewContextPassWithInsertedCallIdOnly.ok, true, reviewContextPassWithInsertedCallIdOnly.failures.join(', '));

let reviewContextFail = validateReviewModuleContextEvidence(makePassingReviewContextEvidence({ freshChatBefore: false }));
assert.equal(reviewContextFail.ok, false, 'review context smoke requires fresh chat');
assert.ok(reviewContextFail.failures.includes('fresh_chat_missing'));

reviewContextFail = validateReviewModuleContextEvidence(makePassingReviewContextEvidence({
    executedToolCalls: [{ name: 'echo', callId, args: {}, resultText: nonce }],
}));
assert.equal(reviewContextFail.ok, false, 'review context smoke rejects wrong tool');
assert.ok(reviewContextFail.failures.includes('unexpected_tool_executed'));

reviewContextFail = validateReviewModuleContextEvidence(makePassingReviewContextEvidence({
    executedToolCalls: [{ name: 'get_bridge_info', callId: 'stale_call', args: {}, resultText: '{}' }],
}));
assert.equal(reviewContextFail.ok, false, 'review context smoke rejects explicit stale call_id');
assert.ok(reviewContextFail.failures.includes('current_call_id_missing'));

reviewContextFail = validateReviewModuleContextEvidence(makePassingReviewContextEvidence({
    finalResponseText: '```json\n{"status":"done","ack":"WRONG","recommendation":"COMMENT","scope":"bridge info smoke","findings":[],"summary_markdown":"smoke ' + nonce + '"}\n```',
}));
assert.equal(reviewContextFail.ok, false, 'review context smoke rejects ack mismatch');
assert.ok(reviewContextFail.failures.includes('final_ack_mismatch'));

assert.deepEqual(SAFE_FINAL_PREFERENCES, { autoSubmit: false, autoInsert: true, autoExecute: false }, 'safe final preferences are pinned');
assert.ok(ACK_PATTERN.test(`DONE ${nonce}`), 'ack pattern accepts DONE plus nonce text container');

let executionResult = validateEchoToolExecutions(makePassingEvidence().executedToolCalls, { nonce, callId });
assert.equal(executionResult.ok, true, 'valid single echo execution passes');

executionResult = validateEchoToolExecutions([
    { name: 'echo', callId, args: { message: nonce }, resultText: nonce },
    { name: 'echo', callId: `${callId}_2`, args: { message: nonce }, resultText: nonce },
], { nonce, callId });
assert.equal(executionResult.ok, false, 'duplicate executions fail');
assert.ok(executionResult.failures.includes('executed_count_not_one'));

executionResult = validateEchoToolExecutions([
    { name: 'comment_on_pr', callId, args: { message: nonce }, resultText: nonce },
], { nonce, callId });
assert.equal(executionResult.ok, false, 'write-capable execution fails');
assert.ok(executionResult.failures.includes('non_echo_tool_executed'));

assert.equal(validatePreferenceRestore({ ...SAFE_FINAL_PREFERENCES }).ok, true, 'safe final preference state passes');
assert.equal(validatePreferenceRestore({ autoSubmit: true, autoInsert: true, autoExecute: false }).ok, false, 'autoSubmit true after smoke fails');

const pass = validateEchoClosedLoopEvidence(makePassingEvidence());
assert.equal(pass.ok, true, pass.failures.join(', '));

assertInvalid({ preferencesBefore: null }, 'preferences_before_missing');
assertInvalid({ finallyRestoreAttempted: false }, 'finally_restore_not_attempted');
assertInvalid({ autoSubmitCount: 2 }, 'auto_submit_count_too_high');
assertInvalid({ preferencesAfter: { autoSubmit: true, autoInsert: true, autoExecute: false } }, 'preferences_after_not_safe');
assertInvalid({ exposedToolNames: ['echo', 'comment_on_pr'] }, 'write_capable_tool_exposed');
assert.equal(validateEchoClosedLoopEvidence(makePassingEvidence({ exposedToolNames: ['echo', 'read_workspace_file'] })).ok, true, 'read_workspace_file is allowed as read-only exposure');
assertInvalid({ executedToolCalls: [{ name: 'echo', callId: 'EXAMPLE_DO_NOT_EXECUTE', args: { message: nonce }, resultText: nonce }] }, 'example_call_id_executed');
assertInvalid({ executedToolCalls: [{ name: 'echo', callId: 'stale_call', args: { message: nonce }, resultText: nonce }] }, 'current_call_id_missing');
assertInvalid({ executedToolCalls: [{ name: 'echo', callId, args: { message: 'stale_nonce' }, resultText: 'stale_nonce' }] }, 'current_nonce_missing');
assertInvalid({ insertedResults: [{ name: 'echo', callId: 'stale_call', text: nonce }] }, 'inserted_result_call_id_mismatch');
assertInvalid({ insertedResults: [{ name: 'echo', callId, text: 'stale_nonce' }] }, 'inserted_result_nonce_missing');
assertInvalid({ finalResponseText: `I saw ${nonce}` }, 'final_ack_missing');
assertInvalid({ oracleSource: 'page-wide' }, 'oracle_not_turn_scoped');

const reviewFileContextPass = validateReviewModuleFileContextEvidence(makePassingReviewFileContextEvidence());
assert.equal(reviewFileContextPass.ok, true, reviewFileContextPass.failures.join(', '));

let reviewFileContextFail = validateReviewModuleFileContextEvidence(makePassingReviewFileContextEvidence({
    executedToolCalls: [{ name: 'read_workspace_file', callId, args: { path: 'AGENTS.md', max_bytes: REVIEW_FILE_CONTEXT_MAX_BYTES }, resultText: '{}' }],
}));
assert.equal(reviewFileContextFail.ok, false, 'review file-context smoke rejects wrong path');
assert.ok(reviewFileContextFail.failures.includes('unexpected_file_path'));

reviewFileContextFail = validateReviewModuleFileContextEvidence(makePassingReviewFileContextEvidence({
    insertedResults: [{ name: 'read_workspace_file', callId, text: '<function_result>{"content":"missing path"}</function_result>' }],
}));
assert.equal(reviewFileContextFail.ok, false, 'review file-context smoke requires inserted file path');
assert.ok(reviewFileContextFail.failures.includes('inserted_file_context_missing'));

reviewFileContextFail = validateReviewModuleFileContextEvidence(makePassingReviewFileContextEvidence({
    finalResponseText: '```json\n{"status":"done","ack":"ACK_' + nonce + '","recommendation":"COMMENT","scope":"limited","findings":[],"summary_markdown":"smoke ' + nonce + '"}\n```',
}));
assert.equal(reviewFileContextFail.ok, false, 'review file-context smoke requires final scope to mention tool/path');
assert.ok(reviewFileContextFail.failures.includes('final_scope_missing_tool'));

const reviewPrFileContextPass = validateReviewModulePrFileContextEvidence(makePassingReviewPrFileContextEvidence());
assert.equal(reviewPrFileContextPass.ok, true, reviewPrFileContextPass.failures.join(', '));

const multiRoundPass = validateMultiRoundEchoCountEvidence(makePassingMultiRoundEvidence());
assert.equal(multiRoundPass.ok, true, multiRoundPass.failures.join(', '));

const instructionGenericPass = validateGenericBridgeEvidence(makePassingInstructionFileAnswerEvidence(), INSTRUCTION_FILE_ANSWER_TASK);
assert.equal(instructionGenericPass.ok, true, instructionGenericPass.failures.join(', '));

const instructionPass = validateInstructionFileAnswerEvidence(makePassingInstructionFileAnswerEvidence(), INSTRUCTION_FILE_ANSWER_TASK);
assert.equal(instructionPass.ok, true, instructionPass.failures.join(', '));

let instructionFail = validateInstructionFileAnswerEvidence(makePassingInstructionFileAnswerEvidence({
    finalResponseText: '```json\n{"status":"done","nonce":"WRONG","answer":"capacitor drift","evidence_path":"' + INSTRUCTION_FILE_ANSWER_TASK.allowedPaths[0] + '","summary":"instruction smoke"}\n```',
}), INSTRUCTION_FILE_ANSWER_TASK);
assert.equal(instructionFail.ok, false, 'task validator rejects wrong top-level nonce');
assert.ok(instructionFail.failures.includes('final_nonce_mismatch'));

instructionFail = validateGenericBridgeEvidence(makePassingInstructionFileAnswerEvidence({
    controlStates: [{ status: 'continue', callIds: [] }],
    executedToolCalls: [],
    insertedResults: [],
    autoSubmitCount: 0,
}), INSTRUCTION_FILE_ANSWER_TASK);
assert.equal(instructionFail.ok, false, 'generic validator rejects continue without a tool call');
assert.ok(instructionFail.failures.includes('continue_without_tool_call'));

instructionFail = validateGenericBridgeEvidence(makePassingInstructionFileAnswerEvidence({
    executedToolCalls: [{ name: 'echo', callId: instructionCallId, args: { message: nonce }, resultText: nonce }],
}), INSTRUCTION_FILE_ANSWER_TASK);
assert.equal(instructionFail.ok, false, 'generic validator rejects tools outside task allowlist');
assert.ok(instructionFail.failures.includes('tool_not_allowed'));

instructionFail = validateGenericBridgeEvidence(makePassingInstructionFileAnswerEvidence({
    executedToolCalls: [{ name: 'read_workspace_file', callId: instructionCallId, args: { path: 'SHARED_CONTEXT.md', max_bytes: INSTRUCTION_FILE_ANSWER_TASK.maxBytes }, resultText: '{}' }],
}), INSTRUCTION_FILE_ANSWER_TASK);
assert.equal(instructionFail.ok, false, 'generic validator rejects file paths outside task allowlist');
assert.ok(instructionFail.failures.includes('unexpected_file_path'));

instructionFail = validateGenericBridgeEvidence(makePassingInstructionFileAnswerEvidence({
    executedToolCalls: [{ name: 'read_workspace_file', callId: instructionCallId, args: { path: INSTRUCTION_FILE_ANSWER_TASK.allowedPaths[0], max_bytes: INSTRUCTION_FILE_ANSWER_TASK.maxBytes + 1 }, resultText: '{}' }],
}), INSTRUCTION_FILE_ANSWER_TASK);
assert.equal(instructionFail.ok, false, 'generic validator rejects unbounded read size');
assert.ok(instructionFail.failures.includes('max_bytes_too_large'));

instructionFail = validateGenericBridgeEvidence(makePassingInstructionFileAnswerEvidence({
    exposedToolNames: ['read_workspace_file', 'comment_on_pr'],
}), INSTRUCTION_FILE_ANSWER_TASK);
assert.equal(instructionFail.ok, false, 'generic validator rejects write-capable tool exposure');
assert.ok(instructionFail.failures.includes('write_capable_tool_exposed'));

instructionFail = validateInstructionFileAnswerEvidence(makePassingInstructionFileAnswerEvidence({
    finalResponseText: '```json\n{"status":"done","nonce":"' + nonce + '","answer":"wrong","evidence_path":"' + INSTRUCTION_FILE_ANSWER_TASK.allowedPaths[0] + '","summary":"instruction smoke"}\n```',
}), INSTRUCTION_FILE_ANSWER_TASK);
assert.equal(instructionFail.ok, false, 'task validator rejects wrong answer');
assert.ok(instructionFail.failures.includes('final_answer_mismatch'));

instructionFail = validateInstructionFileAnswerEvidence(makePassingInstructionFileAnswerEvidence({
    finalResponseText: '```json\n{"status":"done","nonce":"' + nonce + '","answer":"capacitor drift","evidence_path":"SHARED_CONTEXT.md","summary":"instruction smoke"}\n```',
}), INSTRUCTION_FILE_ANSWER_TASK);
assert.equal(instructionFail.ok, false, 'task validator rejects hallucinated evidence path');
assert.ok(instructionFail.failures.includes('final_evidence_path_mismatch'));

const listCommandPass = validateListCommandEvidence(makePassingListCommandEvidence(), LIST_COMMAND_TASK);
assert.equal(listCommandPass.ok, true, listCommandPass.failures.join(', '));

let listCommandFail = validateListCommandEvidence(makePassingListCommandEvidence({
    executedToolCalls: [
        { name: 'list_command', callId: listCommandCallId, args: {}, resultText: JSON.stringify(buildListCommandResult()) },
        { name: 'Get-ChildItem', callId: `${listCommandCallId}_tree`, args: { Path: '.' }, resultText: '[]' },
    ],
}), LIST_COMMAND_TASK);
assert.equal(listCommandFail.ok, false, 'list_command smoke rejects executing file commands');
assert.ok(listCommandFail.failures.includes('executed_count_not_one'));
assert.ok(listCommandFail.failures.includes('file_command_executed'));

listCommandFail = validateListCommandEvidence(makePassingListCommandEvidence({
    executedToolCalls: [{ name: 'get_bridge_info', callId: listCommandCallId, args: {}, resultText: '{}' }],
}), LIST_COMMAND_TASK);
assert.equal(listCommandFail.ok, false, 'list_command smoke rejects reusing get_bridge_info as the called tool');
assert.ok(listCommandFail.failures.includes('unexpected_tool_executed'));

listCommandFail = validateListCommandEvidence(makePassingListCommandEvidence({
    finalResponseText: '```json\n{"status":"done","nonce":"' + nonce + '","tree_command":"ls","read_file_command":"Get-Content","search_text_command":"Select-String","workspace_root":"' + LIST_COMMAND_TASK.workspaceRoot.replaceAll('\\', '\\\\') + '","path_policy_summary":"Use workspace-relative paths only.","safety_summary":"Read-only only; no write, no exec, no network."}\n```',
}), LIST_COMMAND_TASK);
assert.equal(listCommandFail.ok, false, 'list_command smoke rejects wrong tree command');
assert.ok(listCommandFail.failures.includes('final_tree_command_mismatch'));

listCommandFail = validateListCommandEvidence(makePassingListCommandEvidence({
    finalResponseText: '```json\n{"status":"done","nonce":"' + nonce + '","tree_command":"Get-ChildItem","read_file_command":"Get-Content","search_text_command":"Select-String","workspace_root":"' + LIST_COMMAND_TASK.workspaceRoot.replaceAll('\\', '\\\\') + '","path_policy_summary":"Use absolute paths.","safety_summary":"Read-only only; no write, no exec, no network."}\n```',
}), LIST_COMMAND_TASK);
assert.equal(listCommandFail.ok, false, 'list_command smoke rejects missing workspace-relative path policy');
assert.ok(listCommandFail.failures.includes('final_path_policy_missing'));

listCommandFail = validateListCommandEvidence(makePassingListCommandEvidence({
    finalResponseText: '```json\n{"status":"done","nonce":"' + nonce + '","tree_command":"Get-ChildItem","read_file_command":"Get-Content","search_text_command":"Select-String","workspace_root":"' + LIST_COMMAND_TASK.workspaceRoot.replaceAll('\\', '\\\\') + '","path_policy_summary":"Use workspace-relative paths only.","safety_summary":"Read files."}\n```',
}), LIST_COMMAND_TASK);
assert.equal(listCommandFail.ok, false, 'list_command smoke rejects incomplete safety summary');
assert.ok(listCommandFail.failures.includes('final_safety_summary_missing'));

const workspaceTreePass = validateWorkspaceTreeEvidence(makePassingWorkspaceTreeEvidence(), WORKSPACE_TREE_TASK);
assert.equal(workspaceTreePass.ok, true, workspaceTreePass.failures.join(', '));

let workspaceTreeFail = validateWorkspaceTreeEvidence(makePassingWorkspaceTreeEvidence({
    executedToolCalls: [
        { name: WORKSPACE_TREE_TASK.toolName, callId: workspaceTreeCallId, args: { Path: '../outside', Depth: 1 }, resultText: JSON.stringify(buildWorkspaceTreeResult()) },
    ],
}), WORKSPACE_TREE_TASK);
assert.equal(workspaceTreeFail.ok, false, 'workspace_tree smoke rejects outside path request');
assert.ok(workspaceTreeFail.failures.includes('tree_path_mismatch'));

workspaceTreeFail = validateWorkspaceTreeEvidence(makePassingWorkspaceTreeEvidence({
    executedToolCalls: [
        { name: WORKSPACE_TREE_TASK.toolName, callId: workspaceTreeCallId, args: { Path: WORKSPACE_TREE_TASK.path, Depth: WORKSPACE_TREE_TASK.depth + 1 }, resultText: JSON.stringify(buildWorkspaceTreeResult()) },
    ],
}), WORKSPACE_TREE_TASK);
assert.equal(workspaceTreeFail.ok, false, 'workspace_tree smoke rejects depth above limit');
assert.ok(workspaceTreeFail.failures.includes('tree_depth_exceeds_limit'));

workspaceTreeFail = validateWorkspaceTreeEvidence(makePassingWorkspaceTreeEvidence({
    executedToolCalls: [{ name: 'get_bridge_info', callId: workspaceTreeCallId, args: {}, resultText: '{}' }],
}), WORKSPACE_TREE_TASK);
assert.equal(workspaceTreeFail.ok, false, 'workspace_tree smoke rejects wrong tool');
assert.ok(workspaceTreeFail.failures.includes('unexpected_tool_executed'));

workspaceTreeFail = validateWorkspaceTreeEvidence(makePassingWorkspaceTreeEvidence({
    finalResponseText: '```json\n{"status":"done","nonce":"' + nonce + '","command_executed":"Get-ChildItem","path":"' + WORKSPACE_TREE_TASK.path + '","entry_count":1,"entries":["alpha.txt"],"path_policy_summary":"Use workspace-relative paths only.","safety_summary":"read_only=true; write_enabled=false; exec_enabled=false; network_enabled=false"}\n```',
}), WORKSPACE_TREE_TASK);
assert.equal(workspaceTreeFail.ok, false, 'workspace_tree smoke rejects missing final entries');
assert.ok(workspaceTreeFail.failures.includes('final_entry_missing'));

workspaceTreeFail = validateWorkspaceTreeEvidence(makePassingWorkspaceTreeEvidence({
    finalResponseText: '```json\n{"status":"done","nonce":"' + nonce + '","command_executed":"Get-Content","path":"' + WORKSPACE_TREE_TASK.path + '","entry_count":3,"entries":["alpha.txt","nested","nested/beta.md"],"path_policy_summary":"Use workspace-relative paths only.","safety_summary":"read_only=true; write_enabled=false; exec_enabled=false; network_enabled=false"}\n```',
}), WORKSPACE_TREE_TASK);
assert.equal(workspaceTreeFail.ok, false, 'workspace_tree smoke rejects wrong final command');
assert.ok(workspaceTreeFail.failures.includes('final_command_mismatch'));

let multiRoundFail = validateMultiRoundEchoCountEvidence(makePassingMultiRoundEvidence({ autoSubmitCount: 2 }));
assert.equal(multiRoundFail.ok, false, 'multi-round smoke requires one result submit per tool round');
assert.ok(multiRoundFail.failures.includes('auto_submit_count_too_low'));

multiRoundFail = validateMultiRoundEchoCountEvidence(makePassingMultiRoundEvidence({
    executedToolCalls: makePassingMultiRoundEvidence().executedToolCalls.slice(0, 2),
}));
assert.equal(multiRoundFail.ok, false, 'multi-round smoke rejects too few tool calls');
assert.ok(multiRoundFail.failures.includes('executed_count_not_target'));

multiRoundFail = validateMultiRoundEchoCountEvidence(makePassingMultiRoundEvidence({
    events: [
        { type: 'submitForm', method: 'adapter', hasFunctionResult: true },
        { type: 'submitFormResult', method: 'adapter', result: true },
    ],
}));
assert.equal(multiRoundFail.ok, false, 'multi-round smoke requires send-button result handoffs');
assert.ok(multiRoundFail.failures.includes('send_button_submit_count_too_low'));

multiRoundFail = validateMultiRoundEchoCountEvidence(makePassingMultiRoundEvidence({
    finalResponseText: '```json\n{"status":"continue","nonce":"' + nonce + '","observed_count":2,"target_count":3,"summary_markdown":"' + nonce + '"}\n```',
}));
assert.equal(multiRoundFail.ok, false, 'multi-round smoke requires final done status');
assert.ok(multiRoundFail.failures.includes('final_status_not_done'));

let reviewPrFileContextFail = validateReviewModulePrFileContextEvidence(makePassingReviewPrFileContextEvidence({
    executedToolCalls: [{ name: 'read_workspace_file', callId, args: { path: REVIEW_FILE_CONTEXT_PATH, max_bytes: REVIEW_PR_FILE_CONTEXT_MAX_BYTES }, resultText: '{}' }],
}));
assert.equal(reviewPrFileContextFail.ok, false, 'review PR file-context smoke rejects wrong path');
assert.ok(reviewPrFileContextFail.failures.includes('unexpected_file_path'));

reviewPrFileContextFail = validateReviewModulePrFileContextEvidence(makePassingReviewPrFileContextEvidence({
    executedToolCalls: [{ name: 'comment_on_pr', callId, args: { body: 'no writes' }, resultText: '{}' }],
}));
assert.equal(reviewPrFileContextFail.ok, false, 'review PR file-context smoke rejects write-capable tools');
assert.ok(reviewPrFileContextFail.failures.includes('write_capable_tool_executed'));

reviewPrFileContextFail = validateReviewModulePrFileContextEvidence(makePassingReviewPrFileContextEvidence({
    executedToolCalls: [
        { name: 'read_workspace_file', callId, args: { path: REVIEW_PR_FILE_CONTEXT_PATH, max_bytes: REVIEW_PR_FILE_CONTEXT_MAX_BYTES }, resultText: '{}' },
        { name: 'read_workspace_file', callId: `${callId}_2`, args: { path: REVIEW_PR_FILE_CONTEXT_PATH, max_bytes: REVIEW_PR_FILE_CONTEXT_MAX_BYTES }, resultText: '{}' },
    ],
}));
assert.equal(reviewPrFileContextFail.ok, false, 'review PR file-context smoke rejects multiple calls');
assert.ok(reviewPrFileContextFail.failures.includes('executed_count_not_one'));

reviewPrFileContextFail = validateReviewModulePrFileContextEvidence(makePassingReviewPrFileContextEvidence({ autoSubmitCount: 0 }));
assert.equal(reviewPrFileContextFail.ok, false, 'review PR file-context smoke requires result submit handoff');
assert.ok(reviewPrFileContextFail.failures.includes('auto_submit_missing'));

reviewPrFileContextFail = validateReviewModulePrFileContextEvidence(makePassingReviewPrFileContextEvidence({
    events: [
        { type: 'submitForm', method: 'adapter', hasFunctionResult: true },
        { type: 'submitFormResult', method: 'adapter', result: true },
    ],
}));
assert.equal(reviewPrFileContextFail.ok, false, 'review PR file-context smoke requires send-button DOM handoff');
assert.ok(reviewPrFileContextFail.failures.includes('send_button_submit_missing'));
assert.ok(reviewPrFileContextFail.failures.includes('send_button_submit_result_missing'));

reviewPrFileContextFail = validateReviewModulePrFileContextEvidence(makePassingReviewPrFileContextEvidence({
    events: [
        { type: 'submitForm', method: 'send-button', hasFunctionResult: true },
        { type: 'submitButtonClickFallbackToAdapter', result: { ok: false } },
        { type: 'submitFormResult', method: 'adapter', result: true },
    ],
}));
assert.equal(reviewPrFileContextFail.ok, false, 'review PR file-context smoke rejects adapter fallback after send-button failure');
assert.ok(reviewPrFileContextFail.failures.includes('send_button_fallback_to_adapter'));

reviewPrFileContextFail = validateReviewModulePrFileContextEvidence(makePassingReviewPrFileContextEvidence({
    finalResponseText: '```json\n{"status":"done","ack":"ACK_' + nonce + '","recommendation":"COMMENT","scope":"read_workspace_file only","findings":[],"summary_markdown":"review-pr-file smoke ' + nonce + '"}\n```',
}));
assert.equal(reviewPrFileContextFail.ok, false, 'review PR file-context smoke requires final scope to mention target file');
assert.ok(reviewPrFileContextFail.failures.includes('final_scope_missing_path'));

reviewPrFileContextFail = validateReviewModulePrFileContextEvidence(makePassingReviewPrFileContextEvidence({ writeBackAttempted: true }));
assert.equal(reviewPrFileContextFail.ok, false, 'review PR file-context smoke rejects write-back attempts');
assert.ok(reviewPrFileContextFail.failures.includes('write_back_attempted'));

const preRestoreRuntimeComplete = validateReviewModulePrFileContextEvidence(makePassingReviewPrFileContextEvidence({
    preferencesAfter: null,
    finallyRestoreAttempted: false,
}));
assert.equal(preRestoreRuntimeComplete.ok, false, 'pre-restore runtime completion still fails full validation');
assert.equal(isRuntimeCompleteBeforeFinalRestore(preRestoreRuntimeComplete), true, 'pre-restore-only failures can stop the polling loop');

const preRestoreRuntimeIncomplete = validateReviewModulePrFileContextEvidence(makePassingReviewPrFileContextEvidence({
    preferencesAfter: null,
    finallyRestoreAttempted: false,
    finalResponseText: '',
}));
assert.equal(isRuntimeCompleteBeforeFinalRestore(preRestoreRuntimeIncomplete), false, 'missing final json cannot stop the polling loop');

const preRestoreDoubleSubmit = validateReviewModulePrFileContextEvidence(makePassingReviewPrFileContextEvidence({
    preferencesAfter: null,
    finallyRestoreAttempted: false,
    autoSubmitCount: 2,
}));
assert.equal(isRuntimeCompleteBeforeFinalRestore(preRestoreDoubleSubmit), false, 'double submit cannot stop as runtime-complete');

console.log('notion echo smoke contract tests passed');
