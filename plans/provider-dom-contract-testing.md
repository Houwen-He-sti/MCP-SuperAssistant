# Provider DOM Contract Testing

## Purpose

Mocked DOM tests validate extension behavior under an assumed provider page structure. Provider DOM contract tests validate that the assumption still matches real provider pages.

This document defines the testing layer that prevents mocked E2E tests from giving false confidence when a provider changes its DOM structure.

## Core principle

> Mocked DOM E2E can prove that the scanner, batch, handler, and renderer logic works against a known DOM shape. It cannot prove that ChatGPT, Notion, Copilot, Gemini, or any other real provider page still exposes that DOM shape.

Therefore, browser runtime features that rely on provider DOM selectors must have provider DOM contract evidence.

## Test layer distinction

| Test type | Purpose | Typical target |
|---|---|---|
| Unit tests | Validate isolated parser / scanner / collector / formatter logic. | Pure TypeScript modules. |
| Mocked DOM E2E | Validate behavior under a controlled DOM fixture. | CDP page with injected assistant messages / code blocks. |
| Provider DOM Contract Test | Validate real provider DOM selectors and message boundaries. | Live provider page, no MCP execution required. |
| Full Pipeline Integration | Validate extension -> proxy -> MCP server -> extension result flow. | Local browser + extension + proxy + fake MCP server. |
| Manual AI Smoke | Validate real model behavior and prompt compliance. | Real provider conversation. |

## Merge Gate vs Release Gate

| Test Layer | Merge Gate | Release Gate |
|------------|------------|--------------|
| Unit tests | Always | Always |
| Mocked DOM E2E | Required for DOM-touching logic | Required |
| Provider DOM Contract | Required when provider selectors, message boundaries, codeblock tracing, input, submit, or mount points are affected | Required |
| Full Pipeline Integration | Required when cross-process, transport, batching, result injection, or submit behavior changes | Required |
| Manual AI Smoke | Not required for every PR | Required for release milestones |

Merge 前必须:

- 改 selector / message boundary / codeblock tracing / input / submit → Provider DOM Contract
- 改 batch / collector / result injection / extension-proxy-MCP 通信 → Full Pipeline Integration
- 改单工具和多工具共同路径 → Test 6 (single tool regression)
- 改 timeout / suppression / flush → Test 4

Release 前必须:

- 每个支持的 provider 至少一次 DOM contract check
- 至少一次真实 provider 页面 end-to-end smoke

## Required contracts

A provider DOM contract test should check only structural assumptions, not model quality. For each supported provider, verify the relevant subset of:

1. assistant message container selector is still valid;
2. assistant message boundary can be found from a code block using the scanner strategy;
3. message identity is stable, or the fallback strategy is deterministic;
4. tool-call code blocks can be found and traced to their parent assistant message;
5. input field selector is still valid;
6. submit button selector is still valid;
7. tool result card mount point is still valid when the feature depends on it;
8. provider-specific constraints are recorded, such as Notion block layout or Copilot message wrapper changes.

## Full Pipeline Integration Test Matrix

### Minimum merge-gate tests (P0)

| Test | Scenario | Key Assertions |
|------|----------|---------------|
| Test 6 | Single tool regression | Single tool still works through unified batchHandler, no extra wait, result format unchanged |
| Test 1 | Two independent tools, both success | MCP server receives 2 calls, merged result has 2 function_results, submit happens once, order matches call order |
| Test 2 | Slow first / fast second (latency race) | Output order = call order (not return order), batch collector holds fast result until slow completes |

### Conditional merge-gate tests (P0 when affected path changed)

| Test | Scenario | When Required | Key Assertions |
|------|----------|--------------|---------------|
| Test 4 | Timeout partial flush + late result suppression | When timeout/suppression/batch lifecycle changed | First flush contains early result only, late result doesn't trigger second insert/submit |

### Expanded regression tests (P1 follow-up)

| Test | Scenario |
|------|----------|
| Test 3 | One success + one error (partial failure) |
| Test 5 | DOM rescan / duplicate detection |

## Recommended Test Architecture

```text
Test browser page (fake chat page with deterministic DOM)
  ↓
Loaded MCP-SuperAssistant extension
  ↓
Local proxy (packages/proxy)
  ↓
Fake MCP server with deterministic tools:
  - echo_fast (instant response)
  - echo_slow (configurable delay)
  - fail_tool (returns MCP error)
  - json_tool (returns structured data)
```

The fake chat page provides:

- assistant message DOM containers
- code block elements with tool call content
- input textarea
- submit button
- submit counter (for assertion)

This allows testing real extension/proxy/MCP channel without depending on real AI.

## Rollout Plan

| Phase | Content | Priority |
|-------|---------|----------|
| Phase A | Provider DOM contract scripts (ChatGPT, Notion) | High — prerequisite for Phase 2-4 merge confidence |
| Phase B | Minimal full pipeline integration (Test 6, 1, 2) | High — covers core multi-tool path |
| Phase C | Expanded regression matrix (Test 3, 4, 5) | Medium — after Phase B proves architecture |
| Phase D | Release smoke checklist documentation | Low — before first release milestone |

## Minimal output format

A contract script should output a provider-specific checklist, for example:

```text
ChatGPT DOM Contract
- assistant message selector: PASS
- message id / fallback: PASS
- codeblock parent tracing: PASS
- input selector: PASS
- submit button selector: PASS
```

Failures should be actionable: the output must identify the failed selector or boundary assumption.

## Suggested script layout

Start with one generic script if possible:

```text
scripts/e2e-provider-dom-contract.cjs
```

If provider differences become large, split by provider:

```text
scripts/e2e-chatgpt-dom-contract.cjs
scripts/e2e-notion-dom-contract.cjs
scripts/e2e-copilot-dom-contract.cjs
```

## Policy for browser runtime PRs

A browser runtime PR may use mocked DOM E2E for deterministic behavior coverage, but it must not claim real provider compatibility from mocked DOM alone.

If the PR depends on provider DOM selectors, it must include one of:

1. a provider DOM contract test result;
2. a real DOM observation log;
3. a clear statement that the PR is plan-only / mock-only and still requires provider contract verification before production merge.

## Relation to multi-tool call support

Multi-tool call support depends on assistant message boundaries and code block parent tracing. The mocked tests prove batch grouping logic only if real provider DOM still exposes the expected message/codeblock relationship.

For multi-tool support, provider DOM contract evidence should verify at minimum:

1. multiple code blocks in the same assistant message can be traced to the same message container;
2. code blocks in different assistant messages are not grouped together;
3. message IDs or fallback IDs are stable enough for dedupe keys;
4. input and submit selectors support one merged result insertion and one submit.

## Non-goals

Provider DOM contract tests are not intended to validate:

- whether the AI model chooses to call tools correctly;
- whether the MCP server returns correct business data;
- whether proxy transport works under load;
- visual perfection of UI cards.

Those belong to manual AI smoke, full pipeline integration, and UI review respectively.
