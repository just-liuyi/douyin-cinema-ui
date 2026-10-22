/**
 * Douyin Cinema UI — first-paint boot.
 *
 * The minimal build no longer masks or reshapes the page, so this file only:
 *
 * 1. marks the document (`html.dcinema`) so the scoped stylesheet applies to our
 *    two buttons,
 * 2. warms up the connections the first paint needs.
 *
 * All the previous placeholder-strip / hidden-header logic is gone on purpose:
 * the page should look like Douyin, immediately.
 */

(() => {
  const root = document.documentElement
  if (!root) return
  if (!root.classList.contains('dcinema')) root.classList.add('dcinema')

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
})()
