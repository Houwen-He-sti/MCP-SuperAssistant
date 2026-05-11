# Open Discussion: Browser Micro-kernel and Temporary Script Promotion

## Purpose

This document/PR exists only to keep the discussion open after the main architecture document was merged.

Merged document:

```text
plans/browser-micro-kernel-script-promotion.md
```

This discussion should remain open until we decide how to operationalize the temporary script promotion rule.

---

## Core principle

Temporary scripts are not disposable if they verified real behavior.

Any script that successfully verifies browser behavior, DOM behavior, stream behavior, protocol behavior, MCP integration, or provider-specific page behavior should be classified as one of:

```text
1. promote to core runtime;
2. promote to reusable test / E2E script;
3. promote to debug tooling;
4. convert into fixture / documentation;
5. discard with explicit reason.
```

---

## Open discussion topics

1. Should `scripts/e2e/` live in `MCP-SuperAssistant`, `VSCode-Dir`, or a future `ai-dispatch` repo?
2. Should browser runtime APIs be extracted before or after Notion Phase 3 Gate 4?
3. Should temporary script inventory be required in PR descriptions whenever local scripts were used for E2E verification?
4. Should we add a standard `scripts/temp-inventory.template.md`?
5. Should JS/TS become the default language for browser-internal probes, with Python/Node reserved for orchestration?
6. How should scripts under `C:\temp`, `/tmp`, or local scratch directories be inventoried?
7. Which PR #4 / PR #6 verification scripts should be promoted first?

---

## Current preferred direction

```text
Browser internal layer:
  TypeScript / JavaScript micro-kernel
  - DOM probe
  - input insertion
  - stream observation
  - function_result injection
  - provider page-state detection

Outer orchestration layer:
  Python / Node / MCP host
  - launch browser
  - coordinate sessions
  - collect logs
  - call external tools
  - run E2E scenarios
```

---

## Related

- PR #4: MAIN world interceptor
- PR #5: Phase 3 planning
- PR #6: Phase 3 Gate 1 config split
- PR #7: merged browser micro-kernel / temporary script promotion document
