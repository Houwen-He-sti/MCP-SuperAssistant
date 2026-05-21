# Prompt Templates

This directory contains externalized prompt templates that were previously hardcoded in TypeScript source files.

## Files

| File | Source | Used by |
|------|--------|---------|
| `notion-bridge.md` | `notion.adapter.ts` BRIDGE_PROMPT | Notion AI native agent — injected on first conversation |
| `base-jsonl-protocol.md` | `instructionGeneratorJson.ts` | All platforms — JSONL codeblock tool-call protocol |
| `chatgpt-supplement.md` | `website_specific_instruction/chatgpt.ts` | ChatGPT-specific behavior rules |
| `gemini-supplement.md` | `website_specific_instruction/gemini.ts` | Gemini-specific behavior rules |

## Tag Convention

When the system instruction is injected into a conversation, it is wrapped with:

```
<mcp-system-prompt>
...entire system instruction...
</mcp-system-prompt>
```

This allows MCP-SuperAssistant's DOM observer to detect and render it as a
collapsible card instead of a wall of text.

## Variable Substitution

Templates use `{{VARIABLE}}` placeholders:

- `{{TOOL_LIST}}` — dynamically generated list of available tools with schemas
- `{{CUSTOM_INSTRUCTIONS}}` — user-provided custom instructions (if enabled)
- `{{PLATFORM_SUPPLEMENT}}` — platform-specific supplement (chatgpt/gemini)
