# Douyin Cinema UI

抖音网页版的**轻量增强扩展**（Chrome MV3）：保留抖音原本的界面，只加两件事——**进入详情页**和**无水印下载**，外加一个「进度条点击失效时」的兜底。

> A deliberately small Chrome extension for douyin.com: leave the site alone, add a 详情 button, a watermark-free download button, and a seek fallback that only kicks in when the site's own progress bar stops responding.

## 做什么

| 功能 | 说明 |
|---|---|
| **详情** | 读取当前视频/图文的 id，跳转 `/video/<id>` 或 `/note/<id>` |
| **下载** | 视频走浏览器原生下载任务（隐藏 iframe + DNR 兜底），文件名 `douyin/<作者>-<描述>.mp4`；图文逐张保存 `.webp` |
| **进度条兜底** | 每次点击进度条都会**测量**站点是否真的跳转了；只有在它没反应时，扩展才自己执行 seek 并给出"跳转至 mm:ss"提示 |
| 位置 | 两个按钮追加在播放器自带控制条的右侧（`.xg-right-grid`）；没有播放器的页面（如图文）改为右下角浮动 |

## 不做什么

上一版曾重写整套界面（自建顶栏、隐藏侧栏与各类入口、强制视频铺满、搜索历史……）。现在这些**全部移除**——页面就是抖音本来的样子，扩展只做上面三件事。

## 安装

1. `chrome://extensions/` → 开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选择本仓库的 **`ext/`** 目录
3. 刷新 douyin.com

改代码后需在扩展卡片点 **↻ 重载**，再刷新页面。

## 结构

```
ext/
├── manifest.json          MV3 清单（downloads / declarativeNetRequestWithHostAccess）
├── background.js          下载任务、完成/失败回报、DNR 规则集开关
├── rules/download.json    referer / origin，以及 iframe 兜底用的 content-disposition
├── content/
│   ├── boot.js            document_start：加作用域类 + preconnect
│   ├── page-hook.js       主世界：网络捕获 + aweme JSON 解析（取无水印地址）
│   ├── content.js         隔离世界：两个按钮 + 进度条兜底 + 下载编排
│   └── style.css          仅按钮与 toast 的样式
├── icons/                 16/32/48/128 PNG + SVG
└── README.md              实现细节
docs/TEST-REPORT.md        历史测试报告（对应早期的「影院版」，部分条目已不适用）
mockups/                   早期设计探索稿（历史存档）
```

## 已知限制

- 依赖抖音自身的 DOM 结构（`.xg-right-grid`、`xg-progress`、`[data-e2e]`）；改版可能失效
- 下载地址有时效，需在视频正在播放时点击
- 页面上同时挂着多个播放器（上/当前/下），逻辑一律以「当前可见视频」为基准
- 不处理直播与付费/加密内容

## 免责声明

仅供个人学习与离线备份，请遵守抖音用户协议与版权法规，不要二次分发。

## License

MIT