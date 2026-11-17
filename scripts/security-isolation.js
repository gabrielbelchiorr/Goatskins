/* Preload used only by the local security audit. This is an application-level
   guard against accidental provider/production access, not an OS sandbox.
   Children inherit it through NODE_OPTIONS. Tests may replace providers with
   doubles; actual TCP connections and native fetch remain loopback-only. */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { fileURLToPath } = require('node:url');
const loopback = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
function blocked() {
  const error = new Error('Security audit permits only loopback network connections.');
  error.code = 'AUDIT_EGRESS_BLOCKED'; return error;
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const input = Array.isArray(args[0]) ? args[0] : args;
  const options = input[0] && typeof input[0] === 'object' ? input[0] : {
    port: input[0], host: typeof input[1] === 'string' ? input[1] : 'localhost'
  };
  if (options.path || !loopback(options.host || 'localhost')) throw blocked();
  return Reflect.apply(connect, this, args);
};
const nativeFetch = global.fetch;
global.fetch = async function (input, ...args) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!loopback(url.hostname)) throw blocked();
  return nativeFetch(input, ...args);
};
// No UDP tests are required; reject it rather than permit DNS or other egress.
for (const method of ['connect', 'send']) require('node:dgram').Socket.prototype[method] = function () { throw blocked(); };

function runtimeEnv(filename) {
  if (typeof filename === 'number') return false;
  const value = filename instanceof URL ? fileURLToPath(filename) : String(filename);
  const name = path.basename(value);
  return name === '.env' || (name.startsWith('.env.') && name !== '.env.example');
}
function absent() { const error = new Error('Runtime environment files are unavailable during the security audit.'); error.code = 'ENOENT'; return error; }
const readSync = fs.readFileSync, read = fs.readFile, readPromise = fs.promises.readFile;
fs.readFileSync = function (filename, ...args) {
  if (runtimeEnv(filename)) throw absent();
  return Reflect.apply(readSync, this, [filename, ...args]);
};
fs.readFile = function (filename, ...args) {
  if (runtimeEnv(filename)) { process.nextTick(() => args.at(-1)(absent())); return; }
  return Reflect.apply(read, this, [filename, ...args]);
};
fs.promises.readFile = async function (filename, ...args) {
  if (runtimeEnv(filename)) throw absent();
  return Reflect.apply(readPromise, this, [filename, ...args]);
};
