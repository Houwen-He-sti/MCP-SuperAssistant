// notion-check-result.cjs — Check the MCP tool call result content
const WebSocket = require('ws');
const http = require('http');

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json', res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

(async () => {
    const targets = await getTargets();
    const notionTab = targets.find(t => t.url.includes('notion.so'));
    if (!notionTab) { console.log('ERROR: No Notion tab'); process.exit(1); }

    const ws = new WebSocket(notionTab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 0;
    function send(method, params) {
        return new Promise(resolve => {
            const id = ++msgId;
            const handler = msg => {
                const obj = JSON.parse(msg);
                if (obj.id === id) { ws.off('message', handler); resolve(obj); }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }
    function val(r) { return r.result?.result?.value; }

    // Check the function-block details
    const blockDetails = await send('Runtime.evaluate', {
        expression: `(function() {
            const block = document.querySelector('.function-block[data-function-name="echo"]');
            if (!block) return 'No function block found';
            
            // Get full HTML
            const html = block.innerHTML.substring(0, 3000);
            
            // Check result panel
            const resultPanel = block.querySelector('.function-results-panel');
            const resultContent = resultPanel ? resultPanel.textContent.substring(0, 1000) : 'No result panel';
            
            // Check status indicators
            const statusEl = block.querySelector('.execution-status, [class*="status"]');
            const status = statusEl ? statusEl.textContent : 'No status element';
            
            // Check result text/content
            const resultText = block.querySelector('.result-text, .result-content, [class*="result"]');
            const result = resultText ? resultText.textContent.substring(0, 500) : 'No result text';
            
            // Check if there's an error
            const errorEl = block.querySelector('.error, [class*="error"]');
            const error = errorEl ? errorEl.textContent : 'No error';
            
            // Check insert button state
            const insertBtn = block.querySelector('.insert-result-button');
            const insertBtnText = insertBtn ? insertBtn.textContent : 'No insert button';
            const insertBtnDisabled = insertBtn ? insertBtn.disabled : null;
            
            return JSON.stringify({
                resultContent,
                status,
                result,
                error,
                insertBtnText,
                insertBtnDisabled
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Block details:', val(blockDetails));

    // Check more details - get all text content from the results panel
    const resultDetails = await send('Runtime.evaluate', {
        expression: `(function() {
            const resultPanel = document.querySelector('.function-results-panel[data-call-id="c1-hello"]');
            if (!resultPanel) return 'No result panel found';
            
            // Get all child elements and their content
            const children = [];
            resultPanel.querySelectorAll('*').forEach(el => {
                if (el.textContent.trim() && el.children.length === 0) {
                    children.push({
                        tag: el.tagName,
                        class: el.className.substring(0, 40),
                        text: el.textContent.substring(0, 200)
                    });
                }
            });
            
            return JSON.stringify({
                outerHTML: resultPanel.outerHTML.substring(0, 2000),
                children: children.slice(0, 20)
            }, null, 2);
        })()`,
        returnByValue: true,
    });
    console.log('Result panel:', val(resultDetails));

    ws.close();
    process.exit(0);
})();
