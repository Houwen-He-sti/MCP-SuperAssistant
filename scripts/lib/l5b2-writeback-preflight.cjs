const crypto = require('crypto');

const DEFAULT_TOOL_NAME = 'comment_on_pr';
const DEFAULT_BRIDGE_INFO_TOOL = 'get_bridge_info';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

function createMcpBridgeInventorySequence(options = {}) {
    const startId = Number.isInteger(options.startId) ? options.startId : 1;
    const clientName = options.clientName || 'l5b2-obs-script';
    const clientVersion = options.clientVersion || 'v1';
    const protocolVersion = options.protocolVersion || DEFAULT_PROTOCOL_VERSION;

    return [
        {
            step: 'initialize',
            kind: 'request',
            body: {
                jsonrpc: '2.0',
                id: startId,
                method: 'initialize',
                params: {
                    protocolVersion,
                    capabilities: {},
                    clientInfo: {
                        name: clientName,
                        version: clientVersion,
                    },
                },
            },
        },
        {
            step: 'initialized',
            kind: 'notification',
            body: {
                jsonrpc: '2.0',
                method: 'notifications/initialized',
                params: {},
            },
        },
        {
            step: 'tools_list',
            kind: 'request',
            body: {
                jsonrpc: '2.0',
                id: startId + 1,
                method: 'tools/list',
                params: {},
            },
        },
        {
            step: 'get_bridge_info',
            kind: 'request',
            body: {
                jsonrpc: '2.0',
                id: startId + 2,
                method: 'tools/call',
                params: {
                    name: DEFAULT_BRIDGE_INFO_TOOL,
                    arguments: {},
                },
            },
        },
    ];
}

function extractToolNamesFromToolsList(result) {
    if (!result || !Array.isArray(result.tools)) {
        return [];
    }

    return result.tools
        .map(tool => {
            if (typeof tool === 'string') return tool;
            if (tool && typeof tool.name === 'string') return tool.name;
            return null;
        })
        .filter(Boolean);
}

function looksLikeBridgeInfo(value) {
    return !!(
        value &&
        typeof value === 'object' &&
        Object.prototype.hasOwnProperty.call(value, 'writes_enabled') &&
        Object.prototype.hasOwnProperty.call(value, 'tools')
    );
}

function parseJsonObject(text) {
    if (typeof text !== 'string') return null;
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function extractBridgeInfoFromToolCallResult(result) {
    if (!result || typeof result !== 'object') {
        return null;
    }
    if (looksLikeBridgeInfo(result)) {
        return result;
    }
    if (looksLikeBridgeInfo(result.structuredContent)) {
        return result.structuredContent;
    }
    if (result.result) {
        return extractBridgeInfoFromToolCallResult(result.result);
    }
    if (Array.isArray(result.content)) {
        for (const item of result.content) {
            const parsed = parseJsonObject(item && item.text);
            if (looksLikeBridgeInfo(parsed)) {
                return parsed;
            }
        }
    }
    return null;
}

function parseBridgeWriteInventory(bridgeInfo, expectedTool = DEFAULT_TOOL_NAME) {
    const failures = [];
    const warnings = [];
    const tools = bridgeInfo && bridgeInfo.tools;
    let gitWriteTools = [];

    if (!bridgeInfo || typeof bridgeInfo !== 'object') {
        failures.push('bridge_info_missing');
    }

    const writesEnabled = !!(bridgeInfo && bridgeInfo.writes_enabled === true);
    if (!writesEnabled) {
        failures.push('writes_disabled');
    }

    if (!tools || Array.isArray(tools) || !Array.isArray(tools.git_write)) {
        failures.push('tools.git_write_missing');
    } else {
        gitWriteTools = tools.git_write.filter(tool => typeof tool === 'string');
    }

    const toolInGitWrite = gitWriteTools.includes(expectedTool);
    if (!toolInGitWrite) {
        failures.push(`${expectedTool}_not_write_enabled`);
    }

    return {
        ok: failures.length === 0,
        source: bridgeInfo,
        writesEnabled,
        gitWriteTools,
        toolInGitWrite,
        failures,
        warnings,
    };
}

function repoNameMatches(actual, expected) {
    if (typeof actual !== 'string' || typeof expected !== 'string') {
        return false;
    }
    const normalize = value => value.trim().toLowerCase();
    if (!actual.trim() || normalize(actual) === 'unknown') {
        return false;
    }
    return normalize(actual) === normalize(expected);
}

function firstFailureVerdict(failures) {
    const priority = [
        ['gh_auth_failed', 'GH_AUTH_FAILED'],
        ['bridge_unreachable', 'BRIDGE_UNREACHABLE'],
        ['mcp_session_failed', 'MCP_SESSION_FAILED'],
        ['tool_not_listed', 'TOOL_NOT_LISTED'],
        ['writes_disabled', 'WRITES_DISABLED'],
        [`${DEFAULT_TOOL_NAME}_not_write_enabled`, 'COMMENT_TOOL_NOT_WRITE_ENABLED'],
        ['tools.git_write_missing', 'COMMENT_TOOL_NOT_WRITE_ENABLED'],
        ['repo_mismatch', 'REPO_MISMATCH'],
        ['evidence_context_incomplete', 'EVIDENCE_CONTEXT_INCOMPLETE'],
    ];

    for (const [failure, verdict] of priority) {
        if (failures.includes(failure)) return verdict;
    }
    return 'WRITE_GATE_BLOCKED';
}

function evaluateWriteGate(options = {}) {
    const failures = [];
    const toolNames = extractToolNamesFromToolsList(options.toolsListResult);

    if (options.ghAuthOk !== true) {
        failures.push('gh_auth_failed');
    }
    if (options.bridgeReachable !== true) {
        failures.push('bridge_unreachable');
    }
    if (options.mcpSessionOk !== true) {
        failures.push('mcp_session_failed');
    }
    if (!toolNames.includes(DEFAULT_TOOL_NAME)) {
        failures.push('tool_not_listed');
    }

    const inventory = parseBridgeWriteInventory(options.bridgeInfo, DEFAULT_TOOL_NAME);
    failures.push(...inventory.failures);

    if (options.repoMatches !== true) {
        failures.push('repo_mismatch');
    }
    if (options.evidenceContextOk !== true) {
        failures.push('evidence_context_incomplete');
    }

    const uniqueFailures = [...new Set(failures)];
    const ok = uniqueFailures.length === 0;
    return {
        ok,
        verdict: ok ? 'WRITE_GATE_OK' : firstFailureVerdict(uniqueFailures),
        failures: uniqueFailures,
        details: {
            toolNames,
            inventory,
        },
    };
}

function classifyPhase1Verdict(facts = {}) {
    if (facts.phase2Started && facts.transcriptConfirmed === false) {
        return 'SUBMIT_NOT_CONFIRMED_STOP';
    }
    if (facts.domComposerObserved !== true) {
        return 'PREFLIGHT_BLOCKED_NO_COMPOSER';
    }
    if (
        facts.bridgeInventoryOk === true &&
        facts.ghAuthOk === true &&
        facts.repoMatches === true &&
        facts.contextMetadataOk === true
    ) {
        return 'PREFLIGHT_OK';
    }
    return 'DOM_COMPOSER_OBSERVED';
}

function classifyPhase2Verdict(facts = {}) {
    if (facts.submitConfirmed === false) {
        return 'FAIL_SUBMIT_NOT_CONFIRMED';
    }
    if (facts.commentFound === true && facts.exactMatch === true) {
        if (facts.hasAssistantFunctionCall === true && facts.hasCallToolInvocation === true) {
            return 'PASS';
        }
        return 'PARTIAL_EXACT_COMMENT_WITHOUT_TOOL_EVIDENCE';
    }
    if (facts.commentFound === true && facts.exactMatch !== true) {
        return 'PARTIAL_BODY_MISMATCH';
    }
    if (facts.hasAssistantFunctionCall === true || facts.hasCallToolInvocation === true) {
        return 'PARTIAL_TOOL_CALL_WITHOUT_COMMENT';
    }
    return 'FAIL_NO_STRUCTURED_TOOL_CALL';
}

function isSha256(value) {
    return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value);
}

function isGitCommit(value) {
    return typeof value === 'string' && /^[a-fA-F0-9]{40}$/.test(value);
}

function hasText(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.trim().toLowerCase() !== 'unknown';
}

function validateRepoMetadata(repo, prefix, failures) {
    if (!repo || typeof repo !== 'object') {
        failures.push(`${prefix}_missing`);
        return;
    }
    if (!hasText(repo.branch)) failures.push(`${prefix}.branch_invalid`);
    if (!isGitCommit(repo.commit)) failures.push(`${prefix}.commit_invalid`);
    if (typeof repo.dirty !== 'boolean') failures.push(`${prefix}.dirty_missing`);
}

function validateEvidenceMetadata(metadata = {}) {
    const failures = [];

    if (!hasText(metadata.script_path)) failures.push('script_path_missing');
    if (!isSha256(metadata.script_sha256)) failures.push('script_sha256_missing');
    if (typeof metadata.script_git_tracked !== 'boolean') failures.push('script_git_tracked_missing');

    validateRepoMetadata(metadata.root_repo, 'root_repo', failures);
    validateRepoMetadata(metadata.mcp_superassistant_repo, 'mcp_superassistant_repo', failures);
    if (
        metadata.mcp_superassistant_repo &&
        typeof metadata.mcp_superassistant_repo.untracked_files_present !== 'boolean'
    ) {
        failures.push('mcp_superassistant_repo.untracked_files_present_missing');
    }

    if (!hasText(metadata.command)) failures.push('command_missing');
    if (!['phase1', 'full'].includes(metadata.mode)) failures.push('mode_invalid');
    if (!Number.isInteger(metadata.cdp_port)) failures.push('cdp_port_missing');
    if (!hasText(metadata.target_url)) failures.push('target_url_missing');
    if (!hasText(metadata.run_id)) failures.push('run_id_missing');
    if (!hasText(metadata.started_at)) failures.push('started_at_missing');
    if (!hasText(metadata.ended_at)) failures.push('ended_at_missing');

    return {
        ok: failures.length === 0,
        verdict: failures.length === 0 ? 'EVIDENCE_CONTEXT_OK' : 'EVIDENCE_CONTEXT_INCOMPLETE',
        failures,
    };
}

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function buildSmokeBodyContract(options = {}) {
    const runId = options.runId || `L5B2-OBS-${Date.now()}`;
    const reviewer = options.reviewer || 'Notion AI';
    const neutralizedMention = '@\u200Bopu-47';
    const body = [
        'L5B-2 NOTION MCP WRITE-BACK SMOKE',
        '',
        `ACK: ${runId}`,
        '',
        `Reviewer: ${reviewer}`,
        `Mention neutralization sample: ${neutralizedMention}`,
        'Code fence sample:',
        '',
        '```text',
        'line 1',
        'line 2',
        '```',
        '',
        'SMOKE TEST / NO REVIEW DECISION',
    ].join('\n');

    return {
        body,
        ack: `ACK: ${runId}`,
        neutralizedMention,
        sha256: sha256(body),
        lineCount: body.split(/\r?\n/).length,
        hasStaticAck: body.includes('L5B2-OBS-MCP-001') || body.includes('l5b2-obs-001'),
    };
}

function buildCommentOnPrJsonl({ callId, number, body }) {
    const rows = [
        {
            type: 'function_call_start',
            name: DEFAULT_TOOL_NAME,
            call_id: callId,
        },
        {
            type: 'function_call_arguments',
            call_id: callId,
            arguments: {
                number,
                body,
            },
        },
        {
            type: 'function_call_end',
            call_id: callId,
        },
    ];

    return rows.map(row => JSON.stringify(row)).join('\n');
}

module.exports = {
    createMcpBridgeInventorySequence,
    extractToolNamesFromToolsList,
    extractBridgeInfoFromToolCallResult,
    parseBridgeWriteInventory,
    repoNameMatches,
    evaluateWriteGate,
    classifyPhase1Verdict,
    classifyPhase2Verdict,
    validateEvidenceMetadata,
    buildSmokeBodyContract,
    buildCommentOnPrJsonl,
};
