/**
 * Douyin Cinema UI — service worker.
 *
 * Download strategy (browser-native, no fetch → no CORS, no memory spike):
 *
 * 1. The content script asks to prepare a download and then points a hidden
 *    1×1 iframe at the CDN URL.
 * 2. While a download is in flight, the static ruleset `download` is enabled.
 *    It adds `referer: https://www.douyin.com/` to that sub_frame request and
 *    rewrites the response to `content-disposition: attachment`, so the browser
 *    saves the file instead of rendering it.
 * 3. `downloads.onDeterminingFilename` gives the file a readable name derived
 *    from the author and description that the content script sent along.
 *
 * The ruleset stays disabled the rest of the time, so ordinary playback is
 * unaffected.
 */

const RULESET_ID = 'download'
const NAME_TTL_MS = 60_000

/** url → { fullFilename, at } for downloads we are about to trigger. */
const pendingNames = new Map()
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
      /* it will be retried on the next download */
    }
  }, delayMs)
}

/** Turn an arbitrary title into a safe, readable mp4 file name. */
function fileNameOf(raw, index) {
  const base = String(raw || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90)
  const stem = base || `douyin-${Date.now()}`
  const suffix = Number.isInteger(index) && index > 0 ? `-${index}` : ''
  return `douyin/${stem}${suffix}.mp4`
}

const isCdnVideo = (url) => typeof url === 'string' && /douyinvod\.com|bytecdn\.cn|ibytedtos\.com|douyincdn\.com/.test(url)

function pruneNames() {
  const now = Date.now()
  for (const [url, entry] of pendingNames) {
    if (now - entry.at > NAME_TTL_MS) pendingNames.delete(url)
  }
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  pruneNames()
  const direct = pendingNames.get(item.url) || pendingNames.get(item.finalUrl)
  if (direct) {
    pendingNames.delete(item.url)
    pendingNames.delete(item.finalUrl)
    suggest({ filename: direct.fullFilename, conflictAction: 'uniquify' })
    return
  }
  if (isCdnVideo(item.url)) {
    // A download we did not stage: still give it a tidy folder and name.
    suggest({ filename: fileNameOf('', 0), conflictAction: 'uniquify' })
  }
})

chrome.downloads.onCreated.addListener((item) => {
  if (!isCdnVideo(item.url)) return
  scheduleRelease(15_000)
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined

  if (message.type === 'prepare-download') {
    ;(async () => {
      pruneNames()
      const filename = fileNameOf(message.title, message.index)
      if (typeof message.url === 'string') {
        pendingNames.set(message.url, { fullFilename: filename, at: Date.now() })
      }
      const rulesReady = await acquireRules()
      scheduleRelease()
      sendResponse({ ok: true, filename, rulesReady })
    })()
    return true
  }

  if (message.type === 'download') {
    // Legacy path: hand the URL to the browser directly.
    ;(async () => {
      const filename = fileNameOf(message.title, message.index)
      try {
        const id = await chrome.downloads.download({
          url: message.url,
          filename,
          conflictAction: 'uniquify',
          saveAs: false,
        })
        sendResponse({ ok: true, method: 'direct', id, filename })
      } catch (error) {
        sendResponse({ ok: false, error: String((error && error.message) || error) })
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
  // Nothing in flight at install time.
  chrome.declarativeNetRequest
    .updateEnabledRulesets({ disableRulesetIds: [RULESET_ID] })
    .catch(() => {})
})
