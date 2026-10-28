/* Limited secret heuristics, not SAST or proof that a repository is secret-free.
   Examines the current content of Git-tracked files, including tests/examples.
   Untracked files, Git history, binary/UTF-16 content and files > 2 MiB are not
   scanned. Runtime .env files are never opened: tracking one is itself an error.
   Reports only path, line and rule; never prints matching source or values. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const MAX_BYTES = 2 * 1024 * 1024;
const rules = [
  ['private-key', /-{5}BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-{5}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,})\b/g],
  ['resend-token', /\bre_[A-Za-z0-9_]{24,}\b/g],
  ['mercadopago-token', /\bAPP_USR-[A-Za-z0-9-]{60,}\b/g],
  ['assigned-hex-secret', /\b(?:MP_WEBHOOK_SECRET|EMAIL_CODE_SECRET|TURNSTILE_SECRET_KEY|TWILIO_AUTH_TOKEN)["']?\s*[:=]\s*["']?[a-f0-9]{32,}["']?(?=\s|[,;}]|$)/gi]
];

function scanText(source) {
  const findings = [];
  for (const [rule, expression] of rules) {
    // A new expression avoids sharing lastIndex between files and callers.
    for (const match of source.matchAll(new RegExp(expression.source, expression.flags))) {
      findings.push({ rule, line: source.slice(0, match.index).split('\n').length });
    }
  }
  return findings;
}

function runtimeEnv(filename) {
  return filename.replace(/\\/g, '/').split('/').some(part => part === '.env' || (part.startsWith('.env.') && part !== '.env.example'));
}

function scanTracked(root, trackedFiles) {
  const files = trackedFiles || execFileSync('git', ['ls-files', '--cached', '-z'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024
  }).toString('utf8').split('\0').filter(Boolean);
  const result = { scanned: 0, binary: 0, oversized: 0, deleted: 0, findings: [] };
  for (const filename of new Set(files)) {
    if (runtimeEnv(filename)) {
      result.findings.push({ path: filename, rule: 'tracked-runtime-env' });
      continue;
    }
    const absolute = path.resolve(root, filename), relative = path.relative(root, absolute);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      result.findings.push({ path: filename, rule: 'outside-repository' }); continue;
    }
    let stat;
    try { stat = fs.lstatSync(absolute); }
    catch (error) {
      if (error.code === 'ENOENT') { result.deleted++; continue; }
      result.findings.push({ path: filename, rule: 'unreadable-file' }); continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      result.findings.push({ path: filename, rule: 'unsupported-file-type' }); continue;
    }
    if (stat.size > MAX_BYTES) { result.oversized++; continue; }
    let bytes;
    try { bytes = fs.readFileSync(absolute); }
    catch (_) { result.findings.push({ path: filename, rule: 'unreadable-file' }); continue; }
    if (bytes.includes(0)) { result.binary++; continue; }
    result.scanned++;
    for (const finding of scanText(bytes.toString('utf8'))) result.findings.push({ path: filename, ...finding });
  }
  return result;
}

if (require.main === module) {
  try {
    const result = scanTracked(path.join(__dirname, '..'));
    for (const finding of result.findings) console.error(JSON.stringify(finding));
    console.log(JSON.stringify({
      check: 'limited-tracked-secret-heuristics', scanned: result.scanned,
      skippedBinary: result.binary, skippedOversized: result.oversized, missingWorkingFiles: result.deleted,
      findings: result.findings.length,
      limitations: 'No history, untracked files, binary, UTF-16 or files over 2 MiB; runtime .env is not read. No finding does not prove absence of secrets.'
    }));
    process.exitCode = result.findings.length ? 1 : 0;
  } catch (_) {
    console.error('Secret check could not inspect the tracked working tree. No source or error details printed.');
    process.exitCode = 2;
  }
}
module.exports = { scanText, scanTracked, runtimeEnv };
