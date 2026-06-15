# STATE — cchour 项目状态

## 当前状态（迭代 11 完成，2026-06-15）

Node.js 零依赖 CLI，**v1.8.0（本地，待 publish）**：

- 代码：`bin/cchour.js`（单文件，零依赖，Node ≥ 18）
- GitHub：https://github.com/jianshuo/cchour （public，main）
- npm：**cchour@1.1.0 已发布**；1.2.0–1.8.0 均未发布——publish 卡 2FA，
  需用户在项目目录跑 `npm publish --access public --otp=<验证码>`（直接发 1.8.0 即可）
- 迭代 11 改动：英文支持 + 按系统语言自动切换（详见下节）
- 迭代 10 改动：HTML 报表内交互式时间范围选择器（详见下节）

## 英文支持 / 按系统语言切换（迭代 11 引入）

- `detectLang(argv)`：优先级 `--lang zh|en` > `CCHOUR_LANG` 环境变量 >
  `LC_ALL`/`LC_MESSAGES`/`LANG`（`C`/`POSIX` 跳过）> macOS `defaults read -g AppleLocale`
  > 默认 en。`/^zh/i` → zh，否则 en。本机 LANG=zh_CN（且 AppleLocale=zh_CN）→ 仍中文，
  迭代 10 行为完全不变。
- 翻译目录 `T = { zh, en }`（模块级 `let L = T[lang]`，CLI 单次运行用模块变量即可）：
  覆盖 CLI 帮助 / 进度 / 全部错误信息 + HTML 静态骨架（title、html lang 属性、chip、
  分节标题、footer、sub 行、clip 提示）。客户端字符串打包进内嵌 JSON 的 `t` 字段，
  前端 JS 一律走 `D.t.*`（不再硬编码「小时」「天」「占比」「日均」「最近」「统计范围」等）。
- **数据层不动**：项目/分类的内部规范名仍是中文（categories.json 规则、匹配逻辑零改动），
  `--json` 输出稳定不随语言变（已验证 zh/en 两次 --json 除 generatedAt 外完全一致）。
- 仅在**展示层**翻译：`localizeCat`（CAT_I18N，内置 6 类 + 「其他」中→英）、
  `localizeProj`（合成名按 ` · ` 拆 base/cat 分别翻；BASE_I18N 覆盖 code 根目录/home/根目录/
  临时目录/iCloud 文档 的带/不带「（杂项）」两种形式）。在 buildEmbedData 里对嵌入 JSON 的
  cat/proj 翻译，真实项目名（多为英文）和用户自定义分类名（如「产品开发」）原样保留。
- `--lang` 在 parseArgs 里消费其值（不报未知参数），写进 help；`html lang` 随语言切换。
- **坑/注意**：① 客户端 i18n 字符串走 `D.t`，不能在服务端模板里用反引号（同迭代 10 约束）；
  ② 用户个人 categories.json 的自定义分类名不翻译（无法穷举），属预期——公开包内置分类才有英文。
- 验证：默认（zh_CN）报表与迭代 10 完全一致（231h 总 / Claude 217h / Codex 13.9h，中文）；
  `--lang en` / `CCHOUR_LANG=en`：CLI 全英文、HTML 全英文（chip/卡片/分类/footer/项目名）、
  点「Last month」就地重算 range-label=「Range 2026-05-01 ~ 2026-05-31」total=118h；
  中英两版 console 均无错误；6 类错误信息中英各一份；`--json` 语言无关。
- 迭代 9 改动：`--week` / `--month` 周报月报快捷范围
- 迭代 8 改动：`--since` / `--until` 日期过滤
- 迭代 7 改动：① `--json` 输出模式；② 内容级分类改为扫描前 3 条用户消息——杂项 **22% → 18%**

## 报表内时间范围选择器（迭代 10 引入）

- 报表顶部一排 chip：全部/今天/本周/上周/本月/上月/近7天/近30天/近90天 + 自定义两个
  `<input type=date>`（反序自动交换）；切换后总览卡片、日/周/月图、24 小时分布、
  工作分类、Top 20 项目全部在浏览器内就地重算重绘，无需重跑 CLI
- 实现：renderHtml 改为「静态骨架 + 内嵌 JSON + 前端渲染」。buildEmbedData 嵌入
  每工具 daily、每工具 dayHour（天→24 小时数组）、每项目 daily（含 tool/cat）；
  分类条由前端按项目行聚合（口径与 CLI 一致）。嵌入 JSON 仅 ~16KB（秒数取整）
- 语义：前端按「日桶归属」求和（bucketActive 把增量记到后一事件所在天）。
  选「全部」与 CLI 总数**完全一致**；子范围与 CLI --since/--until 在跨午夜会话
  边界处有分钟级差异（验证：上月完全一致，上周差 0.01h）
- CLI 行为不变：--since/--until/--week/--month 仍在采集后过滤事件，此时报表只
  嵌入过滤后的数据（头部提示「数据已按命令行参数截取」），选择器在其内细分；--json 不动
- **坑**：前端脚本嵌在服务端模板字面量里，客户端 JS 不能用反引号和 `${`（会被服务端
  模板吃掉），全部用字符串拼接；嵌入 JSON 的 `<` 转义成 `\u003c` 防 `</script>` 截断
- 日图锚定所选范围末尾、最多 --days 根；周/月图最多 12 格、起点截断到范围；
  小时图由 dayHour 按范围求和；周/月聚合直接由日桶按 weekKey/monthKey 折叠

## --week / --month（迭代 9 引入）

- `--week`（本周：周一~今天）、`--week last`（上一整周）、`--week YYYY-MM-DD`（该日期所在周）；
  `--month` / `--month last` / `--month YYYY-MM` 同理
- 实现：`expandShortcutRange()` 在 parseArgs 末尾把快捷方式展开成 since/until，
  之后走迭代 8 的全套管线（过滤、图表锚点、HTML 头部范围行、--json 字段）零额外改动
- 周一为一周起点（`(getDay()+6)%7`，与周图一致）；until 封顶今天；范围在未来报错
- 互斥：--week/--month 彼此、以及与显式 --since/--until 同用都 exit 1
- 可选值解析：下一个 argv 存在且不以 `-` 开头才当值，否则取 true（不带值的形式）
- 一键周报：`cchour --week last --json`

## --since / --until（迭代 8 引入）

- `--since YYYY-MM-DD` / `--until YYYY-MM-DD`，本地时区，until 含当天整天
- 实现：`collect()` 之后、buildReport 之前对各项目的 ts 数组做范围过滤（空项目删除），
  所以总时长、分类、项目行、各图表全部反映范围
- `parseDayArg()` 校验：构造 Date 后回验 年/月/日 分量——`new Date(2026,12,99)`
  会自动进位不报 NaN，必须拦（迭代 8 踩的坑）；since>until 也报错退出
- 图表锚点：until 在过去时，日/周/月图以 until 为最后一格；日表起点被 since 截断
  （`--days` 仍控制窗口上限，默认 30）
- HTML 头部 sub 行显示「统计范围 X ~ Y」；`--json` 顶层带 `since`/`until`（未设为 null）

## --json 输出（迭代 7 引入）

- `cchour --json` 打 JSON 到 stdout（进度信息全在 stderr，可安全 pipe）；配 `-o` 则写文件
- 结构：`{generatedAt, gapSeconds, totalSeconds, tools: {名: {seconds, hours, daily, weekly, monthly, hourly}}, categories, projects: [{tool, project, seconds, category, firstTs, lastTs}]}`
- parseArgs 加了 `outputSet` 标记区分「默认输出名」和「用户显式 -o」

## 内容级分类（迭代 5 引入，6/7 扩展）

- 分类规则格式 `[["分类名", [项目名关键词], [内容关键词]?], ...]`，第三个数组可选、向后兼容
- 适用目录：SPECIAL_DIRS 四个（home / `~/code` 根 / `/` / private-tmp）+
  iCloud 文档（前缀匹配）、Downloads / Desktop / Documents（精确匹配），
  见 `isMiscClaudeDir()`；Codex 侧按解析出的项目名匹配 `CODEX_MISC_PROJECTS`
- **迭代 7：从仅首条改为前 3 条用户消息**（`CONTENT_MSGS = 3`），函数改名
  `claudeUserTexts()` / `codexUserTexts()`，多条文本以 `\n` 连接后做关键词匹配
- Claude Code：读文件头 256KB（共用 `readHead()`）逐行解析，跳过 isMeta / Caveat / 标签
- Codex：rollout 里 `response_item` payload `role=user` 的 `input_text`（兼容
  `event_msg`/`user_message`，同一条输入两种形式都出现时做相邻去重）；
  **必须整块剔除 `<environment_context>` / `<user_instructions>` / `<turn_context>`**
  ——环境块里含 "codex" 等字样会误命中内容关键词
- 命中后拆成合成项目「code 根目录 · 写作与发布」并覆盖分类，未命中留在杂项
- 验证：迭代 5 杂项 128.1h·48% → 82.0h·29%；迭代 6 → 63.4h·22%；迭代 7 → **51.8h·18%**

## 用法

```bash
npm i -g cchour   # 或 npx cchour
cchour --open     # 生成 ./cchour-report.html 并打开
cchour -o report.html --days 60
cchour --json | jq '.tools["Claude Code"].hours'
```

## 数据源与方法

| 工具 | 数据位置 | 说明 |
|------|----------|------|
| Claude Code | `~/.claude/projects/<flattened-cwd>/*.jsonl` | 时间戳正则流式提取，worktree 归并主项目 |
| Codex | `~/.codex/sessions/` + `~/.codex/archived_sessions/` | 文件头 256KB 正则取 `cwd`（session_meta 首行可能超长，不能按行 JSON.parse——迭代 2 踩过的坑） |

- 活跃时长 = 间隔法：相邻事件 ≤ 900 秒（15 分钟，按需求定义）计入，孤立事件计 30 秒
- 工具总时长按事件并集，避免并行会话重复计；时区用系统本地时区
- 性能：约 800MB 数据 0.8 秒（多消息扫描略增开销，仍在头 256KB 内）
- 注意：buildReport 里 `sec < 60` 的项目会整体跳过（含其事件），拆分杂项后小项目可能被滤掉，对总数影响 < 0.5h

## 个人化与公开包的分离

- 公开包内置通用分类规则（含通用内容关键词）；个人规则在 `~/.cchour/categories.json`
- `report.html` / `cchour-report.html` 在 .gitignore 里，个人数据不进公开仓库

## 验证记录

- 迭代 2（GAP=300s）：Node 版与 Python 版对齐：186.9h / 11.6h
- 迭代 3（GAP=900s）：228.1h / 13.9h
- 迭代 10：无参数 229.65h / 13.94h；报表选「全部」与 CLI 完全一致；
  浏览器点「上月」=133h/11.3h 对照 `--month last`（133.28/11.32）一致；
  「上周」=66.1h 对照 `--week last`（66.14h，差 0.01h 为日桶边界语义）；
  「今天」单日 8.6h；自定义日期反序自动交换；console 无错误；截图核对两种状态全部板块正常
- 迭代 5：228.5h / 13.9h；杂项 48%→29%
- 迭代 6：228.6h / 13.9h；杂项 29%→22%
- 迭代 9：无参数 229.0h / 13.9h（与迭代 8 一致+当日新数据）；
  `--week last` = 06-01~06-07，63.55h/2.59h，与等价 `--since/--until` 完全一致；
  `--month last` = 05-01~05-31，133.3h/11.3h；HTML 头部范围行正确；
  6 种非法/冲突用法（同用、未来月、2026-13 等）全部 exit 1
- 迭代 8：无参数 228.9h / 13.9h（与迭代 7 一致+当日新数据）；
  `--since 2026-06-01 --until 2026-06-10` → 90.4h，日表 10 根柱（06-01..06-10），
  头部显示统计范围；无效日期 / since>until 均 exit 1；截图核对渲染正常
- 迭代 7：228.8h / 13.9h；杂项 22%→18%（51.8h）；`--json` 经 JSON.parse 验证；
  截图核对全部板块正常。
  踩坑提醒：browse 的安全策略只允许 load-html 读 /tmp 或 daemon 启动时的 cwd
  （本次 daemon 还记着旧的 cctime 路径），把 report 复制到 /tmp 再 load 即可；
  旧标签页会残留缓存内容，核对数字前先 load-html 重新加载

## 下次迭代可做

1. **npm publish 1.7.0（唯一卡点）**：用户在项目目录跑 `npm publish --access public --otp=<code>`，
   再 `npx cchour@1.7.0 --version` 验证（1.2.0–1.6.0 从未发布，跳过即可）
2. 剩余杂项 51.8h 已多为真杂项（"继续"、零散问答）；再降收益递减
3. 其他工具（Gemini CLI / Copilot）目前本机无会话日志，等有数据再接
4. 可加 launchd 定时刷新（数据在本地，无 iCloud 限制）；`--json` + `--week` 已为此铺路
5. 可考虑两个范围对比模式（本周 vs 上周涨跌），基于 --week/--month 容易做
6. 杂项之外的下一个洞察方向：每小时热力图按「工作日 vs 周末」拆分
