/**
 * Douyin Cinema UI — first-paint guard.
 *
 * Runs at `document_start`, before Douyin's React shell paints anything, and
 * therefore before the main content script is allowed to run at `document_idle`.
 * It only does two things:
 *
 * 1. Marks the document so the scoped stylesheet starts applying immediately.
 * 2. Paints a static 56px strip where our bar will live and blanks the parts of
 *    the original shell we are about to replace, so the untouched UI is never
 *    visible for a frame.
 *
 * The class `dcinema-ready` is added later by the main script once the real bar
 * exists, which removes the placeholder strip.
 */

(() => {
  const root = document.documentElement
  if (!root || root.classList.contains('dcinema')) return
  root.classList.add('dcinema')

  const BOOT_CSS = `
    /* No white flash: the page is black before any of the site's CSS loads. */
    html.dcinema, html.dcinema body { background: #000 !important; }

    /* The left column holds the logo and the channel list; it is replaced by the
       bar, so it must never be laid out at its original 160px. */
    html.dcinema .header-ui > div:has([data-e2e="douyin-navigation"]) { display: none !important; }

    /* The site's own header content (search box, account icons) sits where our bar
       goes. Blank it until the bar replaces it. */
    html.dcinema:not(.dcinema-ready) .header-ui > div > div:has([data-e2e="searchbar-button"]) { opacity: 0 !important; }

    /* Placeholder strip in the exact shape of the final bar. */
    html.dcinema:not(.dcinema-ready)::after {
      content: "";
      position: fixed;
      inset: 0 0 auto 0;
      height: 56px;
      background: rgba(10, 10, 12, 0.96);
      backdrop-filter: blur(16px) saturate(140%);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      z-index: 2147482999;
    }

    /* Apply the rail position immediately so it never jumps from the default. */
    html.dcinema .positionBox {
      top: 50% !important;
      bottom: auto !important;
      right: 10px !important;
      transform: translateY(-50%) !important;
    }
  `

  // Warm up the connections the first paint depends on: their DNS + TLS setup
  // otherwise lands right in the critical path of the first images and the video.
  const PRECONNECT = [
    'https://lf-douyin-pc-web.douyinstatic.com',
    'https://p3-pc-sign.douyinpic.com',
    'https://v26-weba.douyinvod.com',
  ]

  try {
    const head = document.head || root
    for (const origin of PRECONNECT) {
      const link = document.createElement('link')
      link.rel = 'preconnect'
      link.href = origin
      link.crossOrigin = 'anonymous'
      head.appendChild(link)
    }
  } catch {
    /* hints only */
  }

  try {
    const style = document.createElement('style')
    style.id = 'dcinema-boot-css'
    style.textContent = BOOT_CSS
    ;(document.head || root).appendChild(style)
  } catch {
    /* if the style cannot be inserted the page still works, just with a flash */
  }

  // Fail-safe: if the main script never builds the bar (an error, a route it does
  // not understand), stop masking the site's own header after a few seconds.
  setTimeout(() => {
    if (!root.classList.contains('dcinema-ready')) root.classList.add('dcinema-ready')
  }, 4000)
})()
