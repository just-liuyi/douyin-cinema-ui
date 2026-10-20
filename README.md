# Douyin Cinema UI

把抖音网页版改造成**影院式暗色界面**的浏览器扩展（Manifest V3），附带**无水印视频下载**。

> A Chrome (MV3) extension that reworks douyin.com into a dark, cinema-style layout, with watermark-free video download.

## 特性

| 方面 | 内容 |
|---|---|
| 顶栏 | 自绘一条栏：品牌 · 推荐/关注/我的 · 搜索 · ⬇ 下载 · 消息/我的 |
| 频道 | 左侧栏整体移除，不占宽度；视频左右铺满 |
| 播放 | 左右铺满（横屏裁切、竖屏完整）、修复进度条点击跳转、`←`/`→` 键 ±5 秒 |
| 精简 | 隐藏点赞 / 收藏 / 听抖音 / 更多、AI 气泡、下载 App 促销、识别画面、投稿等入口 |
| 右侧竖排 | 复用抖音原生动作条，仅改为贴右边 + 垂直居中 |
| 下载 | 视频：浏览器原生流式下载（隐藏 iframe + DNR），`douyin/<作者>-<描述>.mp4`；图文：逐张保存 `douyin/<标题>-N.webp` |
| 详情 | 顶栏「详情」按钮跳转 `/video/<id>` 或 `/note/<id>` |
| 首屏 | `document_start` 阶段遮蔽，刷新时不会先闪出原页面 |
| 图标 | `ext/icons/` 下的 16/32/48/128 PNG 与同款 SVG |

## 安装

1. 打开 `chrome://extensions/`，右上角开启「开发者模式」
2. 点「加载已解压的扩展程序」，选择本仓库的 **`ext/`** 目录
3. 打开/刷新 <https://www.douyin.com/>

修改代码后需要点扩展卡片上的 **↻ 重新加载** 再刷新页面。

## 结构

```
ext/
├── manifest.json          MV3 清单（含 icons）
├── background.js          下载执行 + 会话 DNR 规则集开关 + 文件命名
├── rules/download.json    让 CDN 放行的静态规则（referer / content-disposition）
├── icons/                 扩展图标（16/32/48/128 PNG + 同款 SVG）
├── content/
│   ├── boot.js            document_start：首屏遮蔽（防闪烁）
│   ├── page-hook.js       主世界：网络捕获 + aweme JSON 解析（取无水印地址）
│   ├── content.js         隔离世界：顶栏、精简、进度条修复、下载
│   └── style.css          全部注入样式（作用域 html.dcinema）
└── README.md              实现细节与取舍（推荐阅读）

mockups/                   设计探索用的静态样稿（可直接双击打开）
├── mock-a-semi-clean.html
├── mock-b-cinema.html
└── mock-c-editorial.html
```

## 实现要点

- **不重写播放器**：只接管进度条手势（站点该手势在部分构建里失效），画面仍由原播放器渲染
- **不隐藏必要的原生控件**：消息面板等通过「转发点击到原生元素」实现，因此保留其布局
- **取址靠网络捕获**：MSE 播放时 `<video>` 只有 `blob:`，无水印地址来自 aweme 接口的 `play_addr` 与 `performance` 资源
- **下载不走 JS**：隐藏 1×1 iframe + DNR 改写响应头，由浏览器流式写盘，无 CORS、无内存压力
- **选择器策略**：优先 `data-e2e` 与稳定语义类名（如 `.positionBox`），哈希类名一律不用

详见 [`ext/README.md`](ext/README.md)。

## 已知限制

- 抖音发版可能使某些选择器失效；关键改动都集中在 `content.js` 的若干 `trim*`/`build*` 函数里，便于快速修复
- 下载地址有时效（CDN 签名），需在视频正在播放时点击
- 不处理直播与付费内容

## 免责声明

仅供个人学习与离线备份使用。请遵守抖音用户协议与版权法规，不要用于二次分发或商业用途。

## License

MIT
