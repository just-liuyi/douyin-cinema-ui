#!/usr/bin/env node
/**
 * Cheap guard against "called but never defined" mistakes in the extension
 * scripts (the kind that blanked the whole content script once when a factory
 * was deleted by an over-wide edit).
 *
 * Strips comments and string literals, collects declared names (const/let/var,
 * functions, destructuring, parameters) and reports every `name(` call whose
 * name is neither declared nor a known browser global.
 *
 *   node tools/check-undefined.js ext/content/content.js ext/content/page-hook.js
 */
const fs = require('fs')

const GLOBALS = new Set([
  'document', 'window', 'location', 'console', 'fetch', 'URL', 'URLSearchParams', 'JSON', 'Math',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet',
  'Date', 'Error', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'Image', 'AbortController',
  'performance', 'requestAnimationFrame', 'requestIdleCallback', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'localStorage', 'sessionStorage', 'chrome', 'decodeURIComponent',
  'encodeURIComponent', 'parseInt', 'parseFloat', 'isNaN', 'RegExp', 'atob', 'btoa', 'getComputedStyle',
  'CustomEvent', 'Event', 'PointerEvent', 'KeyboardEvent', 'MouseEvent', 'structuredClone',
  'queueMicrotask', 'globalThis', 'Reflect', 'XMLHttpRequest', 'Response', 'Blob', 'importScripts',
])
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'await', 'async',
  'try', 'throw', 'else', 'do', 'case', 'of', 'in', 'void', 'delete', 'yield', 'super', 'this',
])

const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\w'"`])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    // regex literals after an operator or opening bracket, e.g. .match(/x_(\d+)/)
    .replace(/([(,=:!&|?{;]\s*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\n])*\]|[^/\n])+\/[a-z]*/g, '$1/re/')

let failed = false
for (const file of process.argv.slice(2)) {
  const src = strip(fs.readFileSync(file, 'utf8'))
  const defined = new Set()
  for (const m of src.matchAll(/(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1])
  for (const m of src.matchAll(/(?:const|let|var)\s*[{[]([^}\]]+)[}\]]\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].replace('...', '').trim()
      if (name) defined.add(name)
    }
  }
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.replace(/[{}[\]]/g, '').split('=')[0].replace('...', '').trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name)
    }
  }
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) defined.add(m[1])

  const missing = new Map()
  for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1]
    if (KEYWORDS.has(name) || defined.has(name) || GLOBALS.has(name)) continue
    missing.set(name, (missing.get(name) || 0) + 1)
  }
  if (missing.size) {
    failed = true
    for (const [name, n] of missing) console.log(`${file}: ${name}() called ${n}x but never defined`)
  } else {
    console.log(`${file}: ok`)
  }
}
process.exit(failed ? 1 : 0)
