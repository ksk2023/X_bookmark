<div align="center">

# X Bookmark Organizer

给 X 收藏夹装上分类、搜索、时间线和一点点 AI 的浏览器插件。

不是又一个“收藏夹套壳”，而是把那些被你顺手收藏、然后再也没见过的推文，重新捞出来、排好队、贴上标签。

[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-ff4d5a?style=flat-square)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Local First](https://img.shields.io/badge/Data-Local%20First-ff6b6b?style=flat-square)](#数据与隐私)
[![AI Optional](https://img.shields.io/badge/AI-Optional-f43f5e?style=flat-square)](#ai-分类)
[![Version](https://img.shields.io/badge/version-0.6.12-b91c1c?style=flat-square)](./manifest.json)

</div>

## 这是什么

X Bookmark Organizer 是一个用于整理 X (Twitter) 书签的 Chrome / Edge 插件。

它会把你的收藏内容变成一个本地知识库：可以同步、搜索、分类、按时间筛选，也可以用热力图和折线图看自己到底在哪些时间段收藏了什么。你还可以接入 OpenAI 兼容接口，让 AI 根据推文内容和你的分类描述，给出分类建议。

简单说，它适合这类场景：

- 你收藏了很多推文，但回头完全找不到。
- 你想知道某一天、某一周、某个月到底收藏了哪些内容。
- 你想把 AI、开发、投资、论文、生活、灵感等内容分开管理。
- 你希望数据优先留在本地，不想把收藏夹变成又一个云端黑盒。
- 你想让 AI 帮忙初步分类，但最终仍由你拍板。

## 功能一览

| 模块 | 能做什么 |
| --- | --- |
| 书签同步 | 在已登录 X 的浏览器环境中同步书签内容，支持全量同步和当前页面扫描回退 |
| 分类管理 | 新建分类、编辑分类、批量归类、忽略、删除本地记录 |
| 时间筛选 | 按推文发布时间或本地入库时间筛选，支持日、周、月、半年、年 |
| 可视化 | 左侧热力图看密度，右侧折线图看趋势，峰值和统计卡片同步展示 |
| 推文展示 | 尽量保留作者、正文、链接、图片、视频等原始信息 |
| 博主管理 | 汇总书签中出现的博主，展示粉丝数、推文数、关联收藏等信息 |
| 浏览记录 | 可选保存 X 浏览历史，本地存储，方便回溯 |
| AI 分类 | 支持自定义 Base URL、API Key、模型名和分类提示词 |
| 数据备份 | 支持 JSON 导入 / 导出，迁移和备份更方便 |

## 界面思路

插件的管理页不是只塞一张长表，而是按“先看趋势，再看内容”的方式组织：

1. 先用热力图和折线图看收藏分布。
2. 点某一天、某一周或某个月。
3. 下方只展示对应时间段的推文。
4. 再进行搜索、分类、批量处理。

这样做的好处是：收藏很多也不需要一次性渲染几千条卡片，页面不容易卡死，你也不用在长列表里迷路。

## 安装

项目会在 `output` 目录下生成两种交付物：

```text
output/x-bookmark-organizer-0.6.12.crx
output/x-bookmark-organizer-0.6.12/
```

推荐安装解压文件夹：

1. 打开 Chrome 或 Edge。
2. 进入 `chrome://extensions/`。
3. 打开右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」。
5. 选择 `E:\BaiduNetdiskDownload\X_bookmark\output\x-bookmark-organizer-0.6.12`。
6. 安装完成后，工具栏会出现插件图标。

如果你手里只有 `.crx`，也可以把后缀改成 `.zip` 或 `.rar` 后解压，再用「加载已解压的扩展程序」安装解压出来的文件夹。

## 快速开始

### 1. 同步书签

先登录 `https://x.com/`，然后点击插件弹窗里的「完整同步全部书签」。

同步完成后，进入管理页，就可以看到书签、分类、统计图和时间筛选。

### 2. 新建分类

在左侧分类区点击「+ 分类」，输入名称、颜色和描述。

描述很重要。它不只是给你看的，也是 AI 分类时的重要参考。例如：

```text
人工智能：大模型、Agent、提示词、推理框架、AI 产品和行业动态
前端开发：React、Vue、浏览器、CSS、工程化、UI 组件
投资理财：宏观经济、股票、加密货币、风险提示和交易复盘
```

### 3. 用时间找回收藏

顶部可以选择：

- 时间依据：推文发布时间 / 收藏记录时间
- 时间范围：全部 / 年 / 半年 / 月 / 日 / 自定义
- 展示粒度：自动 / 年 / 半年 / 月 / 周 / 日

热力图负责回答“哪些时间段收藏多”，折线图负责回答“收藏趋势怎么变”。点中一个色块后，下方会直接筛出对应推文。

### 4. 整理推文

你可以：

- 单条归类
- 多选批量归类
- 搜索正文、作者和备注
- 忽略不想整理的内容
- 删除本地记录
- 给重要推文加笔记

删除和忽略默认只影响本地记录，不会替你去 X 上取消收藏。

## AI 分类

插件支持 OpenAI Chat Completions 兼容接口。进入「AI 设置」后填写：

```text
API Base URL
API Key
Model
自定义分类提示词
```

OpenAI 示例：

```text
API Base URL: https://api.openai.com/v1
Model: gpt-4o-mini
```

兼容接口既可以填完整 endpoint：

```text
https://open.bigmodel.cn/api/coding/paas/v4/chat/completions
```

也可以填上级 base url：

```text
https://open.bigmodel.cn/api/coding/paas/v4
```

插件会自动判断是否已经包含 `/chat/completions`，避免拼成重复路径。

AI 分类流程是：

1. 填好接口信息。
2. 点击「测试连通」。
3. 点击「AI 整理未分类」。
4. 查看 AI 给出的分类建议。
5. 逐条接受、拒绝或改派。
6. 点击应用后才真正写入分类。

一句话：AI 可以当助手，但不抢你的鼠标。

## 数据与隐私

默认情况下，数据都在本地：

- 书签记录：`chrome.storage.local`
- 分类信息：`chrome.storage.local`
- 浏览历史：`chrome.storage.local`
- AI 设置：`chrome.storage.local`

插件不会保存你的 X 密码，也不会主动把数据上传到第三方服务器。

只有当你启用 AI 分类时，参与分类的推文文本、作者信息和分类描述会发送到你填写的 AI 接口。API Key 也只存在本地浏览器存储里。请不要把包含 API Key 的截图、日志或配置文件公开发布。

## 本地开发

这是一个原生 Chrome MV3 插件，主要使用 HTML、CSS 和 vanilla JavaScript。

```text
X_bookmark/
├─ manifest.json
├─ background.js
├─ content.js
├─ popup/
├─ options/
├─ lib/
├─ icons/
├─ output/
└─ _pack.cjs
```

常用命令：

```bash
node --check lib/ai.js
node --check background.js
node _pack.cjs
```

打包后会生成：

```text
output/x-bookmark-organizer-版本号.crx
output/x-bookmark-organizer-版本号.zip
output/x-bookmark-organizer-版本号/
```

注意：`x-bookmark-organizer.pem` 是 CRX 签名私钥，必须自己保存好，不要提交到公开仓库。

## 已知限制

- X 内部接口可能变化，全量同步能力需要随 X 更新而适配。
- X 不稳定提供真实收藏时间，所以插件默认更推荐用「推文发布时间」做历史分布。
- 博主粉丝数、推文数、浏览量等信息依赖 X 页面或接口当前能提供什么。
- AI 分类质量取决于模型能力、分类描述和提示词。
- 大量收藏场景下，插件会优先按时间段和分页加载，避免一次性渲染导致页面卡顿。

## README 风格参考

这个 README 的表达和结构参考了这些项目的首页气质：

- [farion1231/cc-switch](https://github.com/farion1231/cc-switch)
- [KMnO4-zx/paper_online](https://github.com/KMnO4-zx/paper_online)
- [lvy010/X-Plore](https://github.com/lvy010/X-Plore)

## 致谢

- 开发者：[ksk2023](https://github.com/ksk2023)。负责把“我觉得应该能用”推进到“它真的能点、能跑、能看图”。
- Token 供应商：[cnYui](https://github.com/cnYui)。感谢给 AI 小引擎加油，没油的时候它只会坐在原地装深沉。

也感谢每一次截图、吐槽和“继续继续”。项目就是这样一点点长出来的。

