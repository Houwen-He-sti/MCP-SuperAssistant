/**
 * Unit tests for notionTurnDiscovery.ts (Gate 6 Lane B)
 *
 * Tests the Notion AI chat turn candidate discovery logic:
 *   - isNotionHost()
 *   - containsFunctionResultLikeText()
 *   - findPossibleTurnLanes()
 *   - getNotionFunctionResultCandidates()
 *
 * Run: node --test --experimental-strip-types notionTurnDiscovery.test.ts
 * (from render_prescript/src/observer/ directory)
 *
 * These tests use JSDOM-like DOM construction via the global document/HTMLElement.
 * Since node:test runs in Node.js (no native DOM), we use a minimal DOM shim.
 */

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import {
  isNotionHost,
  containsFunctionResultLikeText,
  findPossibleTurnLanes,
  getNotionFunctionResultCandidates,
} from './notionTurnDiscovery.ts';

// --- Minimal DOM shim for Node.js ---
// We need HTMLElement, document.querySelectorAll, element.querySelector, etc.
// Use linkedom which is lighter than jsdom and works with node:test.

import { parseHTML } from 'linkedom';

// Helper to create a test DOM from HTML string
// Also patches globalThis.HTMLElement so instanceof checks work in Node.js
function createTestDOM(html: string): { document: Document; root: HTMLElement } {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  // Patch globalThis.HTMLElement for instanceof checks in production code
  if (typeof globalThis.HTMLElement === 'undefined') {
    (globalThis as any).HTMLElement = document.body.constructor;
  }
  return { document, root: document.body as unknown as HTMLElement };
}

// --- Test fixtures ---

/**
 * Canonical function_results XML (as submitted by MCP extension).
 * In the real Notion DOM, this appears as TEXT CONTENT in the user turn div,
 * not as parsed HTML elements. So test fixtures must use HTML entities to
 * produce the correct textContent.
 */
const FUNCTION_RESULTS_ESCAPED = `&lt;function_results&gt;
  &lt;result call_id="call_abc" name="read_file" status="success"&gt;
    &lt;content type="text/plain"&gt;file content here&lt;/content&gt;
  &lt;/result&gt;
&lt;/function_results&gt;`;

/** User turn with function results (text, not parsed HTML) */
const USER_TURN_WITH_RESULTS = `<div>${FUNCTION_RESULTS_ESCAPED}</div>`;

/** AI turn with thinking block + content root (quotes function_results in response) */
const AI_TURN_QUOTING_XML = `<div>
  <div>思考完毕</div>
  <div>
    <div data-content-editable-root="true" class="whenContentEditable">
      <div>The function_results XML you sent was: &lt;function_results&gt;...&lt;/function_results&gt;</div>
    </div>
  </div>
</div>`;

/** AI turn without thinking block but with content root */
const AI_TURN_NO_THINKING = `<div>
  <div data-content-editable-root="true" class="whenContentEditable">
    <div>Here is the response with &lt;function_results&gt; mentioned</div>
  </div>
</div>`;

/** AI turn that actually contains raw function_results text in content root */
const AI_TURN_RAW_XML_IN_CONTENT = `<div>
  <div data-content-editable-root="true" class="whenContentEditable">
    <div>&lt;function_results&gt;&lt;result call_id="call_xyz" name="test"&gt;data&lt;/result&gt;&lt;/function_results&gt;</div>
  </div>
</div>`;

/** Simple user turn without function results */
const USER_TURN_PLAIN = `<div>Hello, this is a plain user message</div>`;

/** Notion-like DOM: container > wrapper > turn lane > turns */
const NOTION_CHAT_DOM = `
<div class="notion-selectable-container">
  <div class="autolayout-col autolayout-fill-width">
    ${USER_TURN_WITH_RESULTS}
    ${AI_TURN_QUOTING_XML}
    ${USER_TURN_PLAIN}
    ${AI_TURN_NO_THINKING}
  </div>
</div>`;

/** Notion-like DOM with extra wrapper layers between container and lane */
const NOTION_CHAT_DOM_EXTRA_WRAPPER = `
<div class="notion-selectable-container">
  <div>
    <div>
      <div class="autolayout-col autolayout-fill-width">
        ${USER_TURN_WITH_RESULTS}
        ${AI_TURN_QUOTING_XML}
        ${USER_TURN_PLAIN}
        ${AI_TURN_NO_THINKING}
      </div>
    </div>
  </div>
</div>`;

/** Multiple containers — only the second has function results */
const NOTION_MULTI_CONTAINER = `
<div class="notion-selectable-container">
  <div>
    <div>Header content</div>
  </div>
</div>
<div class="notion-selectable-container">
  <div>
    ${USER_TURN_WITH_RESULTS}
    ${AI_TURN_QUOTING_XML}
  </div>
</div>`;

/** No containers at all */
const EMPTY_DOM = `<div>Nothing here</div>`;

// ============================================================
// isNotionHost
// ============================================================
describe('isNotionHost', () => {
  test('matches notion.so', () => {
    assert.ok(isNotionHost('notion.so'));
  });

  test('matches subdomain www.notion.so', () => {
    assert.ok(isNotionHost('www.notion.so'));
  });

  test('matches subdomain ai.notion.so', () => {
    assert.ok(isNotionHost('ai.notion.so'));
  });

  test('rejects evil-notion.so.example.com', () => {
    assert.ok(!isNotionHost('evil-notion.so.example.com'));
  });

  test('rejects my-notion.so.fake', () => {
    assert.ok(!isNotionHost('my-notion.so.fake'));
  });

  test('rejects chatgpt.com', () => {
    assert.ok(!isNotionHost('chatgpt.com'));
  });

  test('rejects empty string', () => {
    assert.ok(!isNotionHost(''));
  });
});

// ============================================================
// containsFunctionResultLikeText
// ============================================================
describe('containsFunctionResultLikeText', () => {
  test('detects canonical <function_results>', () => {
    assert.ok(containsFunctionResultLikeText('<function_results>'));
  });

  test('detects legacy <function_result call_id=...>', () => {
    assert.ok(containsFunctionResultLikeText('<function_result call_id="x">'));
  });

  test('rejects plain text mentioning function results conceptually', () => {
    assert.ok(!containsFunctionResultLikeText('The function result was successful'));
  });

  test('rejects empty string', () => {
    assert.ok(!containsFunctionResultLikeText(''));
  });
});

// ============================================================
// findPossibleTurnLanes
// ============================================================
describe('findPossibleTurnLanes', () => {
  test('finds turn lane with function_results child', () => {
    const { root } = createTestDOM(NOTION_CHAT_DOM);
    const container = root.querySelector('.notion-selectable-container') as HTMLElement;
    const lanes = findPossibleTurnLanes(container);
    assert.ok(lanes.length >= 1, `Expected at least 1 lane, got ${lanes.length}`);
  });

  test('finds lane even with extra wrapper layers', () => {
    const { root } = createTestDOM(NOTION_CHAT_DOM_EXTRA_WRAPPER);
    const container = root.querySelector('.notion-selectable-container') as HTMLElement;
    const lanes = findPossibleTurnLanes(container);
    assert.ok(lanes.length >= 1, `Expected at least 1 lane, got ${lanes.length}`);
  });

  test('returns empty for container with no function_results children', () => {
    const { root } = createTestDOM(`
      <div class="test-container">
        <div>Hello</div>
        <div>World</div>
      </div>
    `);
    const container = root.querySelector('.test-container') as HTMLElement;
    const lanes = findPossibleTurnLanes(container);
    assert.equal(lanes.length, 0);
  });

  test('returns empty for container with single child', () => {
    const { root } = createTestDOM(`
      <div class="test-container">
        <div>${FUNCTION_RESULTS_ESCAPED}</div>
      </div>
    `);
    const container = root.querySelector('.test-container') as HTMLElement;
    const lanes = findPossibleTurnLanes(container);
    // Single child — not a turn lane (need >= 2 turns)
    assert.equal(lanes.length, 0);
  });
});

// ============================================================
// getNotionFunctionResultCandidates — core contract tests
// ============================================================
describe('getNotionFunctionResultCandidates', () => {
  test('selects user turn containing <function_results>', () => {
    const { root } = createTestDOM(NOTION_CHAT_DOM);
    const candidates = getNotionFunctionResultCandidates(root);
    assert.ok(candidates.length >= 1, `Expected >= 1 candidate, got ${candidates.length}`);
    // Verify the selected element contains the XML
    assert.ok(candidates[0].textContent?.includes('<function_results'));
  });

  test('excludes AI turn that quotes XML inside [data-content-editable-root]', () => {
    const { root } = createTestDOM(NOTION_CHAT_DOM);
    const candidates = getNotionFunctionResultCandidates(root);
    // None of the candidates should contain data-content-editable-root
    for (const candidate of candidates) {
      assert.ok(
        !candidate.querySelector('[data-content-editable-root]'),
        'Candidate should not contain AI content root',
      );
    }
  });

  test('excludes AI turn without thinking block but with content root', () => {
    // This tests that we don't depend on childCount to distinguish user/AI
    const { root } = createTestDOM(`
      <div class="notion-selectable-container">
        <div>
          ${USER_TURN_WITH_RESULTS}
          ${AI_TURN_NO_THINKING}
        </div>
      </div>
    `);
    const candidates = getNotionFunctionResultCandidates(root);
    assert.equal(candidates.length, 1, 'Should only select user turn, not AI turn');
    assert.ok(candidates[0].textContent?.includes('<function_results'));
    assert.ok(!candidates[0].querySelector('[data-content-editable-root]'));
  });

  test('excludes AI turn with raw function_results in content root', () => {
    const { root } = createTestDOM(`
      <div class="notion-selectable-container">
        <div>
          ${USER_TURN_WITH_RESULTS}
          ${AI_TURN_RAW_XML_IN_CONTENT}
        </div>
      </div>
    `);
    const candidates = getNotionFunctionResultCandidates(root);
    assert.equal(candidates.length, 1, 'Should exclude AI turn even with raw XML');
  });

  test('supports extra wrapper between container and turn lane', () => {
    const { root } = createTestDOM(NOTION_CHAT_DOM_EXTRA_WRAPPER);
    const candidates = getNotionFunctionResultCandidates(root);
    assert.ok(candidates.length >= 1, 'Should find candidates despite extra wrappers');
  });

  test('scans multiple containers and finds the right one', () => {
    const { root } = createTestDOM(NOTION_MULTI_CONTAINER);
    const candidates = getNotionFunctionResultCandidates(root);
    assert.ok(candidates.length >= 1, 'Should find candidate in second container');
    assert.ok(candidates[0].textContent?.includes('<function_results'));
  });

  test('returns empty when no containers exist', () => {
    const { root } = createTestDOM(EMPTY_DOM);
    const candidates = getNotionFunctionResultCandidates(root);
    assert.equal(candidates.length, 0);
  });

  test('returns empty when containers have no function results', () => {
    const { root } = createTestDOM(`
      <div class="notion-selectable-container">
        <div>
          <div>Hello</div>
          <div>World</div>
        </div>
      </div>
    `);
    const candidates = getNotionFunctionResultCandidates(root);
    assert.equal(candidates.length, 0);
  });

  test('does not return duplicates', () => {
    const { root } = createTestDOM(NOTION_CHAT_DOM);
    const candidates = getNotionFunctionResultCandidates(root);
    const unique = new Set(candidates);
    assert.equal(candidates.length, unique.size, 'Should not contain duplicates');
  });
});
