# Gate 5c Consumption E2E Evidence — 2026-05-09T03:07:49.450Z

## Result: PIPELINE_FAIL

## Phase 0: MCP Registry Diagnosis

| Check | Status |
|-------|--------|
| ISOLATED world | ✅ |
| mcpClient ready | ✅ |
| Tool discovery | getAvailableTools |
| Tools found | 29 |
| echo registered | ✅ |
| Phase 0 gate | ✅ PASS |

**Available tools**: committee-bridge.echo, committee-bridge.get_bridge_info, committee-bridge.get_task_status, committee-bridge.read_workspace_file, committee-bridge.post_mailbox_message, committee-bridge.git_status, committee-bridge.git_diff, committee-bridge.git_log, committee-bridge.git_branch, committee-bridge.git_show, committee-bridge.list_prs, committee-bridge.get_pr, committee-bridge.get_pr_diff, committee-bridge.get_pr_comments, committee-bridge.list_issues, committee-bridge.get_issue, committee-bridge.create_branch, committee-bridge.switch_branch, committee-bridge.git_add, committee-bridge.git_commit, committee-bridge.git_push, committee-bridge.create_pr, committee-bridge.comment_on_pr, committee-bridge.submit_pr_review, committee-bridge.request_review, committee-bridge.create_issue, committee-bridge.comment_on_issue, committee-bridge.update_issue, committee-bridge.merge_pr

### Runtime API Surface

```json
{
  "hasMcpClient": true,
  "isReady": true,
  "hasCallTool": true,
  "hasIsReady": true,
  "hasGetAvailableTools": true,
  "hasGetTools": false,
  "hasListTools": false,
  "mcpClientKeys": [
    "isInitialized",
    "heartbeatInterval",
    "HEARTBEAT_INTERVAL",
    "constructor",
    "initialize",
    "requestInitialState",
    "setupMessageListeners",
    "handleConnectionStatusChange",
    "handleToolUpdate",
    "handleServerConfigUpdate",
    "handleHeartbeatResponse",
    "startHeartbeat",
    "stopHeartbeat",
    "sendHeartbeat",
    "callTool",
    "isConnectionError",
    "getAvailableTools",
    "forceReconnect",
    "forceConnectionStatusCheck",
    "getServerConfig",
    "getCurrentConnectionStatus",
    "updateServerConfig",
    "getConnectionStatus",
    "isReady",
    "cleanup"
  ]
}
```

## Consumption Attempts (5/5)

### Attempt 1

- **Sentinel**: `sentinel_g5c_moxrke6h_y5xg`
- **Result**: PIPELINE_INFERRED
- **Evidence quality**: none
- **Pipeline OK**: ❌
- **Duration**: 98697ms

**Tool execution**:

```json
{
  "name": "committee-bridge.echo",
  "resultPreview": "{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"echo\\\": \\\"sentinel_g5c_moxrke6h_y5xg\\\",\\n  \\\"timestamp\\\": \\\"2026-05-09T03:08:08.185731+00:00\\\",\\n  \\\"server\\\": \\\"committee-bridge-mcp\\\"\\n}\"}],\"isError\":false}",
  "isError": false
}
```

**Consumption evidence**:

```json
{
  "sentinelSnapshots": {
    "beforePrompt": 0,
    "afterPrompt": 0,
    "afterAIResponse": 1
  },
  "sentinelCountTotal": 1,
  "sentinelInTail": true,
  "timestampFromToolResult": "2026-05-09T03:08:08.185731+00:00",
  "timestampFoundInResponse": false,
  "bodyTailSnippet": "新对话\nCtrl+O\nSuperAssistant\n/\n调用工具并引用timestamp\n设置\nSuperAssistant\n请调用 committee-bridge.echo 工具，参数为 {\"message\": \"sentinel_g5c_moxrke6h_y5xg\"}。工具返回后，请在你的回复中原样引用返回结果中的 timestamp 字段值，不要省略或改写。\n12:07\n思考完毕\n好的，我将通过桥接器调用 committee-bridge.echo。\n请在桥接器执行完成后将返回结果回贴到对话中，我会基于真实返回原样引用其中的 timestamp 字段值。我不会伪造任何返回数据。\nMCP",
  "consumptionEvidenceQuality": "none"
}
```

**Ordered sentinel snapshots** (proves source layering):

```json
{
  "beforePrompt": 0,
  "afterPrompt": 0,
  "afterAIResponse": 1
}
```

**Bridge events**:

```json
[
  {
    "type": "callTool",
    "name": "committee-bridge.echo",
    "params": "{\"message\":\"sentinel_g5c_moxrke6h_y5xg\"}",
    "ts": 1778296088177
  },
  {
    "type": "callTool",
    "name": "committee-bridge.echo",
    "params": "{\"message\":\"sentinel_g5c_moxrke6h_y5xg\"}",
    "ts": 1778296088177
  },
  {
    "type": "callTool_result",
    "name": "committee-bridge.echo",
    "resultPreview": "{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"echo\\\": \\\"sentinel_g5c_moxrke6h_y5xg\\\",\\n  \\\"timestamp\\\": \\\"2026-05-09T03:08:08.185731+00:00\\\",\\n  \\\"server\\\": \\\"committee-bridge-mcp\\\"\\n}\"}],\"isError\":false}",
    "isError": false,
    "ts": 1778296088301
  },
  {
    "type": "callTool_result",
    "name": "committee-bridge.echo",
    "resultPreview": "{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"echo\\\": \\\"sentinel_g5c_moxrke6h_y5xg\\\",\\n  \\\"timestamp\\\": \\\"2026-05-09T03:08:08.185731+00:00\\\",\\n  \\\"server\\\": \\\"committee-bridge-mcp\\\"\\n}\"}],\"isError\":false}",
    "isError": false,
    "ts": 1778296088301
  }
]
```

**Diagnostics**:

```json
{
  "note": "callTool succeeded but insertText/submitForm events not captured (adapter object mismatch). AI may not have output sentinel yet."
}
```

### Attempt 2

- **Sentinel**: `sentinel_g5c_moxrmtww_zo63`
- **Result**: PIPELINE_INFERRED
- **Evidence quality**: none
- **Pipeline OK**: ❌
- **Duration**: 107576ms

**Tool execution**:

```json
{
  "name": "committee-bridge.echo",
  "resultPreview": "{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"echo\\\": \\\"sentinel_g5c_moxrmtww_zo63\\\",\\n  \\\"timestamp\\\": \\\"2026-05-09T03:10:09.172984+00:00\\\",\\n  \\\"server\\\": \\\"committee-bridge-mcp\\\"\\n}\"}],\"isError\":false}",
  "isError": false
}
```

**Consumption evidence**:

```json
{
  "sentinelSnapshots": {
    "beforePrompt": 0,
    "afterPrompt": 1,
    "afterAIResponse": 1
  },
  "sentinelCountTotal": 1,
  "sentinelInTail": true,
  "timestampFromToolResult": "2026-05-09T03:10:09.172984+00:00",
  "timestampFoundInResponse": false,
  "bodyTailSnippet": "可用工具\n1 天\n新对话\nCtrl+O\nSuperAssistant\n/\n调用工具并引用时间戳\n设置\nSuperAssistant\n请调用 committee-bridge.echo 工具，参数为 {\"message\": \"sentinel_g5c_moxrmtww_zo63\"}。工具返回后，请在你的回复中原样引用返回结果中的 timestamp 字段值，不要省略或改写。\n12:09\n思考完毕\n好的，下面发起一次 echo 调用，等待桥接器回贴结果后我再原样引用 timestamp 字段。\n请把桥接器返回的 JSON 回贴到对话里；收到后我会原样引用其中的 timestamp 字段值。\nMCP",
  "consumptionEvidenceQuality": "none"
}
```

**Ordered sentinel snapshots** (proves source layering):

```json
{
  "beforePrompt": 0,
  "afterPrompt": 1,
  "afterAIResponse": 1
}
```

**Bridge events**:

```json
[
  {
    "type": "callTool",
    "name": "committee-bridge.echo",
    "params": "{\"message\":\"sentinel_g5c_moxrmtww_zo63\"}",
    "ts": 1778296209165
  },
  {
    "type": "callTool",
    "name": "committee-bridge.echo",
    "params": "{\"message\":\"sentinel_g5c_moxrmtww_zo63\"}",
    "ts": 1778296209165
  },
  {
    "type": "callTool_result",
    "name": "committee-bridge.echo",
    "resultPreview": "{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"echo\\\": \\\"sentinel_g5c_moxrmtww_zo63\\\",\\n  \\\"timestamp\\\": \\\"2026-05-09T03:10:09.172984+00:00\\\",\\n  \\\"server\\\": \\\"committee-bridge-mcp\\\"\\n}\"}],\"isError\":false}",
    "isError": false,
    "ts": 1778296209228
  },
  {
    "type": "callTool_result",
    "name": "committee-bridge.echo",
    "resultPreview": "{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"echo\\\": \\\"sentinel_g5c_moxrmtww_zo63\\\",\\n  \\\"timestamp\\\": \\\"2026-05-09T03:10:09.172984+00:00\\\",\\n  \\\"server\\\": \\\"committee-bridge-mcp\\\"\\n}\"}],\"isError\":false}",
    "isError": false,
    "ts": 1778296209228
  }
]
```

**Diagnostics**:

```json
{
  "note": "callTool succeeded but insertText/submitForm events not captured (adapter object mismatch). AI may not have output sentinel yet."
}
```

### Attempt 3

- **Sentinel**: `sentinel_g5c_moxrpgi5_ipoe`
- **Result**: PIPELINE_INFERRED
- **Evidence quality**: none
- **Pipeline OK**: ❌
- **Duration**: 107804ms

**Tool execution**:

```json
{
  "name": "committee-bridge.echo",
  "resultPreview": "{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"echo\\\": \\\"sentinel_g5c_moxrpgi5_ipoe\\\",\\n  \\\"timestamp\\\": \\\"2026-05-09T03:12:12.188980+00:00\\\",\\n  \\\"server\\\": \\\"committee-bridge-mcp\\\"\\n}\"}],\"isError\":false}",
  "isError": false
}
```

**Consumption evidence**:

```json
{
  "sentinelSnapshots": {
    "beforePrompt": 0,
    "afterPrompt": 0,
    "afterAIResponse": 1
  },
  "sentinelCountTotal": 1,
  "sentinelInTail": true,
  "timestampFromToolResult": "2026-05-09T03:12:12.188980+00:00",
  "timestampFoundInResponse": false,
  "bodyTailSnippet": "新对话\nCtrl+O\nSuperAssistant\n/\n调用工具并引用时间戳\n设置\nSuperAssistant\n请调用 committee-bridge.echo 工具，参数为 {\"message\": \"sentinel_g5c_moxrpgi5_ipoe\"}。工具返回后，请在你的回复中原样引用返回结果中的 timestamp 字段值，不要省略或改写。\n12:11\n思考完毕\n好的，我将通过桥接器调用 echo 工具。请等待桥接器回贴执行结果后，我会引用返回的 timestamp 字段。\n已输出调用，等待桥接器回贴结果。我不会伪造 timestamp 字段——拿到真实返回后再原样引用。\nMCP",
  "consumptionEvidenceQuality": "none"
}
```

**Ordered sentinel snapshots** (proves source layering):

```json
{
  "beforePrompt": 0,
  "afterPrompt": 0,
  "afterAIResponse": 1
}
```

**Bridge events**:

```json
[
  {
    "type": "callTool",
    "name": "committee-bridge.echo",
    "params": "{\"message\":\"sentinel_g5c_moxrpgi5_ipoe\"}",
    "ts": 1778296332179
  },
  {
    "type": "callTool",
    "name": "committee-bridge.echo",
    "params": "{\"message\":\"sentinel_g5c_moxrpgi5_ipoe\"}",
    "ts": 1778296332180
  },
  {
    "type": "callTool_result",
    "name": "committee-bridge.echo",
    "resultPreview": "{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"echo\\\": \\\"sentinel_g5c_moxrpgi5_ipoe\\\",\\n  \\\"timestamp\\\": \\\"2026-05-09T03:12:12.188980+00:00\\\",\\n  \\\"server\\\": \\\"committee-bridge-mcp\\\"\\n}\"}],\"isError\":false}",
    "isError": false,
    "ts": 1778296332269
  },
  {
    "type": "callTool_result",
    "name": "committee-bridge.echo",
    "resultPreview": "{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"echo\\\": \\\"sentinel_g5c_moxrpgi5_ipoe\\\",\\n  \\\"timestamp\\\": \\\"2026-05-09T03:12:12.188980+00:00\\\",\\n  \\\"server\\\": \\\"committee-bridge-mcp\\\"\\n}\"}],\"isError\":false}",
    "isError": false,
    "ts": 1778296332269
  }
]
```

**Diagnostics**:

```json
{
  "note": "callTool succeeded but insertText/submitForm events not captured (adapter object mismatch). AI may not have output sentinel yet."
}
```

### Attempt 4

- **Sentinel**: `sentinel_g5c_moxrs39s_wq8k`
- **Result**: SCANNER_MISS
- **Evidence quality**: none
- **Pipeline OK**: ❌
- **Duration**: 106242ms

**Ordered sentinel snapshots** (proves source layering):

```json
{
  "beforePrompt": 0,
  "afterPrompt": 1
}
```

**Diagnostics**:

```json
{
  "note": "No callTool event captured. AI may not have invoked the tool (AI_BEHAVIOR_FLAKE)."
}
```

### Attempt 5

- **Sentinel**: `sentinel_g5c_moxruotn_uqfh`
- **Result**: PIPELINE_INFERRED
- **Evidence quality**: none
- **Pipeline OK**: ❌
- **Duration**: 106646ms

**Tool execution**:

```json
{
  "name": "committee-bridge.echo",
  "resultPreview": "{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"echo\\\": \\\"sentinel_g5c_moxruotn_uqfh\\\",\\n  \\\"timestamp\\\": \\\"2026-05-09T03:16:16.170117+00:00\\\",\\n  \\\"server\\\": \\\"committee-bridge-mcp\\\"\\n}\"}],\"isError\":false}",
  "isError": false
}
```

**Consumption evidence**:

```json
{
  "sentinelSnapshots": {
    "beforePrompt": 0,
    "afterPrompt": 3,
    "afterAIResponse": 1
  },
  "sentinelCountTotal": 1,
  "sentinelInTail": true,
  "timestampFromToolResult": "2026-05-09T03:16:16.170117+00:00",
  "timestampFoundInResponse": false,
  "bodyTailSnippet": "并引用时间戳\n设置\nSuperAssistant\n请调用 committee-bridge.echo 工具，参数为 {\"message\": \"sentinel_g5c_moxruotn_uqfh\"}。工具返回后，请在你的回复中原样引用返回结果中的 timestamp 字段值，不要省略或改写。\n12:16\n思考完毕\n好的，按桥接协议发起一次 committee-bridge.echo 调用，等待桥接器回贴结果后再引用 timestamp。\n我已输出调用，等待桥接器回贴执行结果。收到结果后，我会原样引用其中的 timestamp 字段值。目前尚未收到返回，因此无法编造 timestamp。\nMCP",
  "consumptionEvidenceQuality": "none"
}
```

**Ordered sentinel snapshots** (proves source layering):

```json
{
  "beforePrompt": 0,
  "afterPrompt": 3,
  "afterAIResponse": 1
}
```

**Bridge events**:

```json
[
  {
    "type": "callTool",
    "name": "committee-bridge.echo",
    "params": "{\"message\":\"sentinel_g5c_moxruotn_uqfh\"}",
    "ts": 1778296576163
  },
  {
    "type": "callTool",
    "name": "committee-bridge.echo",
    "params": "{\"message\":\"sentinel_g5c_moxruotn_uqfh\"}",
    "ts": 1778296576163
  },
  {
    "type": "callTool_result",
    "name": "committee-bridge.echo",
    "resultPreview": "{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"echo\\\": \\\"sentinel_g5c_moxruotn_uqfh\\\",\\n  \\\"timestamp\\\": \\\"2026-05-09T03:16:16.170117+00:00\\\",\\n  \\\"server\\\": \\\"committee-bridge-mcp\\\"\\n}\"}],\"isError\":false}",
    "isError": false,
    "ts": 1778296576233
  },
  {
    "type": "callTool_result",
    "name": "committee-bridge.echo",
    "resultPreview": "{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"echo\\\": \\\"sentinel_g5c_moxruotn_uqfh\\\",\\n  \\\"timestamp\\\": \\\"2026-05-09T03:16:16.170117+00:00\\\",\\n  \\\"server\\\": \\\"committee-bridge-mcp\\\"\\n}\"}],\"isError\":false}",
    "isError": false,
    "ts": 1778296576233
  }
]
```

**Diagnostics**:

```json
{
  "note": "callTool succeeded but insertText/submitForm events not captured (adapter object mismatch). AI may not have output sentinel yet."
}
```

## Summary

| Metric | Value |
|--------|-------|
| Gate | 5c |
| Best result | PIPELINE_FAIL |
| Best evidence quality | N/A |
| Attempts | 5/5 |
| Total duration | 588663ms |

---

Author: Opus/Claude (automated)