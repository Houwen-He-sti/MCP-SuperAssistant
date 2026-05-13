/**
 * DOM 观察脚本：发现 Notion 侧边栏中工作空间名称的 DOM 结构
 * 
 * 目标：找到包含 "sjzj030的工作空间" 的 DOM 元素及其选择器
 * 
 * Usage: node observe-workspace-dom.cjs
 */

const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = process.env.CDP_PORT || 9222;

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json`, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function evaluateExpression(ws, expression) {
    const id = Math.floor(Math.random() * 1000000);

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            resolve({ error: 'Timeout after 5 seconds' });
        }, 5000);

        const handler = (msg) => {
            const o = JSON.parse(msg);
            if (o.id === id) {
                clearTimeout(timeout);
                ws.removeListener('message', handler);
                resolve(o);
            }
        };

        ws.on('message', handler);
        ws.send(JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true }
        }));
    });
}

async function main() {
    console.log('🔍 Finding Notion tab...');
    const targets = await getTargets();
    const notionTab = targets.find(t => t.type === 'page' && t.url?.includes('notion.so'));

    if (!notionTab) {
        console.error('❌ No Notion tab found');
        process.exit(1);
    }

    console.log(`✅ Found Notion tab: ${notionTab.title}`);
    console.log(`   URL: ${notionTab.url}`);

    const ws = new WebSocket(notionTab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    console.log('✅ WebSocket connected');

    // 策略 1: 搜索包含工作空间名称的文本节点
    console.log('\n--- Strategy 1: Find text containing workspace name ---');
    const expr1 = `
        (function() {
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT,
                null,
                false
            );
            
            const results = [];
            let node;
            while (node = walker.nextNode()) {
                const text = node.textContent.trim();
                if (text.includes('sjzj030的工作空间') || text.includes('的工作空间')) {
                    const parent = node.parentElement;
                    results.push({
                        text: text,
                        tagName: parent?.tagName,
                        className: parent?.className?.substring(0, 100),
                        id: parent?.id,
                        selector: parent?.tagName + 
                            (parent?.id ? '#' + parent.id : '') +
                            (parent?.className ? '.' + parent.className.split(' ').filter(c => c).slice(0, 2).join('.') : '')
                    });
                }
            }
            return JSON.stringify(results, null, 2);
        })()
    `;

    const result1 = await evaluateExpression(ws, expr1);
    if (result1.result?.result?.value) {
        console.log('Found text nodes:');
        console.log(result1.result.result.value);
    } else {
        console.log('No text nodes found with workspace name');
    }

    // 策略 2: 查找侧边栏容器
    console.log('\n--- Strategy 2: Find sidebar containers ---');
    const expr2 = `
        (function() {
            // Notion 常见侧边栏选择器
            const selectors = [
                '[role="navigation"]',
                '[data-testid="sidebar"]',
                '.notion-sidebar',
                '.notion-overlay-container',
                '[class*="sidebar"]',
                '[class*="Sidebar"]',
                '[class*="workspace"]',
                '[class*="Workspace"]'
            ];
            
            const results = [];
            for (const sel of selectors) {
                const elements = document.querySelectorAll(sel);
                if (elements.length > 0) {
                    results.push({
                        selector: sel,
                        count: elements.length,
                        sample: elements[0].textContent?.substring(0, 100),
                        html: elements[0].outerHTML?.substring(0, 200)
                    });
                }
            }
            return JSON.stringify(results, null, 2);
        })()
    `;

    const result2 = await evaluateExpression(ws, expr2);
    if (result2.result?.result?.value) {
        console.log('Sidebar containers:');
        console.log(result2.result.result.value);
    } else {
        console.log('No sidebar containers found');
    }

    // 策略 3: 查找带有 white-space: nowrap 样式的 div
    console.log('\n--- Strategy 3: Find divs with white-space:nowrap ---');
    const expr3 = `
        (function() {
            const divs = document.querySelectorAll('div');
            const results = [];
            
            for (const div of divs) {
                const style = window.getComputedStyle(div);
                if (style.whiteSpace === 'nowrap' || style.whiteSpace === 'nowrap') {
                    const text = div.textContent?.trim();
                    if (text && text.length > 0 && text.length < 100) {
                        results.push({
                            text: text,
                            className: div.className?.substring(0, 100),
                            whiteSpace: style.whiteSpace,
                            outerHTML: div.outerHTML?.substring(0, 200)
                        });
                    }
                }
            }
            
            return JSON.stringify(results.slice(0, 20), null, 2);
        })()
    `;

    const result3 = await evaluateExpression(ws, expr3);
    if (result3.result?.result?.value) {
        console.log('Divs with nowrap:');
        console.log(result3.result.result.value);
    } else {
        console.log('No nowrap divs found');
    }

    // 策略 4: 直接搜索 "sjzj030" 文本
    console.log('\n--- Strategy 4: Find any element with sjzj030 text ---');
    const expr4 = `
        (function() {
            const all = document.querySelectorAll('*');
            const results = [];
            
            for (const el of all) {
                // 只检查直接文本节点
                for (const child of el.childNodes) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        const text = child.textContent?.trim();
                        if (text && text.includes('sjzj030')) {
                            results.push({
                                text: text,
                                tagName: el.tagName,
                                className: el.className?.substring(0, 100),
                                id: el.id,
                                outerHTML: el.outerHTML?.substring(0, 300)
                            });
                        }
                    }
                }
            }
            
            return JSON.stringify(results.slice(0, 10), null, 2);
        })()
    `;

    const result4 = await evaluateExpression(ws, expr4);
    if (result4.result?.result?.value) {
        console.log('Elements with sjzj030:');
        console.log(result4.result.result.value);
    } else {
        console.log('No elements with sjzj030 found');
    }

    ws.close();
    console.log('\n✅ Observation complete');
}

main().catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
});
