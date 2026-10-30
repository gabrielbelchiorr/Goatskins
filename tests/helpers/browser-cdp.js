/* Local browser harness. Native CDP keeps frontend checks independent of npm browser packages. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), {spawn} = require('node:child_process');
const executable = [process.env.SECURITY_AUDIT_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'Browser condition timed out') {
  for (let i = 0; i < 180; i++) { if (await check()) return; await delay(50); }
  throw new Error(message);
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.sequence = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timeout); this.pending.delete(message.id);
        message.error ? pending.reject(Error(message.error.message)) : pending.resolve(message.result);
      } else for (const listener of this.listeners.get(message.method) || []) {
        Promise.resolve(listener(message.params)).catch(error => { this.error = error; });
      }
    });
    ws.addEventListener('close', () => this.rejectPending());
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, {once:true}); ws.addEventListener('error', reject, {once:true}); });
    return new CDP(ws);
  }
  on(method, listener) { this.listeners.set(method, [...this.listeners.get(method) || [], listener]); }
  send(method, params = {}) {
    if (this.error) return Promise.reject(this.error);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(Error('CDP command timed out: ' + method)); }, 15000);
      this.pending.set(id, {resolve, reject, timeout}); this.ws.send(JSON.stringify({id, method, params}));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  rejectPending() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(Error('CDP closed')); }
    this.pending.clear();
  }
  close() { this.ws.close(); this.rejectPending(); }
}
async function startBrowser({directory, api, initialize = '', width = 1440, height = 900}) {
  if (!executable) throw new Error('A local Chromium browser is required (SECURITY_AUDIT_BROWSER).');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'goatskins-browser-check-'));
  const pageErrors = [], externalRequests = [], requests = [];
  let child, cdp;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        requests.push({method:req.method, pathname:url.pathname, body});
        const result = await api(req.method, url.pathname, body);
        res.writeHead(result.status || 200, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
        return res.end(JSON.stringify(result.data));
      }
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
      const filename = path.resolve(directory, relative);
      if (!filename.startsWith(path.resolve(directory) + path.sep)) { res.writeHead(403); return res.end(); }
      const content = await fs.promises.readFile(filename);
      const types = {'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.webp':'image/webp','.jpg':'image/jpeg'};
      res.writeHead(200, {'Content-Type':types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control':'no-store'}); res.end(content);
    } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const close = async () => {
    if (cdp) cdp.close();
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (path.dirname(path.resolve(profile)) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('goatskins-browser-check-')) throw Error('Unexpected browser profile path');
    fs.rmSync(profile, {recursive:true, force:true});
  };
  try {
    const port = await freePort();
    child = spawn(executable, ['--headless=new','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,
      '--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update',
      '--disable-sync','--disable-default-apps','--disable-extensions','--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','about:blank'], {stdio:'ignore', windowsHide:true});
    let target;
    await until(async () => {
      if (child.exitCode !== null) throw Error('Local Chromium exited');
      try { target = (await (await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(page => page.type === 'page'); return !!target; } catch (_) { return false; }
    }, 'Chromium debugging endpoint unavailable');
    cdp = await CDP.connect(target.webSocketDebuggerUrl);
    cdp.on('Runtime.exceptionThrown', event => pageErrors.push(event.exceptionDetails));
    cdp.on('Fetch.requestPaused', event => {
      if (new URL(event.request.url).origin !== base) {
        externalRequests.push(event.request.url); return cdp.send('Fetch.failRequest', {requestId:event.requestId, errorReason:'BlockedByClient'});
      }
      return cdp.send('Fetch.continueRequest', {requestId:event.requestId});
    });
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Fetch.enable', {patterns:[{urlPattern:'*', requestStage:'Request'}]});
    await cdp.send('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
    await cdp.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    if (initialize) await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source:initialize});
    const navigate = async (pathname = '/') => {
      await cdp.send('Page.navigate', {url:base+pathname});
      await until(() => cdp.evaluate('document.readyState === "complete" && !document.documentElement.classList.contains("page-loading")'));
    };
    return {cdp,base,close,navigate,pageErrors,externalRequests,requests};
  } catch (error) { await close(); throw error; }
}
module.exports = {startBrowser, executable, until, delay};
