# Douyin Cinema UI

抖音网页版的**轻量增强扩展**（Chrome MV3）：保留抖音原本的界面，在播放区加上**进入详情页**和**无水印下载**，补上进度条的**跳转兜底**和**章节提示**，并提供一个设置侧边栏。

> A deliberately small Chrome extension for douyin.com: 详情 / download buttons in the playback area, a measured seek fallback for both of douyin's players, chapter hints on the progress bar, and a settings side panel.

## 做什么

| 功能 | 说明 |
|---|---|
| **详情 / 下载** | 在播放区右上角纵向排列（视频、图文通用）；已在本条详情页时「详情」自动隐藏 |
| **下载** | 视频走浏览器原生下载任务（隐藏 iframe + DNR 兜底），文件名 `douyin/<作者>-<描述>.mp4`；图文逐张保存 `.webp` |
| **进度条跳转接管** | 支持新版 `douyin-player` 与旧版 `xgplayer`，点击和拖动都可用；开 = 抖音没跳时由插件跳转，关 = 完全交给抖音 |
| **原生跳转检测** | 后台自动检测（每次真实点击）+ 侧边栏「重新检测」（测完恢复原位置），结果显示在侧边栏 |
| **章节提示** | 悬停或拖动进度条时显示「第几章 · 标题 / 该处时间 / 下一章」 |
| **侧栏收放** | 搜索框左侧「收起 / 展开」，状态刷新后保持 |
| **设置侧边栏** | 点工具栏扩展图标打开；每项功能单独开关，「恢复原版抖音」一键关闭全部（= 原版）；图标透明度滑块；修改即时生效 |

## 不做什么

更早的版本曾重写整套界面（自建顶栏、隐藏侧栏与各类入口、强制视频铺满、搜索历史……）。这些**全部移除**——页面保持抖音本来的样子，扩展只做上面这些。

## 安装

1. `chrome://extensions/` → 开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选择本仓库的 **`ext/`** 目录
3. 刷新 douyin.com

改代码后需在扩展卡片点 **↻ 重载**，再刷新页面。

## 结构

```
ext/
├── manifest.json          MV3 清单（downloads / storage / sidePanel / declarativeNetRequestWithHostAccess）
├── background.js          下载任务、完成/失败回报、DNR 规则集开关
├── rules/download.json    referer / origin，以及 iframe 兜底用的 content-disposition
├── content/
│   ├── boot.js            document_start：加作用域类 + preconnect
│   ├── page-hook.js       主世界：取无水印地址 + 进度条跳转兜底 / 检测 / 章节提示
│   ├── content.js         隔离世界：播放区按钮 + 侧栏收放 + 设置同步 + 下载编排
│   └── style.css          按钮、章节提示、toast 的样式
├── sidepanel/             设置侧边栏（index.html / panel.js / panel.css）
├── icons/                 16/32/48/128 PNG + SVG
└── README.md              实现细节
tools/check-undefined.js   开发检查：找出「调用了但未定义」的函数
docs/TEST-REPORT.md        历史测试报告（对应早期的「影院版」，部分条目已不适用）
mockups/                   早期设计探索稿（历史存档）
```

## 已知限制

- 依赖抖音自身的 DOM 结构与播放器对象（`.basePlayerContainer`、`.douyin-player-progress` / `xg-progress`、`window.player`、`[data-e2e]`）；改版可能失效
- 抖音会混着下发新旧两种播放器，两种都已适配；若出现第三种需要再适配
- 下载地址有时效，需在视频正在播放时点击
- 页面上同时挂着多个播放器（上/当前/下），逻辑一律以「当前可见视频」为基准
- 不处理直播与付费/加密内容

## 免责声明

仅供个人学习与离线备份，请遵守抖音用户协议与版权法规，不要二次分发。

## License

MIT