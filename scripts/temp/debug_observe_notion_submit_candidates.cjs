const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { sleep } = require("../lib/cdp-preflight.cjs");

const PROBE_CODE = `
(() => {
  const MAX_TEXT = 120;
  const records = [];
  let seq = 0;

  const now = () => Number(performance.now().toFixed(1));

  function cssPath(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;

    const parts = [];
    let cur = el;

    while (cur && cur.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let part = cur.tagName.toLowerCase();

      const testId = cur.getAttribute('data-testid');
      const role = cur.getAttribute('role');
      const aria = cur.getAttribute('aria-label');
      const id = cur.id;

      if (id) {
        part += '#' + CSS.escape(id);
        parts.unshift(part);
        break;
      }

      if (testId) part += '[data-testid="' + testId + '"]';
      else if (role) part += '[role="' + role + '"]';
      else if (aria) part += '[aria-label="' + aria.slice(0, 40) + '"]';

      const parent = cur.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter(
          (x) => x.tagName === cur.tagName
        );
        if (sameTag.length > 1) {
          part += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')';
        }
      }

      parts.unshift(part);
      cur = cur.parentElement;
    }

    return parts.join(' > ');
  }

  function isVisibleByRect(rect) {
    return rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= window.innerHeight &&
      rect.left <= window.innerWidth;
  }

  function snapshotElement(el, reason = 'snapshot') {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;

    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);

    return {
      reason,
      tag: el.tagName.toLowerCase(),
      path: cssPath(el),
      dataTestId: el.getAttribute('data-testid'),
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      ariaDisabled: el.getAttribute('aria-disabled'),
      disabledAttr: el.hasAttribute('disabled'),
      disabledProp: 'disabled' in el ? el.disabled : undefined,
      tabIndex: el.getAttribute('tabindex'),
      type: el.getAttribute('type'),
      title: el.getAttribute('title'),
      className: String(el.className || '').slice(0, 200),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, MAX_TEXT),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        bottom: Math.round(rect.bottom),
        right: Math.round(rect.right),
      },
      visibleByRect: isVisibleByRect(rect),
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      zIndex: style.zIndex,
      position: style.position,
      cursor: style.cursor,
      isConnected: el.isConnected,
    };
  }

  function candidateSelector() {
    return [
      'button',
      '[role="button"]',
      '[data-testid]',
      '[aria-label]',
      '[contenteditable="true"]',
      'textarea',
      'input',
      'svg',
      '[tabindex]',
    ].join(',');
  }

  function looksSubmitRelated(el) {
    const blob = [
      el.tagName,
      el.getAttribute('data-testid'),
      el.getAttribute('aria-label'),
      el.getAttribute('role'),
      el.getAttribute('title'),
      el.getAttribute('type'),
      el.className,
      el.textContent,
    ]
      .map((x) => String(x || '').toLowerCase())
      .join(' ');

    return (
      blob.includes('send') ||
      blob.includes('submit') ||
      blob.includes('message') ||
      blob.includes('agent') ||
      blob.includes('arrow') ||
      blob.includes('送信') ||
      blob.includes('发送') ||
      blob.includes('送信')
    );
  }

  function collectCandidates(reason = 'collect') {
    const all = [...document.querySelectorAll(candidateSelector())];

    const candidates = all
      .filter((el) => {
        const snap = snapshotElement(el);
        if (!snap) return false;

        return (
          looksSubmitRelated(el) ||
          snap.role === 'button' ||
          snap.tag === 'button' ||
          snap.dataTestId === 'agent-send-message-button'
        );
      })
      .map((el) => snapshotElement(el, reason))
      .filter(Boolean)
      .sort((a, b) => {
        const av = a.visibleByRect ? 1 : 0;
        const bv = b.visibleByRect ? 1 : 0;
        if (av !== bv) return bv - av;
        return (b.rect.bottom - a.rect.bottom) || (b.rect.right - a.rect.right);
      });

    return candidates;
  }

  function activeSnapshot(reason = 'active') {
    const active = document.activeElement;
    const editable = active?.closest?.('[contenteditable="true"], textarea, input');

    let editableText = null;
    if (editable) {
        editableText = String(editable.value ?? editable.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 200);
    }
    
    let selectionInfo = null;
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel) {
        selectionInfo = {
          type: sel.type,
          rangeCount: sel.rangeCount,
          text: String(sel.toString() || '').slice(0, 80),
          anchorNode: sel.anchorNode ? sel.anchorNode.nodeName : null,
          focusNode: sel.focusNode ? sel.focusNode.nodeName : null,
        };
    }

    return {
      reason,
      active: snapshotElement(active, 'activeElement'),
      editable: snapshotElement(editable, 'activeEditable'),
      selection: selectionInfo,
      editableText: editableText,
    };
  }

  function hitTestAroundKnownButton(reason = 'hit-test') {
    const known = document.querySelector('[data-testid="agent-send-message-button"]');
    const rect = known ? known.getBoundingClientRect() : null;

    const points = [];

    if (rect && rect.width && rect.height) {
      points.push({
        name: 'known-center',
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      });
    }

    points.push(
      { name: 'viewport-bottom-right-1', x: window.innerWidth - 48, y: window.innerHeight - 48 },
      { name: 'viewport-bottom-right-2', x: window.innerWidth - 80, y: window.innerHeight - 80 },
      { name: 'viewport-bottom-center', x: Math.round(window.innerWidth / 2), y: window.innerHeight - 60 },
    );

    return points.map((p) => ({
      ...p,
      stack: (document.elementsFromPoint ? document.elementsFromPoint(p.x, p.y) : [])
        .slice(0, 10)
        .map((el) => snapshotElement(el, 'hit:' + p.name)),
    }));
  }

  function record(event, payload = {}) {
    const entry = {
      seq: ++seq,
      ts: now(),
      event,
      url: location.href,
      payload,
    };
    records.push(entry);
    console.log('[notion-submit-probe]', JSON.stringify(entry));
    return entry;
  }

  function fullSnapshot(reason = 'full') {
    return {
      active: activeSnapshot(reason),
      knownButtons: [...document.querySelectorAll('[data-testid="agent-send-message-button"]')]
        .map((el) => snapshotElement(el, reason + ':known')),
      candidates: collectCandidates(reason + ':candidates'),
      hitTests: hitTestAroundKnownButton(reason + ':hit'),
    };
  }

  for (const type of [
    'focusin', 'focusout', 'keydown', 'keyup', 
    'beforeinput', 'input', 'compositionstart', 
    'compositionupdate', 'compositionend', 
    'click', 'pointerdown',
  ]) {
    document.addEventListener(
      type,
      (e) => {
        record('event:' + type, {
          target: snapshotElement(e.target, 'event-target:' + type),
          active: activeSnapshot('event-active:' + type),
          key: e.key,
          code: e.code,
          inputType: e.inputType,
          data: e.data,
          isTrusted: e.isTrusted,
          bubbles: e.bubbles,
          composed: e.composed,
          cancelable: e.cancelable,
        });
      },
      true
    );
  }

  const observer = new MutationObserver((mutations) => {
    const summarized = mutations.slice(0, 20).map((m) => ({
      type: m.type,
      target: snapshotElement(m.target, 'mutation-target:' + m.type),
      attributeName: m.attributeName,
      added: [...(m.addedNodes || [])]
        .filter((n) => n.nodeType === Node.ELEMENT_NODE)
        .slice(0, 5)
        .map((n) => snapshotElement(n, 'mutation-added')),
      removed: [...(m.removedNodes || [])]
        .filter((n) => n.nodeType === Node.ELEMENT_NODE)
        .slice(0, 5)
        .map((n) => snapshotElement(n, 'mutation-removed')),
    }));

    record('mutation', {
      count: mutations.length,
      summarized,
      snapshot: fullSnapshot('after-mutation'),
    });
  });

  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
    attributeFilter: [
      'aria-disabled',
      'disabled',
      'data-testid',
      'role',
      'aria-label',
      'class',
      'style',
      'tabindex',
      'contenteditable',
    ],
  });

  record('probe-installed', fullSnapshot('initial'));

  window.__notionSubmitProbe = {
    records,
    stop() {
      observer.disconnect();
      record('probe-stopped', { total: records.length });
      return records;
    },
    snapshot(reason = 'manual') {
      return record('manual:' + reason, fullSnapshot(reason));
    },
  };

  return { ok: true, message: 'notion submit probe installed' };
})();
`;

async function run() {
    console.log('🔍 Preflighting Notion agent page...');
    const targets = await require("../lib/cdp-preflight.cjs").getTargets(); const notionTab = targets.find(t => t.type === "page" && t.url.includes("notion.so")); if (!notionTab) throw new Error("No Notion found"); const pageInfo = { tab: notionTab };
    const wsUrl = pageInfo.tab.webSocketDebuggerUrl;

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    let msgId = 1;
    const sendCommand = (method, params) => new Promise((resolve, reject) => {
        const id = msgId++;
        const listener = (data) => {
            const res = JSON.parse(data);
            if (res.id === id) {
                ws.removeListener('message', listener);
                if (res.error) reject(new Error(JSON.stringify(res.error)));
                else resolve(res.result);
            }
        };
        ws.on('message', listener);
        ws.send(JSON.stringify({ id, method, params }));
    });

    console.log('🔄 Injecting probe code...');
    const injectRes = await sendCommand('Runtime.evaluate', {
        expression: PROBE_CODE,
        returnByValue: true
    });

    if (injectRes.result && injectRes.result.value) {
        console.log('✅ Probe injected:', injectRes.result.value);
    } else {
        console.log('✅ Probe injected but no value returned', injectRes);
    }

    console.log('\n👉 WAITING FOR HUMAN INPUT 👈');
    console.log('Please click into the Notion AI input area and type something.');
    console.log('Recording events for 15 seconds...');

    await sleep(15000);

    console.log('\n📸 Taking final snapshot...');
    await sendCommand('Runtime.evaluate', {
        expression: 'window.__notionSubmitProbe.snapshot("after-human-typing")',
        returnByValue: true
    });

    console.log('📥 Retrieving records...');
    const recordsRes = await sendCommand('Runtime.evaluate', {
        expression: 'window.__notionSubmitProbe.records',
        returnByValue: true
    });

    const records = recordsRes.result.value || [];
    const outFile = path.join(__dirname, 'notion_submit_probe_records.json');
    fs.writeFileSync(outFile, JSON.stringify(records, null, 2));

    console.log(`✅ Saved ${records.length} records to ${outFile}`);
    ws.close();
}

run().catch(err => { console.error('FATAL', err); process.exit(1); });

