import WebSocket from 'ws';
import fs from 'fs';

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9222;

async function main() {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`);
  const targets = await res.json();
  const notionTarget = targets.find(t =>
    t.type === 'page' &&
    (t.url.includes('notion.so/chat') || t.url.includes('notion.so/ai') || t.url.includes('/ai'))
  );
  if (!notionTarget) {
    console.log('No Notion tab found');
    return;
  }
  
  const ws = new WebSocket(notionTarget.webSocketDebuggerUrl);
  await new Promise(r => ws.once('open', r));
  
  const cdpCommand = (method, params = {}) => {
    const id = Math.floor(Math.random() * 1000000);
    return new Promise((resolve, reject) => {
      const handler = data => {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          ws.off('message', handler);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  await cdpCommand('Page.enable');
  const screenshot = await cdpCommand('Page.captureScreenshot', { format: 'png' });
  const buffer = Buffer.from(screenshot.data, 'base64');
  
  const outputPath = '/Users/hehouwen/.gemini/antigravity/brain/e057a8be-d793-46c7-abe2-4bc487a3567b/notion_screenshot.png';
  fs.writeFileSync(outputPath, buffer);
  console.log(`Screenshot saved successfully to ${outputPath}`);
  ws.close();
}

main().catch(console.error);
