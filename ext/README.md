# Douyin Cinema UI（方案 B）

浏览器扩展（Manifest V3），把抖音网页版改成影院式暗色界面，并支持**无水印视频下载**。

## 安装

1. 打开 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录（`douyin-ui-lab/ext`）
4. 打开/刷新 `https://www.douyin.com/`

> 该扩展与 `dsh-bridge-browser` 无关，是独立安装的第二个扩展。

## 功能

| 功能 | 实现 | 状态 |
|---|---|---|
| 导航精简（只留 推荐/关注/朋友/我的） | 按**文本**匹配隐藏条目（类名是哈希的，不可靠） | ✅ |
| 隐藏点赞 / 收藏入口 | `data-e2e`、`aria-label`、`title` 三重匹配 | ✅ |
| 暗色影院底色 | `html.dcinema` 作用域下的 token 覆盖 | ✅ |
| 进度条点击跳转 | 捕获阶段接管 `xg-progress` 的 `pointerdown`，直接设 `currentTime` | ✅ |
| ←/→ 键 ±5 秒 | 键盘监听（输入框内不拦截） | ✅ |
| 无水印下载 | 视频走 CDN；图文逐张保存 | ✅ |
| 详情页跳转 | 视频 `/video/<id>`、图文 `/note/<id>` | ✅ |

## 下载机制（浏览器原生，最稳）

抖音现在用 **MSE** 播放，可见 `<video>` 只有 `blob:` 地址，DOM 里拿不到文件 URL。所以分成「取址」和「下载」两段：

**取址**（三层，按可靠性排序）

1. **网络捕获**：`content/page-hook.js` 注入主世界，包装 `fetch`/`XMLHttpRequest`，并从 `performance.getEntriesByType('resource')` 中筛出 `douyinvod.com` / `bytecdn.cn` 请求。实测这些地址带 `mime_type=video_mp4`，是完整 mp4。
2. **aweme JSON**：同一个包装器顺带解析接口响应里的 `video.play_addr`（同样无水印），带描述与作者，用于精确匹配当前条目。
3. **DOM 兜底**：`<video>.currentSrc`（非 blob 时）与 `<source src>`。

**下载**（优先走浏览器原生任务，关键是不经过 JS）

首选 `chrome.downloads.download({ url, filename })`：会在 Chrome 下载气泡里生成**可见任务**（可暂停/继续/重试），完成后由 service worker 通过 `downloads.onChanged` 回报，页面弹出「下载完成：<文件名>（X MB）」；被中断则提示原因。当 CDN 拒绝这种请求时，才退回到下面的隐藏 iframe 方案。

```
content script                     service worker
     │  prepare-download(url,title) ─────►  启用静态规则集 download（引用计数）
     │  ◄────────────────── ok, filename
     ▼
 建一个 1×1 隐藏 iframe，src = 视频地址
     │  ── sub_frame 请求 ──► CDN
     │        ▲ 规则注入 referer: https://www.douyin.com/
     │        ▲ 规则注入响应头 content-disposition: attachment
     ▼
 浏览器把它当下载，流式落盘
```

静态规则集 `rules/download.json`（平时 `enabled: false`）：

| 规则 | 条件 | 动作 |
|---|---|---|
| 1 | `||douyinvod.com/`、`sub_frame`、initiator `douyin.com` | 请求头 `referer` |
| 2 | 同上 | 响应头 `content-disposition: attachment` |

文件名由 `chrome.downloads.onDeterminingFilename` 给出（`douyin/<作者>-<描述>.mp4`，冲突自动加序号）。

**为什么不用 `fetch` + blob**：实测页面内 `fetch` 该 CDN 会被 CORS 拦（`Failed to fetch`），而且整段视频进内存对几百 MB 的文件不稳定。iframe 方案由浏览器直接流式写盘，没有这些问题。
## 与原用户脚本的差异（为什么不能直接搬）

你提供的脚本依赖 Tampermonkey 专有 API，扩展里没有对应物，且部分选择器已失效：

| 原脚本 | 现在 | 原因 |
|---|---|---|
| `GM_xmlhttpRequest` | `chrome.downloads` + DNR 注入头 | 扩展无 GM API；且页面内 `fetch` 该 CDN 会被 CORS 拦（实测 `Failed to fetch`） |
| `GM_download` | `chrome.downloads.download` | 同上 |
| `unsafeWindow.fetch` 钩子 | `world: "MAIN"` 的 `page-hook.js` | MV3 的标准做法，不需要 `unsafeWindow` |
| `#RENDER_DATA` → `videoDetail.playAddr` | 降级为兜底 | 当前版本 `RENDER_DATA` 只剩 `{app:{...}}` 配置，**没有 playAddr** |
| `.account-name` / `.title` / `.positionBox` / `.xg-right-grid` | 保留并加祖先回溯 | 这些仍在（各 3 个），但 `.title` 需从 video 往上找容器 |
| sweetalert / jQuery / clipboard | 原生 toast | 去掉 CDN 依赖，缩减权限面 |

## 已知限制

1. **地址有时效**：CDN 的 `?a=...` 签名会过期，必须在「正在播放/刚播放过」的页面上点下载。
2. **按钮注入点依赖站点结构**：`.positionBox`（推荐流）与 `.xg-right-grid`（详情页）不存在时会退化为右下角浮动按钮。
3. **登录态**：下载沿用浏览器 cookie；未登录的受限视频可能仍失败。
4. **不处理直播与付费/加密内容**；图文以图片形式逐张下载。
5. **合规**：仅供个人离线备份；请遵守抖音用户协议与版权要求，不要用于二次分发。

## 目录

```
ext/
├── manifest.json          MV3 清单（downloads / storage / declarativeNetRequest）
├── background.js          下载执行 + 会话 DNR 规则
├── content/
│   ├── page-hook.js       主世界：网络捕获 + aweme 解析（document_start）
│   ├── content.js         隔离世界：导航精简、隐藏点赞收藏、进度条修复、下载按钮
│   └── style.css          暗色 token、按钮与 toast 样式
```
