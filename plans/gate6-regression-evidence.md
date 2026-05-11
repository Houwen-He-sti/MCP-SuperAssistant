# Gate 6 — Lane A Regression Probe Evidence

**Date**: 2026-05-11T05:13:05.082Z  
**Verdict**: ✅ PASS (all 7/7 checks)  
**Provider**: ChatGPT  
**Extension**: MCP SuperAssistant (ID: hkjclekhnaffnhldgpmjnohihjmblbpj)

## Payload

- Kind: `merged-2-json-regression` (2 canonical `<function_results>` blocks)
- Chars: 534
- SHA256 prefix: `0a8fe71e26f9d948`
- Call IDs: `regr_g6_001` (read_file), `regr_g6_002` (list_dir)

## Check Results

| Check | Result |
|-------|--------|
| batchOrSingleContainer | ✅ PASS |
| multipleResultsRendered | ✅ PASS (2 sub-cards) |
| bothCallIdsVisible | ✅ PASS |
| contentNonEmpty | ✅ PASS (81 + 88 chars) |
| noRawXml | ✅ PASS |
| expandButtonsPresent | ✅ PASS (2 buttons) |
| reactStable | ✅ PASS (card persists after 2s) |

## DOM Snapshot

- Batch container class: `function-block function-result-batch-container theme-dark`
- Batch header: "Function Results (2 calls)"
- Header texts: `["Function Results (2 calls)", "read_file", "list_dir"]`
- Content area 1: 81 chars, hasChildren=true
- Content area 2: 88 chars, hasChildren=true

## Pre-fix Comparison (OLD code, same payload)

First probe with old code showed:
- Only 1 result container (not batch)
- Only first call_id visible (`regr_g6_001`)
- Content area empty (0 chars)
- Header: "Function Result" (singular)
- Class: `function-block function-result-container theme-dark`

## Conclusion

Gate 6 fix successfully transforms the rendering from single-card-with-empty-content to batch-card-with-both-results. Root cause (regex mismatch + single card replacement) is resolved.
