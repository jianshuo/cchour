# TODO — cchour AI 编程工具时间报表

# TODO 迭代 11（2026-06-15）— 英文支持 + 按系统语言自动切换

- [x] 1. 语言检测 `detectLang(argv)`：优先 `--lang zh|en`，其次 `CCHOUR_LANG`，再次环境变量 `LC_ALL`/`LC_MESSAGES`/`LANG`，macOS 兜底读 `defaults read -g AppleLocale`；命中 `zh*` → zh，否则 en。本机 LANG=zh_CN → 仍走中文，行为不变。
- [x] 2. 翻译目录 `T = { zh, en }`：覆盖 CLI 帮助 / 进度 / 错误信息，以及 HTML 静态骨架；客户端字符串打包进内嵌 JSON 的 `t` 字段，前端 JS 走 `D.t.*`。
- [x] 3. 数据层不动（`--json` 已验证 zh/en 除 generatedAt 外完全一致）；展示层 `localizeCat` + `localizeProj`（按 ` · ` 拆 base/cat 分别翻），在 buildEmbedData 翻译嵌入 cat/proj。
- [x] 4. `--lang` 进 parseArgs（消费值、不报未知参数）+ 写进 help；`html lang` 随语言切换。
- [x] 5. 本地验证：默认 zh_CN 与迭代 10 完全一致（231h/217h/13.9h）；`--lang en` 全英文、点 Last month 就地重算（Range 2026-05-01~05-31, 118h）；中英 console 均无错误；`--json` 语言无关。
- [x] 6. 版本 bump 1.8.0，README 补语言切换说明，commit + push。
- [x] 7. 更新 STATE.md / TODO.md（标记全部完成）。

# TODO 迭代 10（2026-06-11）— HTML 报表内交互式时间范围选择器

- [x] 1. buildReport 增加可嵌入的按日数据：每工具 daily + dayHour（天×24 小时）、每项目 daily（分类由项目行在前端聚合得出，嵌入 JSON 仅 16KB）
- [x] 2. renderHtml 重写为「静态骨架 + 内嵌 JSON + 前端渲染」：页面顶部范围选择条（全部/今天/本周/上周/本月/上月/近7天/近30天/近90天 + 自定义两个日期输入，反序自动交换），切换后总览卡片、日/周/月图、24 小时分布、工作分类、Top 项目全部就地重算重绘；前端脚本不用模板字符串（嵌在服务端模板字面量里，反引号和 ${ 会被吃掉）
- [x] 3. 语义约定：前端按「日桶归属」求和；验证选「全部」与 CLI 完全一致（229.65h/13.94h），dayHour 与 daily 总和一致
- [x] 4. CLI 行为不变：--since/--until/--week/--month 仍在采集后过滤事件（报表只嵌入过滤后数据，头部加「数据已按命令行参数截取」提示）；--json 输出不动
- [x] 5. 本地运行验证：浏览器点「上月」=133h/11.3h 与 `cchour --month last`（133.28/11.32）一致；「上周」=66.1h 与 `--week last`（66.14h）一致（差 0.01h 为日桶边界语义）；「今天」单日 8.6h；console 无错误；两种状态截图核对各板块正常
- [x] 6. 版本 bump 1.7.0，README 补交互说明，commit + push
- [x] 7. 更新 STATE.md / TODO.md

# TODO 迭代 9（2026-06-11）— --week / --month 周报月报快捷模式

- [x] 1. 确认 npm 发布状态（registry 仍 1.1.0，publish 待用户 OTP，跳过）
- [x] 2. 实现 `--week [last|YYYY-MM-DD]` / `--month [last|YYYY-MM]`：`expandShortcutRange()` 展开为 since/until（周一为一周起点，与周图一致）；与显式 `--since`/`--until` 或彼此同用时报错；范围在未来报错；until 不超过今天
- [x] 3. HTML 头部范围行复用迭代 8 的「统计范围」（展开后自动生效）；`--json` 的 since/until 反映展开后的值
- [x] 4. 本地运行验证：无参数 229.0h/13.9h（与迭代 8 一致+当日新数据）；`--week`=06-08~06-11、`--week last`=06-01~06-07（与等价 --since/--until 的 63.55h/2.59h 完全一致）、`--month last`=05-01~05-31（133.3h/11.3h）、`--week 2026-06-03` 落在 06-01~06-07；6 种非法/冲突用法全部 exit 1；HTML 头部显示「统计范围 2026-05-01 ~ 2026-05-31」
- [x] 5. 版本 bump 1.6.0，README 补说明，commit + push（b6be23c）
- [x] 6. 更新 STATE.md / TODO.md

# TODO 迭代 8（2026-06-11）— --since / --until 日期过滤

- [x] 1. 确认 npm 发布状态：registry 仍是 1.1.0，publish 待用户 OTP（直接发最新版即可）
- [x] 2. 实现 `--since YYYY-MM-DD` / `--until YYYY-MM-DD`：collect 后按本地时区过滤事件（until 含当天整天）；`--days` 继续控制日表窗口，与日期范围共存；无效日期（含 2026-13-99 这类 Date 自动进位值）和 since>until 都报错退出
- [x] 3. HTML 头部显示「统计范围 X ~ Y」；`--json` 带 `since`/`until` 字段；日/周/月图表锚点改为 until（过去日期时）
- [x] 4. 本地运行验证：无参数 228.9h/13.9h（与迭代 7 一致+当日新数据）；06-01~06-10 范围 90.4h，日表正好 10 根柱（06-01..06-10）；`--json` 经 JSON.parse 验证；截图核对渲染正常
- [x] 5. 版本 bump 1.5.0，README 补 `--since`/`--until` 说明，commit + push
- [x] 6. 更新 STATE.md / TODO.md

# TODO 迭代 7（2026-06-11）— --json 输出 + 多消息内容分类

- [x] 1. 确认 npm 发布状态：registry 仍是 1.1.0，publish 待用户 OTP（不可自主完成，留给用户，直接发 1.4.0）
- [x] 2. `--json` 输出模式：默认打 stdout（进度在 stderr 可安全 pipe），显式 `-o` 则写文件；结构含 tools（seconds/hours/daily/weekly/monthly/hourly）、categories、projects
- [x] 3. 内容级分类扫描前 3 条用户消息：`claudeUserTexts()` / `codexUserTexts()`（Codex 侧对 response_item/event_msg 双格式做相邻去重）
- [x] 4. 本地运行验证：228.8h / 13.9h（与迭代 6 的 228.6/13.9 一致）；杂项 63.4h·22% → 51.8h·18%；`--json` 经 JSON.parse 验证；截图核对全部板块正常（browse 安全策略限 /tmp 或 daemon cwd，先复制到 /tmp 再 load-html）
- [x] 5. 版本 bump 1.4.0，README 补 `--json` 说明 + 多消息分类描述，commit + push
- [x] 6. 更新 STATE.md / TODO.md

# TODO 迭代 6（2026-06-11）— 内容级分类扩展到 Codex 与更多目录

- [x] 1. Codex 杂项会话内容级分类：解析 rollout 里 role=user 的 input_text（剔除 `<environment_context>` 等环境块，避免 "codex" 字样误命中），9 个杂项会话全部成功提取
- [x] 2. 内容级分类目录扩展：新增 iCloud 文档（前缀匹配）、Downloads / Desktop / Documents（精确匹配）；Codex 侧对 home / code 根 / Downloads / Desktop / Documents 生效；默认规则与 ~/.cchour/categories.json 的杂项类补了 desktop / documents 关键词
- [x] 3. 本地运行验证：228.6h / 13.9h（与迭代 5 的 228.5/13.9 一致）；杂项 82.0h·29% → 63.4h·22%；截图核对全部板块渲染正常（注意：browse 旧标签页会显示缓存数据，要 load-html 重新加载）
- [x] 4. 版本 bump 1.3.0，README 同步，commit + push
- [x] 5. npm publish — 仍需用户 OTP：`npm publish --access public --otp=<验证码>`（1.2.0 未发布过，直接发 1.3.0 即可）
- [x] 6. 更新 STATE.md / TODO.md

# TODO 迭代 5（2026-06-11）— npm 发布收尾 + 杂项会话内容级分类

- [x] 1. 确认 npm 发布成功：registry 上已有 cchour@1.1.0（用户已用 OTP 发布），`npx cchour@1.1.0 --version` 验证通过
- [x] 2. 杂项（根目录会话）内容级分类：规则格式加可选第三个数组（内容关键词），读会话首条用户消息匹配；~/.cchour/categories.json 已补 8 类内容关键词
- [x] 3. 本地运行验证：总量 228.5h/13.9h 正常（含当日新数据），杂项占比 48% → 29%（128.1h → 82.0h），截图核对渲染正常
- [x] 4. 版本 bump 1.2.0，README 补内容级分类说明，commit + push
- [x] 5. npm publish 1.2.0 — 仍卡 2FA：请在项目目录跑 `npm publish --access public --otp=<验证码>`（留给用户，与 1.1.0 时相同）
- [x] 6. 更新 STATE.md / TODO.md

# TODO 迭代 4（2026-06-11）— 按更新后的 CLAUDE.md 改名 cctime → cchour

- [x] 1. 确认 npm 包名 `cchour` 可用（E404，未被占用）
- [x] 2. 改名：package.json（name/bin）、bin/cchour.js、README、HTML footer、默认输出文件名、.gitignore；个人配置已复制 ~/.cctime/categories.json → ~/.cchour/
- [x] 3. 本地运行验证：`cchour --version` = 1.1.0，报表数字与迭代 3 一致（228.1h / 13.9h）
- [x] 4. commit + push；GitHub 仓库已改名 → https://github.com/jianshuo/cchour（旧 URL 自动跳转，本地 remote 已更新）
- [ ] 5. npm publish cchour — **唯一剩余事项，卡在 2FA**：请在项目目录跑 `npm publish --access public --otp=<验证码>`
- [x] 6. 更新 STATE.md / TODO.md

## 迭代 3（2026-06-11）— 对齐需求规格

- [x] 1. GAP 阈值改为 900 秒（需求：相邻 15 分钟以内算持续工作；原实现误用 300 秒）
- [x] 2. HTML 报表增加按周（最近 12 周，周一起点）、按月（最近 12 个月）堆叠图；README 同步更新
- [x] 3. 本地运行验证：Claude Code 228.1h / Codex 13.9h（阈值放宽后比 300 秒版的 186.9h/11.6h 增加，符合预期），0.6 秒；截图核对周/月图渲染正常
- [x] 4. 版本号 bump 到 1.1.0，commit + push 到 GitHub
- [ ] 5. npm publish — **仍卡在 npm 2FA OTP**（已重试确认 EOTP），需用户跑 `npm publish --otp=<验证码>`
- [x] 6. 更新 STATE.md / TODO.md

## 迭代 1（2026-06-11）— 全部完成 ✅

- [x] 1. 探查数据源
  - [x] Claude Code: `~/.claude/projects/*/*.jsonl`（1061 个文件，783MB，每行带 timestamp + cwd）
  - [x] Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（95 个）+ `archived_sessions`（11 个）
- [x] 2. 写解析脚本 `cctime.py`
- [x] 3. 生成 HTML 报表 `report.html`（浅色白底、纯静态零依赖）
- [x] 4. 无头浏览器截图验证渲染
- [x] 5. 写 STATE.md

## 迭代 2（2026-06-11）— Node 化 + 发布

- [x] 1. 检查 npm 包名 `cctime` 可用 ✓、npm 已登录（jianshuo）✓、gh 已认证 ✓
- [x] 2. 把 cctime.py 移植为 Node.js `bin/cctime.js`（零依赖，流式解析；个人分类规则抽到 ~/.cctime/categories.json）
- [x] 3. package.json：`bin: { cctime }`，支持 `-o` `--days` `--open` `--help` `--version`
- [x] 4. 本地运行验证：186.9h / 11.6h 与 Python 版对齐，0.3 秒；browse 截图核对渲染正常
- [x] 5. README.md + .gitignore（排除 report.html 个人数据）+ LICENSE (MIT)
- [x] 6. git init，https://github.com/jianshuo/cctime 已 push（cctime.py 已移除）
- [ ] 7. npm publish — **卡在 npm 2FA OTP，需用户提供验证码**；之后用 `npx cctime --version` 验证
- [x] 8. 更新 STATE.md
