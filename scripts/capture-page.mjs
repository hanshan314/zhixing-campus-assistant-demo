import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [url, output, profile, waitArg = '10000', clickXArg, clickYArg, click2XArg, click2YArg, click3XArg, click3YArg] = process.argv.slice(2);
if (!url || !output || !profile) throw new Error('Expected URL, output PNG and isolated profile');
const waitMs = Number(waitArg);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--disable-background-networking',
  '--disable-extensions', '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,800', '--force-device-scale-factor=1',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]);
      if (port > 0) break;
    } catch { /* Chrome is still starting. */ }
    if (chrome.exitCode !== null) throw new Error(`Chrome exited ${chrome.exitCode}`);
    await sleep(100);
  }
  if (!port) throw new Error('Chrome DevTools port unavailable');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(target => target.type === 'page');
  if (!page) throw new Error('No isolated page target');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id;
    pending.set(callId, message => message.error
      ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
    socket.send(JSON.stringify({ id: callId, method, params }));
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Page.navigate', { url });
  await sleep(waitMs);
  const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(output, Buffer.from(result.data, 'base64'));
  let afterClick;
  if (clickXArg !== undefined && clickYArg !== undefined) {
    const x = Number(clickXArg), y = Number(clickYArg);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(3000);
    afterClick = output.replace(/\.png$/i, '-after-click.png');
    const second = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(afterClick, Buffer.from(second.data, 'base64'));
    if (click2XArg !== undefined && click2YArg !== undefined) {
      const x2 = Number(click2XArg), y2 = Number(click2YArg);
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: x2, y: y2, button: 'left', clickCount: 1 });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
      await sleep(3000);
      const afterSecondClick = output.replace(/\.png$/i, '-after-2-clicks.png');
      const third = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(afterSecondClick, Buffer.from(third.data, 'base64'));
      afterClick = [afterClick, afterSecondClick];
      if (click3XArg !== undefined && click3YArg !== undefined) {
        const x3 = Number(click3XArg), y3 = Number(click3YArg);
        await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: x3, y: y3, button: 'left', clickCount: 1 });
        await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x3, y: y3, button: 'left', clickCount: 1 });
        await sleep(3000);
        const afterThirdClick = output.replace(/\.png$/i, '-after-3-clicks.png');
        const fourth = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(afterThirdClick, Buffer.from(fourth.data, 'base64'));
        afterClick.push(afterThirdClick);
      }
    }
  }
  const state = await command('Runtime.evaluate', {
    expression: "({readyState:document.readyState, title:document.title, glassPane:!!document.querySelector('flt-glass-pane'), resources:performance.getEntriesByType('resource').length})",
    returnByValue: true,
  });
  console.log(JSON.stringify({ url, output, afterClick, waitMs, state: state.result.value }));
  await command('Browser.close').catch(() => {});
} finally {
  socket?.close();
  if (chrome.exitCode === null) chrome.kill();
}
