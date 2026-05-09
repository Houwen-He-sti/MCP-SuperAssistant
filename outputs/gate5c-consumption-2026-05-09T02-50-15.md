# Gate 5c Consumption E2E Evidence — 2026-05-09T02:49:44.902Z

## Result: CONSUMPTION_PASS

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

## Consumption Attempts (1/5)

### Attempt 1

- **Sentinel**: `sentinel_g5c_moxqxcip_k53o`
- **Result**: CONSUMPTION_PASS
- **Evidence quality**: assistant_delta
- **Pipeline OK**: ❌
- **Duration**: 19915ms

**Tool execution**:

```json
{
  "name": "committee-bridge.echo",
  "resultPreview": "{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"echo\\\": \\\"sentinel_g5c_moxqxcip_k53o\\\",\\n  \\\"timestamp\\\": \\\"2026-05-09T02:50:12.188057+00:00\\\",\\n  \\\"server\\\": \\\"committee-bridge-mcp\\\"\\n}\"}],\"isError\":false}",
  "isError": false
}
```

**Consumption evidence**:

```json
{
  "sentinelSnapshots": {
    "beforePrompt": 0,
    "afterPrompt": 2,
    "afterAIResponse": 3
  },
  "sentinelCountTotal": 3,
  "sentinelInTail": true,
  "bodyTailSnippet": "状态\n1 天\n新对话\nCtrl+O\nSuperAssistant\n/\n调用工具并引用返回值\n设置\nSuperAssistant\n请调用 committee-bridge.echo 工具，参数为 {\"message\": \"sentinel_g5c_moxqxcip_k53o\"}。工具返回后，请在你的回复中原样引用返回的 message 值（即 sentinel_g5c_moxqxcip_k53o），不要省略或改写。\n11:49\n思考完毕\n调用 echo 工具进行连通性测试。\n等待桥接器回贴结果后，我会原样引用返回的 message 值：sentinel_g5c_moxqxcip_k53o\nMCP",
  "consumptionEvidenceQuality": "assistant_delta"
}
```

**Ordered sentinel snapshots** (proves source layering):

```json
{
  "beforePrompt": 0,
  "afterPrompt": 2,
  "afterAIResponse": 3
}
```

## Summary

| Metric | Value |
|--------|-------|
| Gate | 5c |
| Best result | CONSUMPTION_PASS |
| Best evidence quality | assistant_delta |
| Attempts | 1/5 |
| Total duration | 30887ms |

---

Author: Opus/Claude (automated)