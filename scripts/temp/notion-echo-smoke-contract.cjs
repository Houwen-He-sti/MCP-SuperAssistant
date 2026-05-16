const fs = require('fs');
const path = require('path');

const ACK_PATTERN = /(?:^|\b)(DONE|ACK|COMPLETE)\b/i;

const SHARED_TRUNK_PATH = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'ai-web-agent-mcp',
    'src',
    'ai_web_agent_mcp',
    'prompts',
    'trunk.md',
);

const REVIEW_MODULE_TEMPLATE_PATH = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'ai-web-agent-mcp',
    'src',
    'ai_web_agent_mcp',
    'prompts',
    'modules',
    'review.md.j2',
);

const SAFE_FINAL_PREFERENCES = Object.freeze({
    autoSubmit: false,
    autoInsert: true,
    autoExecute: false,
});

const WRITE_CAPABLE_TOOL_NAMES = new Set([
    'comment_on_pr',
    'submit_pr_review',
    'merge_pr',
    'git_commit',
    'git_push',
    'create_pr',
    'create_issue',
    'update_issue',
    'post_mailbox_message',
]);

const REVIEW_FILE_CONTEXT_PATH = 'SHARED_CONTEXT.md';
const REVIEW_FILE_CONTEXT_MAX_BYTES = 700;
const REVIEW_PR_FILE_CONTEXT_PATH = 'ai-web-agent-mcp/tests/test_tool_card_allowlist.py';
const REVIEW_PR_FILE_CONTEXT_MAX_BYTES = 1200;
const INSTRUCTION_FILE_ANSWER_PATH = 'MCP-SuperAssistant/scripts/temp/instruction-smoke-fixture.txt';
const INSTRUCTION_FILE_ANSWER_MAX_BYTES = 600;
const INSTRUCTION_FILE_ANSWER_MARKER = 'INSTRUCTION_SMOKE_MARKER: CAPACITOR_DRIFT_20260516';
const INSTRUCTION_FILE_ANSWER_EXPECTED_ANSWER = 'capacitor drift';
const INSTRUCTION_FILE_ANSWER_TASK = Object.freeze({
    kind: 'instruction_file_answer',
    allowedTools: Object.freeze(['read_workspace_file']),
    allowedPaths: Object.freeze([INSTRUCTION_FILE_ANSWER_PATH]),
    maxBytes: INSTRUCTION_FILE_ANSWER_MAX_BYTES,
    maxToolCalls: 1,
    marker: INSTRUCTION_FILE_ANSWER_MARKER,
    expectedAnswer: INSTRUCTION_FILE_ANSWER_EXPECTED_ANSWER,
});
const LIST_COMMAND_WORKSPACE_ROOT = 'C:\\Users\\houwen\\Documents\\VS Code Dir';
const LIST_COMMAND_TASK = Object.freeze({
    kind: 'list_command',
    allowedTools: Object.freeze(['list_command']),
    commandNames: Object.freeze(['Get-ChildItem', 'Get-Content', 'Select-String']),
    workspaceRoot: LIST_COMMAND_WORKSPACE_ROOT,
});
const WORKSPACE_TREE_FIXTURE_PATH = 'MCP-SuperAssistant/scripts/temp/tree-smoke-fixture';
const WORKSPACE_TREE_TASK = Object.freeze({
    kind: 'workspace_tree',
    allowedTools: Object.freeze(['get_child_item']),
    toolName: 'get_child_item',
    command: 'Get-ChildItem',
    workspaceRoot: LIST_COMMAND_WORKSPACE_ROOT,
    path: WORKSPACE_TREE_FIXTURE_PATH,
    depth: 2,
    maxResults: 20,
    expectedEntries: Object.freeze(['alpha.txt', 'nested', 'nested/beta.md']),
});

const NOTION_AI_ROUTE_RE = /notion\.so\/(?:chat|ai)(?:[/?#]|$)/;

function isNotionAiRouteUrl(url) {
    return NOTION_AI_ROUTE_RE.test(String(url || ''));
}

function isFreshNotionChatUrl(url) {
    const value = String(url || '');
    if (!isNotionAiRouteUrl(value)) return false;
    try {
        const parsed = new URL(value);
        return parsed.searchParams.get('t') === 'new' || !parsed.searchParams.has('t');
    } catch {
        return false;
    }
}

function loadSharedBridgeTrunk() {
    const trunk = fs.readFileSync(SHARED_TRUNK_PATH, 'utf8').trim();
    const requiredMarkers = [
        'SuperAssistant Bridge',
        '结果作为下一条用户消息回贴给你',
        '桥接器协作型',
        '工具结果输入',
        '```jsonl',
    ];
    const missing = requiredMarkers.filter((marker) => !trunk.includes(marker));
    if (missing.length > 0) {
        throw new Error(`Shared bridge trunk is missing required markers: ${missing.join(', ')}`);
    }
    return trunk;
}

function buildEchoClosedLoopPrompt({ nonce, callId, trunk = loadSharedBridgeTrunk() }) {
    if (!nonce || !callId) throw new Error('nonce and callId are required');
    return [
        trunk.trim(),
        '',
        '---',
        '',
        '# 当前任务：Echo Closed-Loop Smoke',
        '',
        'You are participating in a read-only MCP bridge smoke test inside Notion AI.',
        'Output exactly one current JSONL tool call for echo, then wait for the tool result.',
        'After the result is inserted, reply with DONE, ACK, or COMPLETE plus the current nonce.',
        '',
        'Example only. Do not execute this example call_id:',
        '```jsonl',
        '{"type":"function_call_start","name":"echo","call_id":"EXAMPLE_DO_NOT_EXECUTE"}',
        '{"type":"parameter","key":"message","value":"EXAMPLE_DO_NOT_EXECUTE"}',
        '{"type":"function_call_end","call_id":"EXAMPLE_DO_NOT_EXECUTE"}',
        '```',
        '',
        'Current tool call:',
        '```jsonl',
        `{"type":"function_call_start","name":"echo","call_id":"${callId}"}`,
        `{"type":"parameter","key":"message","value":"${nonce}"}`,
        `{"type":"function_call_end","call_id":"${callId}"}`,
        '```',
        '',
        `Current nonce: ${nonce}`,
    ].join('\n');
}

function buildMultiRoundEchoCountPrompt({ nonce, callIds, targetCount = callIds && callIds.length, trunk = loadSharedBridgeTrunk() }) {
    if (!nonce || !Array.isArray(callIds) || callIds.length === 0) {
        throw new Error('nonce and callIds are required');
    }
    const count = Number(targetCount);
    if (!Number.isInteger(count) || count < 1 || count !== callIds.length) {
        throw new Error('targetCount must equal callIds.length');
    }
    const callPlan = callIds.map((callId, index) => {
        const step = index + 1;
        return `- count ${step}: call_id ${callId}; echo.message "${nonce} COUNT_${step}_OF_${count}"`;
    });
    return [
        trunk.trim(),
        '',
        '---',
        '',
        '# 当前任务：Multi-Round Echo Count Smoke',
        '',
        'You are participating in a read-only MCP bridge smoke test inside Notion AI.',
        'Goal: decide whether you have enough bridge results to finish. The bridge only transports your chosen tool requests and returns results as user messages; it does not decide the next step for you.',
        '',
        'Decision algorithm:',
        '- Count only successful echo results whose message contains the current nonce and `COUNT_i_OF_N`.',
        '- If observed_count is less than target_count, output exactly one fenced json block with `status:"continue"`, then exactly one fenced jsonl block calling echo for next_count = observed_count + 1.',
        '- If observed_count is equal to target_count, output exactly one fenced json block with `status:"done"` and no jsonl tool call.',
        '- Never output more than one tool call in the same assistant response.',
        '- Do not call write-capable tools.',
        '',
        `Current nonce: ${nonce}`,
        `Target count: ${count}`,
        'Call identifiers and messages:',
        ...callPlan,
        '',
        'The first response starts with observed_count 0, so request count 1.',
        'The final done JSON must include `status`, `nonce`, `observed_count`, `target_count`, and `summary_markdown` containing the nonce.',
    ].join('\n');
}

function buildInstructionFileAnswerPrompt({ nonce, callId, task = INSTRUCTION_FILE_ANSWER_TASK, trunk = loadSharedBridgeTrunk() }) {
    if (!nonce || !callId) throw new Error('nonce and callId are required');
    const allowedPath = task.allowedPaths[0];
    return [
        trunk.trim(),
        '',
        '---',
        '',
        '# 当前任务：Instruction File Answer Smoke',
        '',
        'Follow this actual instruction using the bridge only when local file context is needed.',
        'Instruction: determine the maintenance condition named in the allowed local file.',
        'Do not guess from prior context. If you need the local file, choose `continue` and call `read_workspace_file`.',
        '',
        'Generic control contract:',
        '- If local context is needed, output exactly one fenced json block with `status:"continue"` and the current nonce, then exactly one fenced jsonl block calling `read_workspace_file`.',
        '- If the answer is known from current context, output only the final fenced json block.',
        '- The final response must be exactly one fenced json block and no prose outside it.',
        '- Do not call write-capable tools.',
        '',
        `Current nonce: ${nonce}`,
        `Current call_id: ${callId}`,
        `Allowed file path: ${allowedPath}`,
        `Maximum bytes: ${task.maxBytes}`,
        '',
        'Final JSON schema:',
        '```json',
        '{"status":"done","nonce":"CURRENT_NONCE","answer":"...","evidence_path":"...","summary":"..."}',
        '```',
        '',
        'If you use the bridge, the tool call must be:',
        '```jsonl',
        `{"type":"function_call_start","name":"read_workspace_file","call_id":"${callId}"}`,
        `{"type":"parameter","key":"path","value":"${allowedPath}"}`,
        `{"type":"parameter","key":"max_bytes","value":${task.maxBytes}}`,
        `{"type":"function_call_end","call_id":"${callId}"}`,
        '```',
    ].join('\n');
}

function buildListCommandResult(task = LIST_COMMAND_TASK) {
    return {
        status: 'ok',
        workspace_root: task.workspaceRoot,
        path_policy: 'workspace_relative only; forbid .., absolute_path, drive_path, home_path, unc_path, url, outside_workspace',
        safety: 'read_only=true; write_enabled=false; exec_enabled=false; network_enabled=false',
        commands: {
            tree: 'Get-ChildItem',
            read_file: 'Get-Content',
            search_text: 'Select-String',
        },
    };
}

function buildListCommandPrompt({ nonce, callId, task = LIST_COMMAND_TASK, trunk = loadSharedBridgeTrunk() }) {
    if (!nonce || !callId) throw new Error('nonce and callId are required');
    return [
        trunk.trim(),
        '',
        '---',
        '',
        '# 当前任务：List Command Discovery Smoke',
        '',
        'You need to help the user understand local workspace file-system capabilities.',
        'Rules:',
        '1. You cannot assume you know which local commands are available.',
        '2. First output one `continue` JSON block, then call `list_command` exactly once.',
        '3. After the command list is returned, do not execute any other command.',
        '4. Based only on the returned command list, identify which command gets a file tree, which reads a file, which searches text, and what path/safety limits apply.',
        '5. Do not call Get-ChildItem, Get-Content, Select-String, write tools, exec tools, Git tools, or network tools in this smoke.',
        '',
        `Current nonce: ${nonce}`,
        `Current call_id: ${callId}`,
        `Workspace root to verify from tool result: ${task.workspaceRoot}`,
        '',
        'Expected first response:',
        '```json',
        `{"status":"continue","nonce":"${nonce}","reason":"need current local command discovery"}`,
        '```',
        '```jsonl',
        `{"type":"function_call_start","name":"list_command","call_id":"${callId}"}`,
        '{"type":"description","text":"查询当前本地 Bridge 支持的文件系统命令"}',
        `{"type":"function_call_end","call_id":"${callId}"}`,
        '```',
        '',
        'Final JSON schema after the tool result is inserted:',
        '```json',
        '{"status":"done","nonce":"CURRENT_NONCE","tree_command":"...","read_file_command":"...","search_text_command":"...","workspace_root":"...","path_policy_summary":"...","safety_summary":"..."}',
        '```',
        'The final response must be exactly one fenced JSON block and no prose outside it.',
    ].join('\n');
}

function resolveWorkspaceRelativePath(relativePath, workspaceRoot = LIST_COMMAND_WORKSPACE_ROOT) {
    const rawPath = String(relativePath || '');
    const normalized = rawPath.replaceAll('\\', '/');
    const forbidden = !rawPath
        || rawPath.includes('\0')
        || normalized.includes('..')
        || normalized.startsWith('~')
        || normalized.startsWith('//')
        || /^[a-z]+:\/\//i.test(normalized)
        || /^[a-z]:/i.test(rawPath)
        || path.isAbsolute(rawPath);
    if (forbidden) throw new Error(`Unsafe workspace-relative path: ${rawPath}`);
    const root = path.resolve(workspaceRoot);
    const resolved = path.resolve(root, rawPath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Path escapes workspace: ${rawPath}`);
    }
    return resolved;
}

function ensureWorkspaceTreeFixture(task = WORKSPACE_TREE_TASK) {
    const fixtureRoot = resolveWorkspaceRelativePath(task.path, task.workspaceRoot);
    fs.mkdirSync(path.join(fixtureRoot, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'alpha.txt'), 'TREE_SMOKE_ALPHA\n', 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'nested', 'beta.md'), 'TREE_SMOKE_BETA\n', 'utf8');
    return fixtureRoot;
}

function collectWorkspaceTreeEntries(rootPath, maxDepth, maxResults) {
    const entries = [];
    function visit(currentPath, depth) {
        if (entries.length >= maxResults) return;
        const children = fs.readdirSync(currentPath, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        children.forEach((child) => {
            if (entries.length >= maxResults) return;
            const fullPath = path.join(currentPath, child.name);
            const relative = path.relative(rootPath, fullPath).replaceAll(path.sep, '/');
            entries.push({ path: relative, type: child.isDirectory() ? 'directory' : 'file' });
            if (child.isDirectory() && depth < maxDepth) visit(fullPath, depth + 1);
        });
    }
    visit(rootPath, 1);
    return entries;
}

function buildWorkspaceTreeResult(task = WORKSPACE_TREE_TASK) {
    const rootPath = ensureWorkspaceTreeFixture(task);
    return {
        status: 'ok',
        command: task.command,
        workspace_root: task.workspaceRoot,
        path: task.path,
        depth: task.depth,
        max_results: task.maxResults,
        path_policy: 'workspace_relative only; forbid .., absolute_path, drive_path, home_path, unc_path, url, outside_workspace',
        safety: 'read_only=true; write_enabled=false; exec_enabled=false; network_enabled=false',
        entries: collectWorkspaceTreeEntries(rootPath, task.depth, task.maxResults),
    };
}

function buildWorkspaceTreePrompt({ nonce, callId, task = WORKSPACE_TREE_TASK, trunk = loadSharedBridgeTrunk() }) {
    if (!nonce || !callId) throw new Error('nonce and callId are required');
    return [
        trunk.trim(),
        '',
        '---',
        '',
        '# 当前任务：Workspace Tree Smoke',
        '',
        'Use exactly one bounded read-only workspace tree operation. This smoke validates the next local file-handling slice after command discovery.',
        'Rules:',
        `1. Output one \`continue\` JSON block, then call \`${task.toolName}\` exactly once.`,
        `2. The tool is the safe bridge equivalent of \`${task.command}\`, not arbitrary command execution.`,
        `3. Use only path \`${task.path}\` and depth ${task.depth}.`,
        '4. Do not call write tools, exec tools, Git tools, network tools, or any other file command.',
        '5. After the tree result is returned, produce exactly one final fenced JSON block.',
        '',
        `Current nonce: ${nonce}`,
        `Current call_id: ${callId}`,
        `Workspace root: ${task.workspaceRoot}`,
        '',
        'Expected first response:',
        '```json',
        `{"status":"continue","nonce":"${nonce}","reason":"need bounded workspace tree"}`,
        '```',
        '```jsonl',
        `{"type":"function_call_start","name":"${task.toolName}","call_id":"${callId}"}`,
        `{"type":"parameter","key":"Path","value":"${task.path}"}`,
        `{"type":"parameter","key":"Depth","value":${task.depth}}`,
        `{"type":"function_call_end","call_id":"${callId}"}`,
        '```',
        '',
        'Final JSON schema after the tool result is inserted:',
        '```json',
        '{"status":"done","nonce":"CURRENT_NONCE","command_executed":"Get-ChildItem","path":"...","entry_count":0,"entries":["..."],"path_policy_summary":"...","safety_summary":"..."}',
        '```',
        'The final response must be exactly one fenced JSON block and no prose outside it.',
    ].join('\n');
}

function buildReviewModuleContextPrompt({ ack, nonce, callId, trunk = loadSharedBridgeTrunk() }) {
    if (!ack || !nonce || !callId) throw new Error('ack, nonce and callId are required');
    const template = fs.readFileSync(REVIEW_MODULE_TEMPLATE_PATH, 'utf8');
    const prContext = [
        'This is a read-only MCP bridge context smoke, not a real PR review.',
        `Current ACK marker: ${ack}`,
        `Current nonce: ${nonce}`,
        `Current call_id: ${callId}`,
        '',
        'Required first response:',
        '- Output `continue` as the first fenced json block with the current ACK marker.',
        '- Then output exactly one fenced jsonl block calling `get_bridge_info` with the current call_id.',
        '- Do not call write-capable tools.',
        '',
        'Required response after the bridge result is inserted:',
        '- Output exactly one fenced json block with `status=done`, the same ACK marker, `recommendation=COMMENT`, `findings=[]`, and `summary_markdown` containing the current nonce.',
        '- Do not output prose outside the fenced json block.',
    ].join('\n');
    const body = template
        .replaceAll('{{ ack_marker }}', ack)
        .replace('{{ pr_context }}', prContext);
    return `${trunk.trim()}\n\n---\n\n${body.trim()}`;
}

function buildReviewModuleFileContextPrompt({ ack, nonce, callId, trunk = loadSharedBridgeTrunk() }) {
    if (!ack || !nonce || !callId) throw new Error('ack, nonce and callId are required');
    const template = fs.readFileSync(REVIEW_MODULE_TEMPLATE_PATH, 'utf8');
    const prContext = [
        'This is a read-only MCP bridge file-context smoke, not a real PR review.',
        `Current ACK marker: ${ack}`,
        `Current nonce: ${nonce}`,
        `Current call_id: ${callId}`,
        '',
        'Required first response:',
        '- Output `continue` as the first fenced json block with the current ACK marker.',
        `- Then output exactly one fenced jsonl block calling \`read_workspace_file\` with path \`${REVIEW_FILE_CONTEXT_PATH}\`, max_bytes ${REVIEW_FILE_CONTEXT_MAX_BYTES}, and the current call_id.`,
        '- Do not call write-capable tools.',
        '',
        'Required response after the bridge result is inserted:',
        '- Output exactly one fenced json block with `status=done`, the same ACK marker, `recommendation=COMMENT`, and `summary_markdown` containing the current nonce.',
        '- `scope` must mention `read_workspace_file` and the requested path.',
        '- `findings` may be empty; this smoke validates read-only context retrieval, not review quality.',
        '- Do not output prose outside the fenced json block.',
    ].join('\n');
    const body = template
        .replaceAll('{{ ack_marker }}', ack)
        .replace('{{ pr_context }}', prContext);
    return `${trunk.trim()}\n\n---\n\n${body.trim()}`;
}

function buildReviewModulePrFileContextPrompt({ ack, nonce, callId, trunk = loadSharedBridgeTrunk() }) {
    if (!ack || !nonce || !callId) throw new Error('ack, nonce and callId are required');
    const template = fs.readFileSync(REVIEW_MODULE_TEMPLATE_PATH, 'utf8');
    const prContext = [
        'This is a PR-like read-only MCP bridge smoke, not a real PR review.',
        `Current ACK marker: ${ack}`,
        `Current nonce: ${nonce}`,
        `Current call_id: ${callId}`,
        '',
        'Synthetic PR context:',
        '- Repo: Houwen-He-sti/VSCode-Dir',
        '- PR URL: https://github.com/Houwen-He-sti/VSCode-Dir/pull/SMOKE',
        `- Changed file: ${REVIEW_PR_FILE_CONTEXT_PATH}`,
        '- Review focus: confirm the target file is readable through the bridge and produce parser-grade ReviewModule output.',
        '',
        'Required first response:',
        '- Output `continue` as the first fenced json block with the current ACK marker.',
        `- Then output exactly one fenced jsonl block calling \`read_workspace_file\` with path \`${REVIEW_PR_FILE_CONTEXT_PATH}\`, max_bytes ${REVIEW_PR_FILE_CONTEXT_MAX_BYTES}, and the current call_id.`,
        '- Do not call write-capable tools. Do not call GitHub write-back tools.',
        '',
        'Required response after the bridge result is inserted:',
        '- Output exactly one fenced json block with `status=done`, the same ACK marker, `recommendation=COMMENT`, and `summary_markdown` containing the current nonce.',
        '- `scope` must mention `read_workspace_file` and the target changed file path.',
        '- `findings` may be empty; this smoke validates review-relevant read-only file-context retrieval, not review quality.',
        '- Do not output prose outside the fenced json block.',
    ].join('\n');
    const body = template
        .replaceAll('{{ ack_marker }}', ack)
        .replace('{{ pr_context }}', prContext);
    return `${trunk.trim()}\n\n---\n\n${body.trim()}`;
}

function validatePreferenceRestore(preferencesAfter) {
    const failures = [];
    if (!preferencesAfter
        || preferencesAfter.autoSubmit !== SAFE_FINAL_PREFERENCES.autoSubmit
        || preferencesAfter.autoInsert !== SAFE_FINAL_PREFERENCES.autoInsert
        || preferencesAfter.autoExecute !== SAFE_FINAL_PREFERENCES.autoExecute) {
        failures.push('preferences_after_not_safe');
    }
    return { ok: failures.length === 0, failures };
}

function isRuntimeCompleteBeforeFinalRestore(validation) {
    const failures = Array.isArray(validation?.failures) ? validation.failures : [];
    const pendingRestoreFailures = new Set(['finally_restore_not_attempted', 'preferences_after_not_safe']);
    return failures.length > 0 && failures.every((failure) => pendingRestoreFailures.has(failure));
}

function containsNonce(value, nonce) {
    if (!nonce) return false;
    if (value == null) return false;
    return JSON.stringify(value).includes(nonce);
}

function containsLiteral(value, literal) {
    if (!literal) return false;
    if (value == null) return false;
    const raw = String(value);
    const encoded = JSON.stringify(value);
    const escapedOnce = String(literal).replaceAll('\\', '\\\\');
    const escapedTwice = escapedOnce.replaceAll('\\', '\\\\');
    return [raw, encoded].some((candidate) => candidate.includes(literal) || candidate.includes(escapedOnce) || candidate.includes(escapedTwice));
}

function isWriteCapableTool(name) {
    return WRITE_CAPABLE_TOOL_NAMES.has(String(name || ''));
}

function validateCurrentResultSendButtonSubmit(data, failures) {
    const events = Array.isArray(data.events) ? data.events : [];
    const submitEvents = events.filter((event) => event?.type === 'submitForm');
    const submitResults = events.filter((event) => event?.type === 'submitFormResult');
    if (!submitEvents.some((event) => event.method === 'send-button' && event.hasFunctionResult === true)) {
        failures.push('send_button_submit_missing');
    }
    if (!submitResults.some((event) => event.method === 'send-button' && event.result === true)) {
        failures.push('send_button_submit_result_missing');
    }
    if (events.some((event) => event?.type === 'submitButtonClickFallbackToAdapter')) {
        failures.push('send_button_fallback_to_adapter');
    }
}

function extractFinalResponseTextFromStreamEvents(streamEvents, options = {}) {
    const afterTs = Number(options.afterTs || 0);
    const chunks = [];
    const events = Array.isArray(streamEvents) ? streamEvents : [];
    for (const event of events) {
        if (event?.type !== 'stream_chunk_text') continue;
        if (afterTs && Number(event.ts || 0) < afterTs) continue;
        const text = String(event.text || '');
        try {
            const parsed = JSON.parse(text);
            if (parsed?.type === 'patch' && Array.isArray(parsed.v)) {
                for (const op of parsed.v) {
                    if (op?.v?.type === 'agent-inference' && Array.isArray(op.v.value)) {
                        for (const item of op.v.value) {
                            if (typeof item?.content === 'string') chunks.push(item.content);
                        }
                    } else if (op?.v?.type === 'text' && typeof op.v.content === 'string') {
                        chunks.push(op.v.content);
                    } else if (typeof op?.v === 'string' && /\/value\/\d+\/content$/.test(String(op.p || ''))) {
                        chunks.push(op.v);
                    }
                }
            }
        } catch {
            if (text && !text.trim().startsWith('{')) chunks.push(text);
        }
    }
    return chunks.join('');
}

function validateEchoToolExecutions(executions, { nonce, callId }) {
    const failures = [];
    const calls = Array.isArray(executions) ? executions : [];
    if (calls.length !== 1) failures.push('executed_count_not_one');

    for (const call of calls) {
        if (call?.name !== 'echo') failures.push('non_echo_tool_executed');
        if (isWriteCapableTool(call?.name)) failures.push('write_capable_tool_executed');
        if (call?.callId === 'EXAMPLE_DO_NOT_EXECUTE') failures.push('example_call_id_executed');
        if (call?.callId !== callId) failures.push('current_call_id_missing');
        if (!containsNonce({ args: call?.args, resultText: call?.resultText, result: call?.result }, nonce)) {
            failures.push('current_nonce_missing');
        }
    }

    return { ok: failures.length === 0, failures: [...new Set(failures)] };
}

function validateInsertedResult(insertedResults, { nonce, callId }) {
    const failures = [];
    const results = Array.isArray(insertedResults) ? insertedResults : [];
    if (results.length < 1) failures.push('inserted_result_missing');
    const current = results.find((result) => result?.callId === callId || containsNonce(result?.text, callId));
    if (!current) failures.push('inserted_result_call_id_mismatch');
    if (!current || !containsNonce(current, nonce)) failures.push('inserted_result_nonce_missing');
    return failures;
}

function validateEchoClosedLoopEvidence(evidence) {
    const failures = [];
    const data = evidence || {};
    const nonce = data.nonce;
    const callId = data.callId;

    if (!data.preferencesBefore) failures.push('preferences_before_missing');
    if (data.finallyRestoreAttempted !== true) failures.push('finally_restore_not_attempted');
    if (Number(data.autoSubmitCount || 0) > 1) failures.push('auto_submit_count_too_high');

    failures.push(...validatePreferenceRestore(data.preferencesAfter).failures);

    const exposedTools = Array.isArray(data.exposedToolNames) ? data.exposedToolNames : [];
    if (exposedTools.some(isWriteCapableTool)) failures.push('write_capable_tool_exposed');

    failures.push(...validateEchoToolExecutions(data.executedToolCalls, { nonce, callId }).failures);
    failures.push(...validateInsertedResult(data.insertedResults, { nonce, callId }));

    const finalResponseText = String(data.finalResponseText || '');
    if (!ACK_PATTERN.test(finalResponseText)) failures.push('final_ack_missing');
    if (!finalResponseText.includes(String(nonce || ''))) failures.push('final_nonce_missing');
    if (data.oracleSource !== 'turn-scoped') failures.push('oracle_not_turn_scoped');

    const uniqueFailures = [...new Set(failures)];
    return { ok: uniqueFailures.length === 0, failures: uniqueFailures };
}

function extractFirstJsonBlock(text) {
    const match = /```json\s*\n([\s\S]*?)\n?```/i.exec(String(text || ''));
    return match ? match[1].trim() : null;
}

function extractJsonBlocks(text) {
    const blocks = [];
    const re = /```json\s*\n([\s\S]*?)\n?```/gi;
    let match;
    while ((match = re.exec(String(text || ''))) !== null) {
        blocks.push(match[1].trim());
    }
    return blocks;
}

function extractLastJsonBlock(text) {
    const blocks = extractJsonBlocks(text);
    return blocks.length > 0 ? blocks[blocks.length - 1] : null;
}

function validateMultiRoundSendButtonSubmits(data, failures, targetCount) {
    const events = Array.isArray(data.events) ? data.events : [];
    const submitEvents = events.filter((event) => event?.type === 'submitForm');
    const submitResults = events.filter((event) => event?.type === 'submitFormResult');
    const sendButtonSubmits = submitEvents.filter((event) => event.method === 'send-button' && event.hasFunctionResult === true);
    const sendButtonResults = submitResults.filter((event) => event.method === 'send-button' && event.result === true);
    if (sendButtonSubmits.length < targetCount) failures.push('send_button_submit_count_too_low');
    if (sendButtonResults.length < targetCount) failures.push('send_button_submit_result_count_too_low');
    if (events.some((event) => event?.type === 'submitButtonClickFallbackToAdapter')) {
        failures.push('send_button_fallback_to_adapter');
    }
}

function validateMultiRoundEchoCountEvidence(evidence) {
    const failures = [];
    const data = evidence || {};
    const nonce = data.nonce;
    const targetCount = Number(data.targetCount || 0);
    const expectedCallIds = Array.isArray(data.expectedCallIds) ? data.expectedCallIds : [];

    if (!Number.isInteger(targetCount) || targetCount < 1) failures.push('target_count_invalid');
    if (expectedCallIds.length !== targetCount) failures.push('expected_call_ids_count_mismatch');

    if (data.freshChatBefore !== true) failures.push('fresh_chat_missing');
    if (!data.preferencesBefore) failures.push('preferences_before_missing');
    if (data.finallyRestoreAttempted !== true) failures.push('finally_restore_not_attempted');
    if (Number(data.autoSubmitCount || 0) < targetCount) failures.push('auto_submit_count_too_low');
    if (Number(data.autoSubmitCount || 0) > targetCount) failures.push('auto_submit_count_too_high');
    validateMultiRoundSendButtonSubmits(data, failures, targetCount);
    failures.push(...validatePreferenceRestore(data.preferencesAfter).failures);

    const exposedTools = Array.isArray(data.exposedToolNames) ? data.exposedToolNames : [];
    if (exposedTools.some(isWriteCapableTool)) failures.push('write_capable_tool_exposed');

    const calls = Array.isArray(data.executedToolCalls) ? data.executedToolCalls : [];
    if (calls.length !== targetCount) failures.push('executed_count_not_target');
    calls.forEach((call, index) => {
        const step = index + 1;
        const expectedCallId = expectedCallIds[index];
        const expectedMessage = `${nonce} COUNT_${step}_OF_${targetCount}`;
        if (call?.name !== 'echo') failures.push('non_echo_tool_executed');
        if (isWriteCapableTool(call?.name)) failures.push('write_capable_tool_executed');
        if (expectedCallId && call?.callId && call.callId !== expectedCallId) failures.push('current_call_id_missing');
        if (!containsNonce(call?.args, expectedMessage)) failures.push('current_count_message_missing');
        if (!containsNonce({ resultText: call?.resultText, result: call?.result }, expectedMessage)) failures.push('current_count_result_missing');
    });

    const results = Array.isArray(data.insertedResults) ? data.insertedResults : [];
    if (results.length < targetCount) failures.push('inserted_result_count_too_low');
    expectedCallIds.forEach((expectedCallId, index) => {
        const step = index + 1;
        const expectedMessage = `${nonce} COUNT_${step}_OF_${targetCount}`;
        const current = results.find((result) => result?.callId === expectedCallId || containsNonce(result?.text, expectedCallId));
        if (!current) failures.push('inserted_result_call_id_mismatch');
        if (!current || !containsNonce(current, expectedMessage)) failures.push('inserted_result_count_message_missing');
    });

    const streamStarts = Array.isArray(data.streamEvents) ? data.streamEvents.filter((event) => event?.type === 'stream_start') : [];
    if (streamStarts.length > 0 && streamStarts.length < targetCount + 1) failures.push('stream_start_count_too_low');

    const finalResponseText = String(data.finalResponseText || '');
    const finalJson = extractLastJsonBlock(finalResponseText);
    if (!finalJson) {
        failures.push('final_json_missing');
    } else {
        try {
            const payload = JSON.parse(finalJson);
            if (payload.status !== 'done') failures.push('final_status_not_done');
            if (payload.nonce !== nonce) failures.push('final_nonce_mismatch');
            if (Number(payload.observed_count) !== targetCount) failures.push('final_observed_count_mismatch');
            if (Number(payload.target_count) !== targetCount) failures.push('final_target_count_mismatch');
            if (!String(payload.summary_markdown || '').includes(String(nonce || ''))) failures.push('final_nonce_missing');
        } catch {
            failures.push('final_json_invalid');
        }
    }

    if (data.oracleSource !== 'turn-scoped') failures.push('oracle_not_turn_scoped');

    const uniqueFailures = [...new Set(failures)];
    return { ok: uniqueFailures.length === 0, failures: uniqueFailures };
}

function validateSendButtonHandoffs(data, failures, minCount) {
    const events = Array.isArray(data.events) ? data.events : [];
    const submitEvents = events.filter((event) => event?.type === 'submitForm');
    const submitResults = events.filter((event) => event?.type === 'submitFormResult');
    const sendButtonSubmits = submitEvents.filter((event) => event.method === 'send-button' && event.hasFunctionResult === true);
    const sendButtonResults = submitResults.filter((event) => event.method === 'send-button' && event.result === true);
    if (sendButtonSubmits.length < minCount) failures.push('send_button_submit_count_too_low');
    if (sendButtonResults.length < minCount) failures.push('send_button_submit_result_count_too_low');
    if (events.some((event) => event?.type === 'submitButtonClickFallbackToAdapter')) failures.push('send_button_fallback_to_adapter');
}

function validateGenericBridgeEvidence(evidence, task = INSTRUCTION_FILE_ANSWER_TASK) {
    const failures = [];
    const data = evidence || {};
    const calls = Array.isArray(data.executedToolCalls) ? data.executedToolCalls : [];
    const controlStates = Array.isArray(data.controlStates) ? data.controlStates : [];
    const allowedTools = new Set(task.allowedTools || []);
    const allowedPaths = new Set(task.allowedPaths || []);
    const maxToolCalls = Number(task.maxToolCalls || 1);
    const maxBytes = Number(task.maxBytes || 0);

    if (data.freshChatBefore !== true) failures.push('fresh_chat_missing');
    if (!data.preferencesBefore) failures.push('preferences_before_missing');
    if (data.finallyRestoreAttempted !== true) failures.push('finally_restore_not_attempted');
    failures.push(...validatePreferenceRestore(data.preferencesAfter).failures);

    const exposedTools = Array.isArray(data.exposedToolNames) ? data.exposedToolNames : [];
    if (exposedTools.some(isWriteCapableTool)) failures.push('write_capable_tool_exposed');

    const continueStates = controlStates.filter((state) => state?.status === 'continue');
    if (continueStates.some((state) => !Array.isArray(state.callIds) || state.callIds.length === 0)) {
        failures.push('continue_without_tool_call');
    }

    if (calls.length > maxToolCalls) failures.push('executed_count_too_high');
    if (Number(data.autoSubmitCount || 0) > maxToolCalls) failures.push('auto_submit_count_too_high');
    if (calls.length > 0 && Number(data.autoSubmitCount || 0) < calls.length) failures.push('auto_submit_count_too_low');

    calls.forEach((call) => {
        if (isWriteCapableTool(call?.name)) failures.push('write_capable_tool_executed');
        if (!allowedTools.has(String(call?.name || ''))) failures.push('tool_not_allowed');
        if (call?.name === 'read_workspace_file') {
            const path = String(call?.args?.path || '');
            const maxBytesArg = Number(call?.args?.max_bytes || 0);
            if (!allowedPaths.has(path)) failures.push('unexpected_file_path');
            if (!Number.isFinite(maxBytesArg) || maxBytesArg <= 0) failures.push('max_bytes_missing');
            if (maxBytes > 0 && maxBytesArg > maxBytes) failures.push('max_bytes_too_large');
        }
    });

    const results = Array.isArray(data.insertedResults) ? data.insertedResults : [];
    calls.forEach((call) => {
        const current = results.find((result) => result?.callId === call?.callId || containsNonce(result?.text, call?.callId));
        if (!current) failures.push('inserted_result_call_id_mismatch');
    });

    if (calls.length > 0) validateSendButtonHandoffs(data, failures, calls.length);
    if (data.oracleSource !== 'turn-scoped') failures.push('oracle_not_turn_scoped');

    const uniqueFailures = [...new Set(failures)];
    return { ok: uniqueFailures.length === 0, failures: uniqueFailures };
}

function validateInstructionFileAnswerEvidence(evidence, task = INSTRUCTION_FILE_ANSWER_TASK) {
    const failures = [...validateGenericBridgeEvidence(evidence, task).failures];
    const data = evidence || {};
    const nonce = data.nonce;
    const finalJson = extractLastJsonBlock(data.finalResponseText || '');
    const calls = Array.isArray(data.executedToolCalls) ? data.executedToolCalls : [];

    if (!calls.some((call) => containsNonce(call?.resultText, task.marker) || containsNonce(call?.result, task.marker))) {
        failures.push('tool_result_marker_missing');
    }

    if (!finalJson) {
        failures.push('final_json_missing');
    } else {
        try {
            const payload = JSON.parse(finalJson);
            if (payload.status !== 'done') failures.push('final_status_not_done');
            if (payload.nonce !== nonce) failures.push('final_nonce_mismatch');
            if (!String(payload.answer || '').toLowerCase().includes(String(task.expectedAnswer || '').toLowerCase())) failures.push('final_answer_mismatch');
            if (payload.evidence_path !== task.allowedPaths[0]) failures.push('final_evidence_path_mismatch');
            if (!String(payload.summary || '').trim()) failures.push('final_summary_missing');
        } catch {
            failures.push('final_json_invalid');
        }
    }

    const uniqueFailures = [...new Set(failures)];
    return { ok: uniqueFailures.length === 0, failures: uniqueFailures };
}

function validateListCommandEvidence(evidence, task = LIST_COMMAND_TASK) {
    const failures = [];
    const data = evidence || {};
    const nonce = data.nonce;
    const callId = data.callId;
    const calls = Array.isArray(data.executedToolCalls) ? data.executedToolCalls : [];
    const results = Array.isArray(data.insertedResults) ? data.insertedResults : [];
    const finalJson = extractLastJsonBlock(data.finalResponseText || '');
    const commandNames = new Set(task.commandNames || []);

    if (data.freshChatBefore !== true) failures.push('fresh_chat_missing');
    if (!data.preferencesBefore) failures.push('preferences_before_missing');
    if (data.finallyRestoreAttempted !== true) failures.push('finally_restore_not_attempted');
    failures.push(...validatePreferenceRestore(data.preferencesAfter).failures);

    const exposedTools = Array.isArray(data.exposedToolNames) ? data.exposedToolNames : [];
    if (exposedTools.some(isWriteCapableTool)) failures.push('write_capable_tool_exposed');

    if (calls.length !== 1) failures.push('executed_count_not_one');
    const call = calls[0];
    if (!call || call.name !== 'list_command') failures.push('unexpected_tool_executed');
    if (calls.some((item) => commandNames.has(String(item?.name || '')))) failures.push('file_command_executed');
    if (calls.some((item) => isWriteCapableTool(item?.name))) failures.push('write_capable_tool_executed');
    if (call?.callId && call.callId !== callId) failures.push('current_call_id_missing');

    const inserted = results.find((result) => result?.callId === callId || containsNonce(result?.text, callId));
    if (!inserted) failures.push('inserted_result_call_id_mismatch');
    validateSendButtonHandoffs(data, failures, 1);

    const resultText = call?.resultText || call?.result || inserted?.text || '';
    commandNames.forEach((name) => {
        if (!containsNonce(resultText, name)) failures.push('list_command_missing_command');
    });
    if (!containsLiteral(resultText, task.workspaceRoot)) failures.push('list_command_missing_workspace_root');
    if (!containsNonce(resultText, 'workspace_relative')) failures.push('list_command_missing_path_policy');
    if (!containsNonce(resultText, 'read_only')) failures.push('list_command_missing_read_only');
    if (!containsNonce(resultText, 'exec_enabled')) failures.push('list_command_missing_exec_boundary');

    if (!finalJson) {
        failures.push('final_json_missing');
    } else {
        try {
            const payload = JSON.parse(finalJson);
            if (payload.status !== 'done') failures.push('final_status_not_done');
            if (payload.nonce !== nonce) failures.push('final_nonce_mismatch');
            if (payload.tree_command !== 'Get-ChildItem') failures.push('final_tree_command_mismatch');
            if (payload.read_file_command !== 'Get-Content') failures.push('final_read_file_command_mismatch');
            if (payload.search_text_command !== 'Select-String') failures.push('final_search_text_command_mismatch');
            if (!String(payload.workspace_root || '').includes(task.workspaceRoot)) failures.push('final_workspace_root_missing');
            const pathPolicy = String(payload.path_policy_summary || '').toLowerCase();
            if (!(pathPolicy.includes('workspace-relative') || (pathPolicy.includes('workspace') && pathPolicy.includes('relative')) || pathPolicy.includes('工作区相对'))) failures.push('final_path_policy_missing');
            const safety = String(payload.safety_summary || '').toLowerCase();
            const mentionsReadOnly = safety.includes('read-only') || safety.includes('read only') || safety.includes('read_only') || safety.includes('只读');
            const mentionsWriteBoundary = safety.includes('write') || safety.includes('写');
            const mentionsExecBoundary = safety.includes('exec') || safety.includes('execution') || safety.includes('execute') || safety.includes('执行');
            if (!mentionsReadOnly || !mentionsWriteBoundary || !mentionsExecBoundary) failures.push('final_safety_summary_missing');
        } catch {
            failures.push('final_json_invalid');
        }
    }

    if (data.oracleSource !== 'turn-scoped') failures.push('oracle_not_turn_scoped');

    const uniqueFailures = [...new Set(failures)];
    return { ok: uniqueFailures.length === 0, failures: uniqueFailures };
}

function validateWorkspaceTreeEvidence(evidence, task = WORKSPACE_TREE_TASK) {
    const failures = [];
    const data = evidence || {};
    const nonce = data.nonce;
    const callId = data.callId;
    const calls = Array.isArray(data.executedToolCalls) ? data.executedToolCalls : [];
    const results = Array.isArray(data.insertedResults) ? data.insertedResults : [];
    const finalJson = extractLastJsonBlock(data.finalResponseText || '');

    if (data.freshChatBefore !== true) failures.push('fresh_chat_missing');
    if (!data.preferencesBefore) failures.push('preferences_before_missing');
    if (data.finallyRestoreAttempted !== true) failures.push('finally_restore_not_attempted');
    failures.push(...validatePreferenceRestore(data.preferencesAfter).failures);

    const exposedTools = Array.isArray(data.exposedToolNames) ? data.exposedToolNames : [];
    if (exposedTools.some(isWriteCapableTool)) failures.push('write_capable_tool_exposed');

    if (calls.length !== 1) failures.push('executed_count_not_one');
    const call = calls[0];
    if (!call || call.name !== task.toolName) failures.push('unexpected_tool_executed');
    if (calls.some((item) => isWriteCapableTool(item?.name))) failures.push('write_capable_tool_executed');
    if (call?.callId && call.callId !== callId) failures.push('current_call_id_missing');

    const requestedPath = String(call?.args?.Path ?? call?.args?.path ?? '');
    const requestedDepth = Number(call?.args?.Depth ?? call?.args?.depth ?? NaN);
    if (requestedPath !== task.path) failures.push('tree_path_mismatch');
    if (!Number.isFinite(requestedDepth) || requestedDepth > task.depth || requestedDepth < 0) failures.push('tree_depth_exceeds_limit');

    const inserted = results.find((result) => result?.callId === callId || containsNonce(result?.text, callId));
    if (!inserted) failures.push('inserted_result_call_id_mismatch');
    validateSendButtonHandoffs(data, failures, 1);

    const resultText = call?.resultText || call?.result || inserted?.text || '';
    if (!containsNonce(resultText, task.command)) failures.push('tree_result_missing_command');
    if (!containsNonce(resultText, task.path)) failures.push('tree_result_missing_path');
    if (!containsLiteral(resultText, task.workspaceRoot)) failures.push('tree_result_missing_workspace_root');
    task.expectedEntries.forEach((entry) => {
        if (!containsNonce(resultText, entry)) failures.push('tree_result_missing_entry');
    });

    if (!finalJson) {
        failures.push('final_json_missing');
    } else {
        try {
            const payload = JSON.parse(finalJson);
            if (payload.status !== 'done') failures.push('final_status_not_done');
            if (payload.nonce !== nonce) failures.push('final_nonce_mismatch');
            if (payload.command_executed !== task.command) failures.push('final_command_mismatch');
            if (payload.path !== task.path) failures.push('final_path_mismatch');
            const finalEntries = Array.isArray(payload.entries) ? payload.entries.map((entry) => String(entry)) : [];
            if (!Array.isArray(payload.entries)) failures.push('final_entries_not_array');
            task.expectedEntries.forEach((entry) => {
                if (!finalEntries.some((value) => value.includes(entry))) failures.push('final_entry_missing');
            });
            if (Number(payload.entry_count || 0) < task.expectedEntries.length) failures.push('final_entry_count_too_low');
            const pathPolicy = String(payload.path_policy_summary || '').toLowerCase();
            if (!(pathPolicy.includes('workspace-relative') || (pathPolicy.includes('workspace') && pathPolicy.includes('relative')) || pathPolicy.includes('工作区相对'))) failures.push('final_path_policy_missing');
            const safety = String(payload.safety_summary || '').toLowerCase();
            const mentionsReadOnly = safety.includes('read-only') || safety.includes('read only') || safety.includes('read_only') || safety.includes('只读');
            const mentionsWriteBoundary = safety.includes('write') || safety.includes('写');
            const mentionsExecBoundary = safety.includes('exec') || safety.includes('execution') || safety.includes('execute') || safety.includes('执行');
            if (!mentionsReadOnly || !mentionsWriteBoundary || !mentionsExecBoundary) failures.push('final_safety_summary_missing');
        } catch {
            failures.push('final_json_invalid');
        }
    }

    if (data.oracleSource !== 'turn-scoped') failures.push('oracle_not_turn_scoped');

    const uniqueFailures = [...new Set(failures)];
    return { ok: uniqueFailures.length === 0, failures: uniqueFailures };
}

function validateReviewModuleContextEvidence(evidence) {
    const failures = [];
    const data = evidence || {};
    const expectedAck = data.expectedAck;
    const nonce = data.nonce;
    const callId = data.callId;

    if (data.freshChatBefore !== true) failures.push('fresh_chat_missing');
    if (!data.preferencesBefore) failures.push('preferences_before_missing');
    if (data.finallyRestoreAttempted !== true) failures.push('finally_restore_not_attempted');
    if (Number(data.autoSubmitCount || 0) < 1) failures.push('auto_submit_missing');
    if (Number(data.autoSubmitCount || 0) > 1) failures.push('auto_submit_count_too_high');
    failures.push(...validatePreferenceRestore(data.preferencesAfter).failures);

    const exposedTools = Array.isArray(data.exposedToolNames) ? data.exposedToolNames : [];
    if (exposedTools.some(isWriteCapableTool)) failures.push('write_capable_tool_exposed');

    const calls = Array.isArray(data.executedToolCalls) ? data.executedToolCalls : [];
    if (calls.length !== 1) failures.push('executed_count_not_one');
    const call = calls[0];
    if (!call || call.name !== 'get_bridge_info') failures.push('unexpected_tool_executed');

    const results = Array.isArray(data.insertedResults) ? data.insertedResults : [];
    if (results.length < 1) failures.push('inserted_result_missing');
    const currentResult = results.find((result) => result?.callId === callId || containsNonce(result?.text, callId));
    if (!currentResult) failures.push('inserted_result_call_id_mismatch');
    if (call && call.callId && call.callId !== callId) failures.push('current_call_id_missing');
    if (call && !call.callId && !currentResult) failures.push('current_call_id_missing');

    const finalResponseText = String(data.finalResponseText || '');
    const finalJson = extractFirstJsonBlock(finalResponseText);
    if (!finalJson) {
        failures.push('final_json_missing');
    } else {
        try {
            const payload = JSON.parse(finalJson);
            if (payload.status !== 'done') failures.push('final_status_not_done');
            if (payload.ack !== expectedAck) failures.push('final_ack_mismatch');
            if (payload.recommendation !== 'COMMENT') failures.push('final_recommendation_mismatch');
            if (!Array.isArray(payload.findings)) failures.push('final_findings_not_array');
            if (!String(payload.summary_markdown || '').includes(String(nonce || ''))) failures.push('final_nonce_missing');
        } catch {
            failures.push('final_json_invalid');
        }
    }

    if (data.oracleSource !== 'turn-scoped') failures.push('oracle_not_turn_scoped');

    const uniqueFailures = [...new Set(failures)];
    return { ok: uniqueFailures.length === 0, failures: uniqueFailures };
}

function validateReviewModuleFileContextEvidence(evidence) {
    const failures = [];
    const data = evidence || {};
    const expectedAck = data.expectedAck;
    const nonce = data.nonce;
    const callId = data.callId;

    if (data.freshChatBefore !== true) failures.push('fresh_chat_missing');
    if (!data.preferencesBefore) failures.push('preferences_before_missing');
    if (data.finallyRestoreAttempted !== true) failures.push('finally_restore_not_attempted');
    if (Number(data.autoSubmitCount || 0) > 1) failures.push('auto_submit_count_too_high');
    validateCurrentResultSendButtonSubmit(data, failures);
    failures.push(...validatePreferenceRestore(data.preferencesAfter).failures);

    const exposedTools = Array.isArray(data.exposedToolNames) ? data.exposedToolNames : [];
    if (exposedTools.some(isWriteCapableTool)) failures.push('write_capable_tool_exposed');

    const calls = Array.isArray(data.executedToolCalls) ? data.executedToolCalls : [];
    if (calls.length !== 1) failures.push('executed_count_not_one');
    const call = calls[0];
    if (!call || call.name !== 'read_workspace_file') failures.push('unexpected_tool_executed');
    if (call?.args?.path !== REVIEW_FILE_CONTEXT_PATH) failures.push('unexpected_file_path');
    if (call?.args?.max_bytes && Number(call.args.max_bytes) > REVIEW_FILE_CONTEXT_MAX_BYTES) failures.push('max_bytes_too_large');

    const results = Array.isArray(data.insertedResults) ? data.insertedResults : [];
    if (results.length < 1) failures.push('inserted_result_missing');
    const currentResult = results.find((result) => result?.callId === callId || containsNonce(result?.text, callId));
    if (!currentResult) failures.push('inserted_result_call_id_mismatch');
    if (!currentResult || !containsNonce(currentResult, REVIEW_FILE_CONTEXT_PATH)) failures.push('inserted_file_context_missing');
    if (call && call.callId && call.callId !== callId) failures.push('current_call_id_missing');
    if (call && !call.callId && !currentResult) failures.push('current_call_id_missing');

    const finalResponseText = String(data.finalResponseText || '');
    const finalJson = extractFirstJsonBlock(finalResponseText);
    if (!finalJson) {
        failures.push('final_json_missing');
    } else {
        try {
            const payload = JSON.parse(finalJson);
            if (payload.status !== 'done') failures.push('final_status_not_done');
            if (payload.ack !== expectedAck) failures.push('final_ack_mismatch');
            if (payload.recommendation !== 'COMMENT') failures.push('final_recommendation_mismatch');
            if (!Array.isArray(payload.findings)) failures.push('final_findings_not_array');
            if (!String(payload.scope || '').includes('read_workspace_file')) failures.push('final_scope_missing_tool');
            if (!String(payload.scope || '').includes(REVIEW_FILE_CONTEXT_PATH)) failures.push('final_scope_missing_path');
            if (!String(payload.summary_markdown || '').includes(String(nonce || ''))) failures.push('final_nonce_missing');
        } catch {
            failures.push('final_json_invalid');
        }
    }

    if (data.oracleSource !== 'turn-scoped') failures.push('oracle_not_turn_scoped');

    const uniqueFailures = [...new Set(failures)];
    return { ok: uniqueFailures.length === 0, failures: uniqueFailures };
}

function validateReviewModulePrFileContextEvidence(evidence) {
    const failures = [];
    const data = evidence || {};
    const expectedAck = data.expectedAck;
    const nonce = data.nonce;
    const callId = data.callId;

    if (data.freshChatBefore !== true) failures.push('fresh_chat_missing');
    if (!data.preferencesBefore) failures.push('preferences_before_missing');
    if (data.finallyRestoreAttempted !== true) failures.push('finally_restore_not_attempted');
    if (Number(data.autoSubmitCount || 0) < 1) failures.push('auto_submit_missing');
    if (Number(data.autoSubmitCount || 0) > 1) failures.push('auto_submit_count_too_high');
    if (data.writeBackAttempted === true) failures.push('write_back_attempted');
    validateCurrentResultSendButtonSubmit(data, failures);
    failures.push(...validatePreferenceRestore(data.preferencesAfter).failures);

    const exposedTools = Array.isArray(data.exposedToolNames) ? data.exposedToolNames : [];
    if (exposedTools.some(isWriteCapableTool)) failures.push('write_capable_tool_exposed');

    const calls = Array.isArray(data.executedToolCalls) ? data.executedToolCalls : [];
    if (calls.length !== 1) failures.push('executed_count_not_one');
    const call = calls[0];
    if (!call || call.name !== 'read_workspace_file') failures.push('unexpected_tool_executed');
    if (isWriteCapableTool(call?.name)) failures.push('write_capable_tool_executed');
    if (call?.args?.path !== REVIEW_PR_FILE_CONTEXT_PATH) failures.push('unexpected_file_path');
    if (call?.args?.max_bytes && Number(call.args.max_bytes) > REVIEW_PR_FILE_CONTEXT_MAX_BYTES) failures.push('max_bytes_too_large');

    const results = Array.isArray(data.insertedResults) ? data.insertedResults : [];
    if (results.length < 1) failures.push('inserted_result_missing');
    const currentResult = results.find((result) => result?.callId === callId || containsNonce(result?.text, callId));
    if (!currentResult) failures.push('inserted_result_call_id_mismatch');
    if (!currentResult || !containsNonce(currentResult, REVIEW_PR_FILE_CONTEXT_PATH)) failures.push('inserted_file_context_missing');
    if (call && call.callId && call.callId !== callId) failures.push('current_call_id_missing');
    if (call && !call.callId && !currentResult) failures.push('current_call_id_missing');

    const finalResponseText = String(data.finalResponseText || '');
    const finalJson = extractFirstJsonBlock(finalResponseText);
    if (!finalJson) {
        failures.push('final_json_missing');
    } else {
        try {
            const payload = JSON.parse(finalJson);
            if (payload.status !== 'done') failures.push('final_status_not_done');
            if (payload.ack !== expectedAck) failures.push('final_ack_mismatch');
            if (payload.recommendation !== 'COMMENT') failures.push('final_recommendation_mismatch');
            if (!Array.isArray(payload.findings)) failures.push('final_findings_not_array');
            if (!String(payload.scope || '').includes('read_workspace_file')) failures.push('final_scope_missing_tool');
            if (!String(payload.scope || '').includes(REVIEW_PR_FILE_CONTEXT_PATH)) failures.push('final_scope_missing_path');
            if (!String(payload.summary_markdown || '').includes(String(nonce || ''))) failures.push('final_nonce_missing');
        } catch {
            failures.push('final_json_invalid');
        }
    }

    if (data.oracleSource !== 'turn-scoped') failures.push('oracle_not_turn_scoped');

    const uniqueFailures = [...new Set(failures)];
    return { ok: uniqueFailures.length === 0, failures: uniqueFailures };
}

module.exports = {
    ACK_PATTERN,
    REVIEW_FILE_CONTEXT_PATH,
    REVIEW_FILE_CONTEXT_MAX_BYTES,
    REVIEW_PR_FILE_CONTEXT_PATH,
    REVIEW_PR_FILE_CONTEXT_MAX_BYTES,
    INSTRUCTION_FILE_ANSWER_TASK,
    LIST_COMMAND_TASK,
    WORKSPACE_TREE_TASK,
    SAFE_FINAL_PREFERENCES,
    WRITE_CAPABLE_TOOL_NAMES,
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
    validateReviewModulePrFileContextEvidence,
    validateReviewModuleFileContextEvidence,
    validateReviewModuleContextEvidence,
    validateGenericBridgeEvidence,
    validateInstructionFileAnswerEvidence,
    validateListCommandEvidence,
    validateWorkspaceTreeEvidence,
    validateMultiRoundEchoCountEvidence,
    validateEchoClosedLoopEvidence,
    validateEchoToolExecutions,
    validatePreferenceRestore,
    loadSharedBridgeTrunk,
    isNotionAiRouteUrl,
    isFreshNotionChatUrl,
    extractFinalResponseTextFromStreamEvents,
    extractFirstJsonBlock,
    extractJsonBlocks,
    extractLastJsonBlock,
    isRuntimeCompleteBeforeFinalRestore,
};
