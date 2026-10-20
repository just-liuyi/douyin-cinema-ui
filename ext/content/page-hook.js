/**
 * Douyin Cinema UI — MAIN-world hook.
 *
 * The recommend feed plays through MediaSource, so the visible <video> only has a
 * `blob:` src and the real file URL never appears in the DOM. This script runs in
 * the page's own world, before the app boots, and remembers what the app fetches:
 *
 * - aweme JSON responses (detail / post / search) → `video.play_addr` candidates,
 *   which are watermark-free.
 * - CDN media URLs seen through fetch/XHR → last-resort candidates.
 *
 * The isolated content script asks for these over window.postMessage.
 */

(() => {
  const KEY = '__dcinema'
  if (window[KEY]) return

  /** @type {{ playUrl: string, desc: string, author: string, awemeId: string, at: number }[]} */
  const items = []
  const mediaUrls = []
  const MAX = 60

  const store = { items, mediaUrls }
  window[KEY] = store

  const pushMedia = (url) => {
    if (typeof url !== 'string') return
    if (!/^https?:\/\//.test(url)) return
    if (!/douyinvod\.com|bytecdn\.cn|ibytedtos\.com|douyincdn\.com/.test(url)) return
    if (!/\/video\/tos\/|\.mp4|\.m4s/.test(url)) return
    if (mediaUrls.includes(url)) return
    mediaUrls.unshift(url)
    if (mediaUrls.length > MAX) mediaUrls.length = MAX
  }

  const pickUrl = (addr) => {
    if (!addr) return ''
    if (typeof addr === 'string') return addr.replace(/^\/\//, 'https://')
    const list = addr.url_list || addr.urlList
    if (Array.isArray(list) && list.length > 0) return String(list[0]).replace(/^\/\//, 'https://')
    if (typeof addr.uri === 'string' && /^https?:/.test(addr.uri)) return addr.uri
    return ''
  }

  /** Walk any JSON shape and harvest objects that look like an aweme. */
  const harvest = (node, depth = 0) => {
    if (!node || depth > 8) return
    if (Array.isArray(node)) {
      for (const entry of node) harvest(entry, depth + 1)
      return
    }
    if (typeof node !== 'object') return

    const video = node.video
    if (video && typeof video === 'object') {
      const playUrl = pickUrl(video.play_addr) || pickUrl(video.playAddr) || pickUrl(video.download_addr)
      if (playUrl) {
        const awemeId = String(node.aweme_id || node.awemeId || node.group_id || node.groupId || '')
        const desc = String(node.desc || node.title || node.caption || '')
        const author =
          (node.author && (node.author.nickname || node.author.name)) ||
          (node.authorInfo && node.authorInfo.nickname) ||
          ''
        const key = awemeId || playUrl
        const existing = items.findIndex((entry) => (entry.awemeId || entry.playUrl) === key)
        const record = { playUrl, desc, author: String(author || ''), awemeId, at: Date.now() }
        if (existing >= 0) items[existing] = record
        else items.unshift(record)
        if (items.length > MAX) items.length = MAX
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') harvest(value, depth + 1)
    }
  }

  // ---- fetch hook -------------------------------------------------------
  const originalFetch = window.fetch
  if (typeof originalFetch === 'function') {
    window.fetch = function patchedFetch(...args) {
      const request = args[0]
      const url = typeof request === 'string' ? request : request && request.url
      const result = originalFetch.apply(this, args)
      try {
        if (url && typeof url === 'string') {
          pushMedia(url)
          if (/aweme\/v1\/web\/|aweme\/v1\/web\/aweme|get_user_summary/.test(url) || /aweme|aweme_id/.test(url)) {
            result
              .then((response) => {
                if (response && response.clone) response.clone().json().then((data) => harvest(data)).catch(() => {})
              })
              .catch(() => {})
          }
        }
      } catch {
        /* never break the page */
      }
      return result
    }
  }

  // ---- XHR hook --------------------------------------------------------
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__dcinemaUrl = url
    return originalOpen.call(this, method, url, ...rest)
  }
  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    try {
      const url = this.__dcinemaUrl
      if (typeof url === 'string') {
        pushMedia(url)
        if (/aweme|aweme_id/.test(url)) {
          this.addEventListener('load', () => {
            try {
              const text = this.responseText
              if (text && text.length < 4_000_000) harvest(JSON.parse(text))
            } catch {
              /* non-JSON */
            }
          })
        }
      }
    } catch {
      /* never break the page */
    }
    return originalSend.apply(this, args)
  }

  // ---- resource timing: catches media the app loads before we see it ----
  const sweepTiming = () => {
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        if (entry && typeof entry.name === 'string') pushMedia(entry.name)
      }
    } catch {
      /* ignore */
    }
  }
  sweepTiming()
  setInterval(sweepTiming, 4000)

  // ---- answer content-script queries -----------------------------------
  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || data.source !== 'dcinema-content' || data.type !== 'query') return
    sweepTiming()
    window.postMessage(
      {
        source: 'dcinema-page',
        type: 'result',
        nonce: data.nonce,
        items: store.items.slice(0, 20),
        mediaUrls: store.mediaUrls.slice(0, 20),
      },
      '*',
    )
  })
})()
