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
  const loaded = [];
  for (const s of scriptList()) {
    if (s.client && !opts.includeClient) continue;
    const file = path.join(ROOT, s.src);
    const code = fs.readFileSync(file, 'utf8');
    try {
      vm.runInContext(code, sandbox, { filename: s.src });
    } catch (e) {
      throw new Error('loading ' + s.src + ': ' + (e && e.stack || e));
    }
    loaded.push(s.src);
  }
  sandbox.__loaded = loaded;
  return sandbox;
}

module.exports = { load, scriptList, ROOT };
