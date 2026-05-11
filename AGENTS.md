# MCP-SuperAssistant Agent Rules

This file records project-level workflow rules for agents working on MCP-SuperAssistant.

## Browser Runtime Testing Discipline

### Mocked DOM is not a provider DOM contract

Mocked DOM E2E tests validate behavior under an assumed DOM shape. They do **not** prove that the real provider page still satisfies that assumption.

Any feature that depends on provider DOM selectors, assistant message boundaries, code block structure, input fields, submit buttons, or tool-result mount points must include one of the following before it is treated as production-ready:

1. a real provider DOM contract observation; or
2. a provider DOM contract regression test; or
3. a clearly documented manual observation with captured evidence and a follow-up automation plan.

This applies especially to browser runtime work involving ChatGPT, Notion, Copilot, Gemini, DeepSeek, Qwen, or other provider pages.

### Required distinction

Agents must distinguish these test layers:

| Layer | Purpose |
|---|---|
| Unit tests | Validate isolated parser, scanner, collector, and formatter logic. |
| Mocked DOM E2E | Validate browser-side behavior under an assumed DOM structure. |
| Provider DOM Contract Test | Validate that real provider pages still match the selectors and boundaries used by mocked tests. |
| Full Pipeline Integration | Validate extension -> proxy -> MCP server -> extension result flow. |
| Manual AI Smoke | Validate real model behavior and prompt compliance on live provider pages. |

### Review rule

When reviewing browser runtime PRs, do not accept mocked DOM E2E as proof that provider DOM selectors are still valid. If a PR changes or relies on provider DOM assumptions, the review must ask for provider DOM contract evidence unless the PR explicitly states that the work is plan-only or mock-only.

See also: `plans/provider-dom-contract-testing.md`.
