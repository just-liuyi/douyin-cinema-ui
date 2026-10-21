/**
 * Douyin Cinema UI — service worker.
 *
 * Download strategy (browser-native, no fetch → no CORS, no memory spike):
 *
 * 1. Preferred: `chrome.downloads.download(...)`. It creates a first-class browser
 *    download — visible in Chrome's download bubble, resumable, streamed to disk —
 *    and it carries our filename. The CDN wants a Referer, which the static
 *    ruleset `download` injects for these requests while a download is in flight.
 * 2. Fallback: when the CDN still refuses, a hidden 1×1 iframe navigates to the
 *    URL and the same ruleset rewrites the response to `content-disposition:
 *    attachment`. Slower to name (Chrome has no filename at that point) but it
 *    survives hosts that only allow navigational requests.
 *
 * Every tracked download reports back to the tab that started it, so the page can
 * show "已完成 / 失败" instead of only "已开始".
 */

const RULESET_ID = 'download'
const NAME_TTL_MS = 60_000
const TRACK_TTL_MS = 30 * 60_000

/** url → { fullFilename, tabId, at } staged before the request goes out. */
const pendingNames = new Map()
/** downloadId → { filename, tabId, at } for in-flight downloads. */
const tracked = new Map()

let ruleRefs = 0
let releaseTimer = null

const hasRulesets = () => Boolean(chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateEnabledRulesets)

async function acquireRules() {
  ruleRefs += 1
  if (releaseTimer) {
    clearTimeout(releaseTimer)
    releaseTimer = null
  }
  if (!hasRulesets()) return false
  try {
    const enabled = await chrome.declarativeNetRequest.getEnabledRulesets()
    if (!enabled.includes(RULESET_ID)) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [RULESET_ID] })
    }
    return true
  } catch {
    return false
  }
}

function scheduleRelease(delayMs = 20_000) {
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = setTimeout(async () => {
    releaseTimer = null
    ruleRefs = Math.max(0, ruleRefs - 1)
    if (ruleRefs > 0) return
    if (!hasRulesets()) return
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [RULESET_ID] })
    } catch {
      /* retried on the next download */
    }
  }, delayMs)
}

/** Turn an arbitrary title into a safe, readable file name. */
function fileNameOf(raw, index, ext = 'mp4') {
  const base = String(raw || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90)
  const stem = base || `douyin-${Date.now()}`
  const suffix = Number.isInteger(index) && index > 0 ? `-${index}` : ''
  const extension = typeof ext === 'string' && /^[a-z0-9]{2,5}$/i.test(ext) ? ext : 'mp4'
  return `douyin/${stem}${suffix}.${extension}`
}

const isCdn = (url) =>
  typeof url === 'string' && /douyinvod\.com|bytecdn\.cn|ibytedtos\.com|douyincdn\.com|douyinpic\.com|byteimg\.com/.test(url)

function prune() {
  const now = Date.now()
  for (const [url, entry] of pendingNames) if (now - entry.at > NAME_TTL_MS) pendingNames.delete(url)
  for (const [id, entry] of tracked) if (now - entry.at > TRACK_TTL_MS) tracked.delete(id)
}

function notify(tabId, payload) {
  if (!Number.isInteger(tabId)) return
  try {
    chrome.tabs.sendMessage(tabId, payload).catch(() => {})
  } catch {
    /* the tab may be gone */
  }
}

function track(id, filename, tabId, quiet = false) {
  if (!Number.isInteger(id)) return
  tracked.set(id, { filename, tabId, quiet, at: Date.now() })
}

/** Progress / completion / failure for every download we started. */
chrome.downloads.onChanged.addListener((delta) => {
  const entry = tracked.get(delta.id)
  if (!entry) return
  const state = delta.state && delta.state.current
  if (!state) return
  if (state === 'in_progress' && delta.bytesReceived) {
    // Not surfaced in the UI (too chatty), but keeps the entry fresh.
    entry.at = Date.now()
    return
  }
  if (state === 'complete') {
    tracked.delete(delta.id)
    if (entry.quiet) return
    chrome.downloads
      .search({ id: delta.id })
      .then((items) => {
        const size = (items && items[0] && (items[0].fileSize || items[0].bytesReceived)) || 0
        notify(entry.tabId, {
          type: 'download-state',
          state: 'complete',
          filename: entry.filename,
          bytes: size,
        })
      })
      .catch(() => {
        notify(entry.tabId, { type: 'download-state', state: 'complete', filename: entry.filename, bytes: 0 })
      })
    scheduleRelease(10_000)
    return
  }
  if (state === 'interrupted') {
    tracked.delete(delta.id)
    if (entry.quiet) return
    notify(entry.tabId, {
      type: 'download-state',
      state: 'interrupted',
      filename: entry.filename,
      error: (delta.error && delta.error.current) || 'interrupted',
    })
    scheduleRelease(10_000)
  }
})

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  prune()
  const staged = pendingNames.get(item.url) || pendingNames.get(item.finalUrl)
  if (staged) {
    pendingNames.delete(item.url)
    pendingNames.delete(item.finalUrl)
    suggest({ filename: staged.fullFilename, conflictAction: 'uniquify' })
    return
  }
  if (isCdn(item.url)) suggest({ filename: fileNameOf('', 0), conflictAction: 'uniquify' })
})

chrome.downloads.onCreated.addListener((item) => {
  if (!isCdn(item.url)) return
  // Staged downloads (iframe path) still need a tab to report back to.
  const staged = pendingNames.get(item.url) || pendingNames.get(item.finalUrl)
  if (staged && !tracked.has(item.id)) track(item.id, staged.fullFilename, staged.tabId)
  scheduleRelease(15_000)
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined
  const tabId = sender && sender.tab && sender.tab.id

  if (message.type === 'prepare-download') {
    ;(async () => {
      prune()
      const filename = fileNameOf(message.title, message.index, message.ext)
      if (typeof message.url === 'string') {
        pendingNames.set(message.url, { fullFilename: filename, tabId, at: Date.now() })
      }
      const rulesReady = await acquireRules()
      scheduleRelease()
      sendResponse({ ok: true, filename, rulesReady })
    })()
    return true
  }

  if (message.type === 'download') {
    // Preferred path: a real browser download with our filename.
    ;(async () => {
      prune()
      const filename = fileNameOf(message.title, message.index, message.ext)
      const rulesReady = await acquireRules()
      try {
        const id = await chrome.downloads.download({
          url: message.url,
          filename,
          conflictAction: 'uniquify',
          saveAs: false,
        })
        track(id, filename, tabId, message.quiet === true)
        sendResponse({ ok: true, method: 'downloads-api', id, filename, rulesReady })
      } catch (error) {
        sendResponse({ ok: false, error: String((error && error.message) || error), rulesReady })
      } finally {
        scheduleRelease()
      }
    })()
    return true
  }

  if (message.type === 'rules') {
    ;(async () => {
      const rulesReady = await acquireRules()
      scheduleRelease()
      sendResponse({ ok: rulesReady })
    })()
    return true
  }

  return undefined
})

chrome.runtime.onInstalled.addListener(() => {
  if (!hasRulesets()) return
  chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [RULESET_ID] }).catch(() => {})
})
