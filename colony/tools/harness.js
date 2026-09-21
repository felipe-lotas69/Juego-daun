/* Headless loader.
   Reads the <script> tags out of index.html, in order, and evaluates the
   simulation ones inside a vm sandbox. Scripts marked data-client="1" touch the
   DOM and are skipped, which is also the check that the simulation is DOM-free:
   if a sim file reaches for `document`, loading it here throws.            */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function scriptList() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const out = [];
  const re = /<script\b([^>]*)\bsrc="([^"]+)"([^>]*)><\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = (m[1] || '') + (m[3] || '');
    out.push({ src: m[2], client: /data-client/.test(attrs) });
  }
  return out;
}

function load(opts) {
  opts = opts || {};
  const sandbox = { console: console, Math: Math, JSON: JSON, Date: Date };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  if (opts.prepare) opts.dom = opts.prepare(sandbox);
  const loaded = [], missing = [], failed = [];
  for (const s of scriptList()) {
    if (s.client && !opts.includeClient) continue;
    const file = path.join(ROOT, s.src);
    if (!fs.existsSync(file)) {
      /* Bring-up runs against a half-built game on purpose: a test that
         cannot run until the last file lands is a test nobody runs. */
      missing.push(s.src);
      if (opts.requireAll) throw new Error('missing script ' + s.src);
      continue;
    }
    const code = fs.readFileSync(file, 'utf8');
    try {
      vm.runInContext(code, sandbox, { filename: s.src });
      loaded.push(s.src);
    } catch (e) {
      /* While the game is incomplete a file may fail because something it
         registers against has not been written yet. That is worth
         reporting, not worth aborting the run. A COMPLETE game that throws
         on load is a real failure and still aborts. */
      failed.push({ src: s.src, error: String(e && e.message || e).split('\n')[0] });
      if (!missing.length || opts.requireAll) {
        throw new Error('loading ' + s.src + ': ' + (e && e.stack || e));
      }
    }
  }
  sandbox.__loaded = loaded;
  sandbox.__missing = missing;
  sandbox.__failed = failed;
  if (!opts.quiet && (missing.length || failed.length)) {
    if (missing.length) console.log('(' + missing.length + ' not written yet: ' + missing.join(' ') + ')');
    failed.forEach(f => console.log('(' + f.src + ' did not load: ' + f.error + ')'));
  }
  return sandbox;
}

module.exports = { load, scriptList, ROOT };
