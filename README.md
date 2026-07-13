# 表格任务匹配分析台

这是一个可直接部署到 GitHub Pages 的静态网站，用于：

1. 上传表格文件并写入后端数据仓库；
2. 前端按文件名选择已上传的数据表并读取内容；
3. 上传 JSONL 文件，提取其中的 `task` 字段；
4. 计算这些 `task` 是否都包含在所选表格数据中；若不全部包含，则给出匹配占比。

## 目录结构

- `site/`：GitHub Pages 静态站点源码
- `supabase/schema.sql`：Supabase 数据表、存储桶和策略初始化脚本
- `scripts/local_verify.py`：无需第三方依赖的本地验证脚本
- `.github/workflows/deploy.yml`：GitHub Pages 自动部署配置

## 推荐架构

- 前端托管：GitHub Pages
- 后端数据仓库：Supabase
  - `storage` 保存原始表格文件
  - `table_datasets` 保存解析后的工作表内容与文件元数据

之所以这样设计，是因为 GitHub Pages 只能托管静态资源，不能直接承载自建后端接口。

## 1. 配置 Supabase

1. 创建一个 Supabase 项目；
2. 在 SQL Editor 中执行 `supabase/schema.sql`；
3. 打开 `site/assets/config.js`，填入：

```js
window.APP_CONFIG = {
  supabaseUrl: 'https://你的项目.supabase.co',
  supabaseAnonKey: '你的 anon key',
};
```

如果不填写这两个值，页面会自动启用浏览器本地演示模式，并把解析后的数据暂存在浏览器本地数据库中，方便先验证前端流程。

## 2. 本地打开

建议使用任意静态服务器打开 `site/` 目录；多数浏览器直接双击 `site/index.html` 也能打开页面，但更推荐通过本地服务访问。


## 3. 部署到 GitHub Pages

1. 将当前目录初始化为 Git 仓库并推送到 GitHub；
2. 默认工作流会在推送到 `main` 分支后自动部署 `site/` 目录；
3. 在 GitHub 仓库的 `Settings -> Pages` 中确认使用 `GitHub Actions` 作为部署来源。

## 4. 使用方式

1. 在“后端仓库配置”中填写 Supabase 信息并保存；
2. 在“上传表格文件”中上传 `.xlsx` / `.xls` / `.csv`；
3. 在“选择数据表”中按文件名选择目标表格，再切换工作表；
4. 在“读取 JSONL”中上传 `.jsonl` 文件并提取 `task` 字段；
5. 点击“开始匹配计算”，查看匹配总数、占比、未匹配条目和原始结果 JSON。

## 5. 当前目录示例文件验证

当前目录已包含：

- `0702_lowrisk_23app_s2p1t-low-A.xlsx`
- `1.1.jsonl`

我已经用本地脚本实际验证过一次，结果为：

- `taskCount = 455`
- `matchedCount = 455`
- `matchRatio = 100.0%`

如果你也要复现，可执行：

```powershell
& 'C:\Users\user\.workbuddy\binaries\python\versions\3.14.3\python.exe' 'e:\萨摩耶\scripts\local_verify.py' --xlsx 'e:\萨摩耶\0702_lowrisk_23app_s2p1t-low-A.xlsx' --jsonl 'e:\萨摩耶\1.1.jsonl'
```

## 6. 匹配逻辑

- 表格文件会被解析为多个工作表；
- 每个工作表中的所有非空单元格都会参与匹配索引；
- JSONL 中每一条 `task` 会做统一归一化处理（转小写、去空白）；
- 只要某条 `task` 被发现包含于任一单元格文本或同一行拼接文本中，即记为匹配成功；
- 匹配占比 = `matchedCount / taskCount * 100%`。

