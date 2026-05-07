# Browser Micro-kernel and Temporary Script Promotion

## Status

Discussion document for the next architecture step after PR #4 / PR #6.

This document records the consensus that emerged from the Notion AI MAIN-world interceptor work:

> Temporary browser automation scripts are not disposable artifacts. When they verify real browser behavior, they contain distilled operational knowledge and should be promoted into reusable project assets.

---

## 1. Core observation

During the Notion AI stream-interceptor work, several browser verification scripts were written as temporary local files, for example under `C:\temp\xxx.js`.

That is acceptable during exploration. The problem is not the existence of temporary scripts. The problem is when a temporary script successfully verifies browser behavior, DOM behavior, stream behavior, config-channel behavior, or MCP connectivity, but the knowledge remains outside the repository.

If verified behavior remains only in `C:\temp`, `/tmp`, a terminal history, or a chat transcript, then the next model / agent / human executor has to rediscover the same behavior from scratch.

That creates avoidable waste:

```text
same DOM probes are rewritten
same stream fixtures are rewritten
same DevTools snippets are rewritten
same postMessage checks are rewritten
same Notion input insertion tests are rewritten
same MCP handshake checks are rewritten
```

The deeper conclusion is:

> A verified temporary script is a token-produced experiment that has already paid for discovery. Its useful knowledge should be distilled into core code, tests, debug tooling, fixtures, or documentation.

---

## 2. Token → experiment → verified knowledge → core asset

In this project, model-generated scripts are not merely text output.

They are part of an empirical loop:

```text
model tokens
  -> generated script
  -> run against real browser / real page / real MCP proxy
  -> produce logs or behavior evidence
  -> reviewer interprets result
  -> useful behavior becomes reusable project knowledge
```

This means a script that has been run successfully is different from an unused suggestion. It has passed through reality.

The project should therefore treat successful exploratory scripts as candidates for promotion.

The promotion path should be:

```text
temporary script
  -> inventory
  -> classify
  -> extract reusable behavior
  -> promote to core / tests / debug / fixture / docs
  -> remove or archive the temporary original
```

This is how model tokens are converted into durable engineering capital.

---

## 3. Why this aligns with the browser micro-kernel direction

The Notion AI work revealed a strong architectural fact:

> Browser-internal behavior is most naturally expressed in JavaScript / TypeScript.

Examples:

```text
DOM probe
contenteditable input
Selection API
InputEvent / KeyboardEvent
MutationObserver
ReadableStream wrapping
window.fetch patching
window.postMessage bridge
MAIN world / ISOLATED world communication
Notion / ChatGPT / Claude page-state detection
```

When these behaviors are driven from Python / Playwright, the implementation often becomes:

```text
Python controller
  -> page.evaluate(...)
  -> embedded JavaScript string
  -> browser behavior
```

In other words, Python still ends up delegating the browser-native part to JavaScript.

That does not mean Python is useless. It means Python should not own browser-internal details.

The cleaner split is:

```text
Browser internal layer:
  TypeScript / JavaScript micro-kernel
  - findInput()
  - insertText()
  - submit()
  - observeAssistantMessages()
  - observeStream()
  - detectFunctionCall()
  - injectFunctionResult()
  - probeCurrentPageState()

Outer orchestration layer:
  Python / Node / MCP host
  - launch browser
  - manage tabs / sessions
  - coordinate models
  - call external tools
  - collect logs
  - run E2E scenarios
  - enforce high-level permissions
```

This is not a language preference. It is an architectural boundary.

The browser runtime should be implemented in the browser's native language environment. The outer coordinator should orchestrate, not micromanage DOM mechanics.

---

## 4. Temporary scripts as probes for future core APIs

A temporary script often starts as a direct probe:

```text
Can we insert text into Notion's input?
Can we enable the send button?
Can we patch fetch before Notion caches it?
Can we observe a ReadableStream line by line?
Can we postMessage from MAIN to ISOLATED?
Can we verify that the MCP proxy is connected?
```

Once such a script succeeds, it should be examined as a possible prototype of a future API.

Examples:

| Temporary script behavior | Possible promoted form |
|---|---|
| finds Notion contenteditable input | `NotionAdapter.findInput()` |
| inserts text and verifies send button | `ProviderAdapter.insertText()` + probe test |
| simulates NDJSON stream | `tests/fixtures/notion-function-call-stream.ts` |
| verifies MAIN fetch patch | `scripts/e2e/verify-main-world-interceptor.ts` |
| checks postMessage config channel | `scripts/e2e/verify-config-channel.ts` |
| captures stream payload shape | sanitized fixture + parser test |
| MCP proxy handshake check | `scripts/debug/check-mcp-proxy.ts` |

The key rule is:

> A temporary script should not be judged only by its file name or location. It should be judged by the behavior it verified.

---

## 5. Promotion categories

Every verified temporary script should be classified into one of the following outcomes.

### 5.1 Promote to core runtime

Use this when the script discovers a stable browser capability that the product must perform repeatedly.

Examples:

```text
find input box
insert text
submit message
observe stream
detect page state
inject function result
```

Destination examples:

```text
pages/content/src/render_prescript/src/adapters/
pages/content/src/render_prescript/src/stream/
packages/core-runtime/
```

### 5.2 Promote to reusable E2E / test script

Use this when the script verifies a regression-sensitive path.

Examples:

```text
MAIN world interceptor installs before page JS
cutoffEnabled config reaches MAIN world
simulated function_call stream emits stream_cutoff
function_result insertion leaves text in input
```

Destination examples:

```text
scripts/e2e/
tests/e2e/
```

### 5.3 Promote to debug tooling

Use this when the script is mainly useful for manual diagnosis.

Examples:

```text
dump active fetch wrappers
inspect current adapter
check MCP proxy connection
print plugin registry state
capture DOM candidate scores
```

Destination examples:

```text
scripts/debug/
scripts/devtools/
```

### 5.4 Convert into fixture or documentation

Use this when the script itself is not reusable, but the observed result is important.

Examples:

```text
real Notion NDJSON payload sample
console log proving SES order
known failed selector attempt
known Notion server 500/404 behavior
```

Destination examples:

```text
tests/fixtures/
outputs/
plans/
docs/evidence/
```

### 5.5 Discard with explicit reason

Use this when the script has no durable value.

Even then, the reason should be stated:

```text
superseded by core API
incorrect experiment
duplicate of existing script
unsafe to keep
contains sensitive local data
```

---

## 6. Required inventory format

When temporary scripts are discovered, they should be inventoried before deletion.

Suggested table:

```text
filename
purpose
what behavior it verified
how to run
inputs / outputs
dependencies
evidence / logs produced
promotion category
recommended repo destination
discard reason, if any
```

Example:

```text
C:\temp\verify-main-world-fetch.js
Purpose: verify MAIN world fetch wrapper is in Notion's fetch call stack
Evidence: console stack trace showing stream-interceptor-main.iife.js:1 fetch
Promotion: reusable E2E/debug script
Destination: scripts/e2e/verify-main-world-interceptor.ts
```

---

## 7. Why JS/TS is preferred for browser micro-kernel code

For browser-internal automation, JS/TS has structural advantages:

```text
same runtime as target page
native DOM APIs
native events
native streams
native MutationObserver
native contenteditable behavior
native postMessage semantics
natural TypeScript interfaces for adapters
```

Python / Playwright remains valuable for outer orchestration, but if most of a Python automation step is `page.evaluate(() => { ... })`, then the browser behavior probably belongs in the JS/TS micro-kernel.

Bad long-term shape:

```text
Python script owns DOM details
  -> embeds large JS strings
  -> each test reinvents selectors
  -> browser behavior knowledge remains outside core runtime
```

Better long-term shape:

```text
TS browser micro-kernel owns DOM behavior
Python / Node orchestration calls stable browser runtime APIs
E2E scripts verify those APIs against real providers
```

---

## 8. Relation to existing architecture principles

This document extends the existing refactor principles:

### Interface-first

Temporary scripts that discover stable behavior should become stable interfaces.

```text
from: document.querySelector(...) in C:\temp\x.js
to: ProviderAdapter.findInput()
```

### Registry-first

If a temporary script discovers a capability, that capability should be registered.

```text
adapter.capabilities.inputInsertion = true
adapter.capabilities.streamObservation = true
```

### Probe-first

Temporary DOM scripts are often raw probes. Successful probes should be formalized as scoring / verification logic.

```text
candidate selectors
  -> visibility check
  -> role/contenteditable check
  -> insert/rollback check
  -> send-button enablement check
```

### Single source of truth

A verified behavior should not live only in a temporary script if the core runtime depends on it.

```text
script result -> fixture / test / doc / adapter implementation
```

---

## 9. Application to Notion AI review workflow

The immediate project goal is to make Notion AI a real code-review committee member.

That requires:

```text
Notion AI stream observation
  -> function_call detection
  -> stream_cutoff event
  -> streamToolBridge execution
  -> MCP safe tool call
  -> function_result insertion
  -> Notion AI continuation
```

Temporary scripts used to verify any part of this chain should be promoted.

Especially important candidates:

```text
MAIN world fetch verification
config channel verification
simulated function_call NDJSON stream
stream_cutoff smoke test
Notion input insertion
send-button enablement probe
MCP proxy handshake
GitHub read-only tool call demo
```

These are not incidental scripts. They are the scaffolding from which the production review workflow will be built.

---

## 10. Proposed policy

Add the following policy to project operating rules:

```text
Temporary Script Promotion Rule:

Exploratory scripts are allowed, but any script that successfully verifies
browser behavior, protocol behavior, DOM behavior, stream behavior, or MCP
integration must be reviewed for promotion.

After use, every temporary script must be classified as one of:
1. promote to core runtime;
2. promote to reusable test / E2E script;
3. promote to debug tooling;
4. convert into fixture / documentation;
5. discard with reason.

No verified behavior should remain only in C:\temp, /tmp, or an untracked local script.
```

---

## 11. Open questions

1. Should `scripts/e2e/` live in `MCP-SuperAssistant`, `VSCode-Dir`, or the future `ai-dispatch` repository?
2. Should browser runtime APIs be extracted into a standalone package before or after Notion Phase 3 Gate 4?
3. Should temporary script inventory be required in PR descriptions whenever local scripts were used for E2E verification?
4. Should we create a standard `scripts/temp-inventory.template.md`?
5. Should JS/TS become the default language for browser-internal probes, with Python reserved for orchestration?

---

## 12. Final statement

The project is not merely automating webpages.

It is converting repeated model-driven exploration into a stable browser micro-kernel and a reusable multi-model collaboration runtime.

The rule is therefore:

> Explore freely, but promote verified knowledge. Do not let proven browser behavior die in temporary scripts.
