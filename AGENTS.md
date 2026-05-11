# MCP-SuperAssistant Agent Rules

This file records project-level workflow rules for agents working on MCP-SuperAssistant.

## Browser Runtime Testing Discipline

### Testing Discipline: Mocked DOM vs Real Provider DOM Contract

Mocked DOM E2E tests validate scanner, batch, handler, and injection behavior under an assumed DOM contract. They do **not** validate that the real provider page still satisfies that contract.

Any browser-runtime functionality that depends on provider DOM selectors, assistant message boundaries, codeblock structure, input elements, submit controls, SPA navigation, or provider-specific mount points must include real-contract validation appropriate to the affected surface.

Required test responsibilities:

| Test Layer | What It Proves | Merge Gate | Release Gate |
|------------|----------------|------------|--------------|
| Unit tests | Pure logic correctness | Always | Always |
| Mocked DOM E2E | Behavior under assumed DOM structure | Required for DOM-touching logic | Required |
| Provider DOM Contract | Real provider DOM assumptions still hold | Required when provider selectors, message boundaries, codeblock tracing, input, submit, or mount points are affected | Required |
| Full Pipeline Integration | Extension/proxy/MCP/server/submit path works across real component boundaries | Required when cross-process, transport, batching, result injection, or submit behavior changes | Required |
| Manual AI Smoke | Real model behavior on real provider UI | Not required for every PR | Required for release milestones |

Mocked DOM E2E alone is insufficient merge confidence for browser-runtime changes that depend on provider-specific DOM contracts.

Provider DOM Contract checks should cover, when applicable:

- assistant message selector
- stable message identity or fallback identity
- codeblock-to-assistant-message ownership tracing
- input textarea/editor selector
- submit button/control selector
- assistant message boundary detection
- provider-specific mount point selection

Full Pipeline Integration should prioritize existing production compatibility before edge cases. For multi-tool support, the minimum merge-gate matrix is:

1. Single tool regression
2. Two tools success, merged once
3. Slow/fast out-of-order results with deterministic output order
4. Timeout partial flush and late result suppression, when timeout/suppression/batch lifecycle changed

Manual provider smoke tests are release-gate evidence unless a PR specifically changes real provider interaction behavior that cannot be covered by automated contract/integration tests.

### Review rule

When reviewing browser runtime PRs, do not accept mocked DOM E2E as proof that provider DOM selectors are still valid. If a PR changes or relies on provider DOM assumptions, the review must ask for provider DOM contract evidence unless the PR explicitly states that the work is plan-only or mock-only.

See also: `plans/provider-dom-contract-testing.md`.
