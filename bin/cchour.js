#!/usr/bin/env node
/*
 * cchour — 统计在各 AI 编程工具（Claude Code / Codex）上的使用时间，输出 HTML 报表。
 *
 * 数据源:
 *   Claude Code: ~/.claude/projects/<flattened-cwd>/*.jsonl  (每行 JSON 带 "timestamp":"...Z")
 *   Codex:       ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl + ~/.codex/archived_sessions/
 *                (session_meta 行带 cwd)
 *
 * 活跃时长算法（间隔法）: 同一组内事件按时间排序，相邻间隔 <= GAP（15 分钟）计入时长，
 * 超过视为离开，不计。每个孤立事件至少计 MIN_EVENT 秒。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const pkg = require('../package.json');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');
const CODEX_DIRS = [
  path.join(HOME, '.codex', 'sessions'),
  path.join(HOME, '.codex', 'archived_sessions'),
];

const GAP = 900; // 相邻事件最大间隔（秒）：15 分钟以内算持续工作
const MIN_EVENT = 30; // 孤立事件的最小计时（秒）
const CHUNK = 4 * 1024 * 1024;

// ---- i18n ----------------------------------------------------------------
// 语言只影响展示层（CLI 文案 + HTML 报表）。数据层的项目/分类规范名保持中文，
// --json 输出稳定不随语言变；HTML 里用下面的映射在展示时翻译。
const { execFileSync } = require('child_process');

function resolveLang(s) {
  return s && /^zh/i.test(String(s).trim()) ? 'zh' : 'en';
}

// 检测显示语言：--lang > CCHOUR_LANG > LC_ALL/LC_MESSAGES/LANG > macOS AppleLocale > en
function detectLang(argv) {
  const idx = argv.indexOf('--lang');
  if (idx >= 0 && argv[idx + 1]) return resolveLang(argv[idx + 1]);
  if (process.env.CCHOUR_LANG) return resolveLang(process.env.CCHOUR_LANG);
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
  if (env && env !== 'C' && env !== 'POSIX') return resolveLang(env);
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('defaults', ['read', '-g', 'AppleLocale'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (out) return resolveLang(out);
    } catch { /* 读不到就走默认 */ }
  }
  return 'en';
}

// 内置分类名 / 特殊目录派生名的中→英映射（仅 en 展示时使用，匹配逻辑仍按中文规范名）
const CAT_I18N = {
  '写作与发布': 'Writing & Publishing',
  '视频制作': 'Video Production',
  '网站维护': 'Website Maintenance',
  '技能与工具链': 'Skills & Tooling',
  '杂项（根目录会话）': 'Misc (root sessions)',
  '基础设施': 'Infrastructure',
  '其他': 'Other',
};
const BASE_I18N = {
  'code 根目录（杂项）': 'code root (misc)',
  'home 目录（杂项）': 'home (misc)',
  '根目录（杂项）': 'root (misc)',
  '临时目录': 'temp dir',
  'iCloud 文档': 'iCloud Docs',
  'code 根目录': 'code root',
  'home 目录': 'home',
  '根目录': 'root',
};

function localizeCat(cat, lang) {
  return lang === 'zh' ? cat : (CAT_I18N[cat] || cat);
}

// 项目名：合成名形如「<base> · <分类>」，按 ` · ` 拆开分别翻；真实项目名（多为英文）原样保留
function localizeProj(proj, lang) {
  if (lang === 'zh') return proj;
  const sep = ' · ';
  const i = proj.indexOf(sep);
  if (i >= 0) {
    const base = proj.slice(0, i);
    const cat = proj.slice(i + sep.length);
    return (BASE_I18N[base] || base) + sep + (CAT_I18N[cat] || cat);
  }
  return BASE_I18N[proj] || proj;
}

const T = {
  zh: {
    htmlLang: 'zh-CN',
    title: 'AI 编程工具时间报表',
    genAt: '生成于',
    subTail: '数据来自本机 Claude Code 与 Codex 会话记录 · 活跃时长 = 相邻操作间隔 ≤ 15 分钟的累计',
    clip: (s, u) => ` · 数据已按命令行参数截取 ${s} ~ ${u}`,
    clipEarliest: '最早',
    clipToday: '今天',
    chips: { all: '全部', today: '今天', week: '本周', lastweek: '上周', month: '本月', lastmonth: '上月', d7: '近 7 天', d30: '近 30 天', d90: '近 90 天' },
    custom: '自定义',
    hHourly: '一天中的时间分布（24 小时）',
    hCats: '工作分类',
    hProjects: '项目时长 Top 20',
    footer: 'cchour · 全部数据在本机统计，未上传任何服务 · 时间范围切换在浏览器内完成',
    // 注入前端的字符串
    t: {
      hour: '小时', minute: '分钟',
      total: '总活跃时长', days: '天', share: '占比', dailyAvg: '日均',
      rangePrefix: '统计范围', rangeAll: '全部数据', earliest: '最早', today: '今天',
      dailyHead: ['最近 ', ' 天每日使用'],
      weeklyHead: ['最近 ', ' 周每周使用（以周一为起点）'],
      monthlyHead: ['最近 ', ' 个月每月使用'],
      noData: '该时间段没有数据', last: '最近',
    },
    // CLI
    scanning: '扫描数据源…',
    projEvents: (tool, p, n) => `  ${tool}: ${p} 个项目, ${n} 个事件`,
    toolHours: (t, h) => `  ${t}: ${h} 小时`,
    generated: (p, s) => `已生成 ${p}（耗时 ${s} 秒）`,
    elapsed: (s) => `耗时 ${s} 秒`,
    errDate: (name, s) => `${name} 需要 YYYY-MM-DD 格式的日期，收到: ${s}`,
    errWeekMonth: '--week 与 --month 不能同时使用',
    errRangeConflict: (f) => `--${f} 不能与 --since/--until 同时使用`,
    errMonthFmt: (m) => `--month 需要 last 或 YYYY-MM 格式，收到: ${m}`,
    errFuture: (f) => `--${f} 指定的范围在未来，没有数据`,
    errSinceUntil: '--since 不能晚于 --until',
    errNoOutput: '缺少 --output 的值',
    errUnknown: (a) => `未知参数: ${a}\n`,
    help: `cchour v${pkg.version} — AI 编程工具时间报表 (Claude Code / Codex)

用法: cchour [选项]

选项:
  -o, --output <文件>   输出 HTML 路径（默认 ./cchour-report.html）
      --days <N>        每日图表显示最近 N 天（默认 30）
      --since <日期>    只统计该日期（含）之后的活动，格式 YYYY-MM-DD
      --until <日期>    只统计该日期（含当天整天）之前的活动，格式 YYYY-MM-DD
      --week [W]        周报快捷范围：不带值=本周（周一起到今天）；last=上一整周；
                        YYYY-MM-DD=该日期所在的周（周一 ~ 周日，不超过今天）
      --month [M]       月报快捷范围：不带值=本月；last=上个整月；YYYY-MM=指定月
      --lang <zh|en>    界面语言（默认跟随系统区域设置；也可用 CCHOUR_LANG 环境变量）
      --open            生成后用系统默认浏览器打开
      --json            输出 JSON 而非 HTML（默认打到 stdout，配 -o 则写文件）
  -h, --help            显示帮助
  -v, --version         显示版本

分类规则可用 ~/.cchour/categories.json 自定义，格式:
  [["分类名", ["项目名关键词", ...], ["内容关键词", ...]?], ...]
按顺序对项目名做小写包含匹配，未命中归入「其他」。
可选的第三个数组用于杂项目录（home / code 根目录等）会话的内容级分类:
匹配会话首条用户消息，命中则把该会话挪进对应分类。`,
  },
  en: {
    htmlLang: 'en',
    title: 'AI Coding Tool Time Report',
    genAt: 'Generated',
    subTail: 'Data from local Claude Code & Codex session logs · Active time = sum of gaps ≤ 15 min between consecutive actions',
    clip: (s, u) => ` · clipped by CLI args to ${s} ~ ${u}`,
    clipEarliest: 'earliest',
    clipToday: 'today',
    chips: { all: 'All', today: 'Today', week: 'This week', lastweek: 'Last week', month: 'This month', lastmonth: 'Last month', d7: 'Last 7 days', d30: 'Last 30 days', d90: 'Last 90 days' },
    custom: 'Custom',
    hHourly: 'Time of day (24 hours)',
    hCats: 'Work categories',
    hProjects: 'Top 20 projects by time',
    footer: 'cchour · All stats computed locally, nothing uploaded · Range switching happens in your browser',
    t: {
      hour: 'h', minute: 'min',
      total: 'Total active time', days: 'days', share: 'share', dailyAvg: 'daily avg',
      rangePrefix: 'Range', rangeAll: 'all data', earliest: 'earliest', today: 'today',
      dailyHead: ['Last ', ' days — daily usage'],
      weeklyHead: ['Last ', ' weeks — weekly usage (weeks start Monday)'],
      monthlyHead: ['Last ', ' months — monthly usage'],
      noData: 'No data in this range', last: 'last',
    },
    scanning: 'Scanning data sources…',
    projEvents: (tool, p, n) => `  ${tool}: ${p} projects, ${n} events`,
    toolHours: (t, h) => `  ${t}: ${h} h`,
    generated: (p, s) => `Generated ${p} (${s}s)`,
    elapsed: (s) => `Done in ${s}s`,
    errDate: (name, s) => `${name} expects a YYYY-MM-DD date, got: ${s}`,
    errWeekMonth: '--week and --month cannot be used together',
    errRangeConflict: (f) => `--${f} cannot be combined with --since/--until`,
    errMonthFmt: (m) => `--month expects last or YYYY-MM, got: ${m}`,
    errFuture: (f) => `--${f} range is in the future, no data`,
    errSinceUntil: '--since cannot be later than --until',
    errNoOutput: 'missing value for --output',
    errUnknown: (a) => `unknown argument: ${a}\n`,
    help: `cchour v${pkg.version} — AI coding tool time report (Claude Code / Codex)

Usage: cchour [options]

Options:
  -o, --output <file>   output HTML path (default ./cchour-report.html)
      --days <N>        show the last N days in the daily chart (default 30)
      --since <date>    only count activity on/after this date, format YYYY-MM-DD
      --until <date>    only count activity on/before this date (whole day), YYYY-MM-DD
      --week [W]        weekly range: no value = this week (Mon..today); last = last full week;
                        YYYY-MM-DD = the week containing that date (Mon..Sun, capped at today)
      --month [M]       monthly range: no value = this month; last = last full month; YYYY-MM = that month
      --lang <zh|en>    UI language (defaults to system locale; or set CCHOUR_LANG env var)
      --open            open the report in your default browser after generating
      --json            output JSON instead of HTML (to stdout by default, or to a file with -o)
  -h, --help            show this help
  -v, --version         show version

Categories can be customized via ~/.cchour/categories.json, format:
  [["Category", ["project-name keyword", ...], ["content keyword", ...]?], ...]
Project names are matched (lowercase substring) in order; unmatched go to "Other".
The optional third array does content-level classification for misc directories
(home / code root, etc.): it matches the first user messages of a session and,
on a hit, moves that session into the matching category.`,
  },
};

// 当前界面语言文案（在 main 里按检测结果设定，CLI 单次运行用模块级变量即可）
let L = T.en;

// Claude Code 把会话 cwd 里的 / 和 . 都替换成 - 作为目录名
const FH = HOME.replace(/[/.]/g, '-');

const TS_RE = /"timestamp"\s*:\s*"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/g;

function scanTimestamps(file, out) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return;
  }
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let tail = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      const s = tail + buf.toString('latin1', 0, n);
      TS_RE.lastIndex = 0;
      let m;
      while ((m = TS_RE.exec(s)) !== null) {
        out.push(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000);
      }
      tail = s.slice(-64);
    }
  } finally {
    fs.closeSync(fd);
  }
}

const SPECIAL_DIRS = {
  [`${FH}-code`]: 'code 根目录（杂项）',
  [FH]: 'home 目录（杂项）',
  '-': '根目录（杂项）',
  '-private-tmp': '临时目录',
};

// 这些目录下的会话不属于具体项目，按会话首条用户消息做内容级分类
function isMiscClaudeDir(dirname) {
  if (SPECIAL_DIRS[dirname]) return true;
  if (dirname.startsWith(`${FH}-Library-Mobile-Documents`)) return true; // iCloud 文档
  return [`${FH}-Downloads`, `${FH}-Desktop`, `${FH}-Documents`].includes(dirname);
}

const CODEX_MISC_PROJECTS = new Set([
  'home 目录（杂项）', 'code 根目录（杂项）', 'Downloads', 'Desktop', 'Documents',
]);

function claudeProjectName(dirname) {
  if (SPECIAL_DIRS[dirname]) return SPECIAL_DIRS[dirname];
  if (dirname.startsWith(`${FH}-Library-Mobile-Documents`)) return 'iCloud 文档';
  let p = dirname;
  const prefixes = [
    `${FH}-code-products-`,
    `${FH}-code-`,
    `${FH}--claude-`,
    `${FH}--`,
    `${FH}-`,
    '-private-tmp-',
    '-private-',
    '-',
  ];
  for (const prefix of prefixes) {
    if (p.startsWith(prefix)) {
      p = p.slice(prefix.length);
      break;
    }
  }
  // worktree 归并到主项目
  p = p.replace(/--claude-worktrees.*$/, '');
  return p || 'home';
}

// 读文件头 256KB（session 元信息和首条用户消息都在这里）
function readHead(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  }
}

function codexProjectName(head) {
  // session_meta 在首行但可能超长，直接在文件头里正则取第一个 cwd
  const m = head.match(/"cwd"\s*:\s*"([^"]+)"/);
  if (!m) return 'unknown';
  const cwd = m[1].replace(/\/+$/, '');
  if (cwd === HOME) return 'home 目录（杂项）';
  const codeRoot = path.join(HOME, 'code');
  if (cwd === codeRoot) return 'code 根目录（杂项）';
  if (cwd.startsWith(codeRoot + '/')) {
    const rel = cwd.slice(codeRoot.length + 1).split('/');
    // ~/code/products/foo 取 foo，其余取第一段
    if (rel[0] === 'products' && rel.length > 1) return rel[1];
    return rel[0];
  }
  return path.basename(cwd) || 'home';
}

// 默认分类规则；可用 ~/.cchour/categories.json 覆盖，
// 格式: [["分类名", ["项目名关键词", ...], ["内容关键词", ...]?], ...]
// 第二个数组按顺序匹配项目名（小写包含）；可选的第三个数组用于杂项目录会话的
// 内容级分类——匹配会话首条用户消息，命中则把该会话从「杂项」挪进对应分类。
const DEFAULT_CATEGORIES = [
  ['写作与发布',
    ['wechat', 'publish', 'hugo', 'blog', 'article', 'tweet', 'newsletter', 'syndicat'],
    ['公众号', '文章', '博客', '润色', '推文', 'tweet', 'blog', 'newsletter']],
  ['视频制作',
    ['video', 'multicam', 'dub', 'subtitle', 'overlay', 'transcrib', 'podcast', 'youtube', 'audio'],
    ['视频', '字幕', '配音', '剪辑', '转写', 'srt', 'video', 'youtube', '音频']],
  ['网站维护',
    ['website', 'site'],
    ['网站', 'website', 'seo', '域名']],
  ['技能与工具链',
    ['skill', 'claude-code', 'claude-logs', 'memory', 'agents', '.claude', 'tmp', 'tool'],
    ['skill', 'mcp', 'plugin', '插件', '记忆', 'claude code', 'codex']],
  ['杂项（根目录会话）', ['杂项', 'downloads', 'desktop', 'documents', 'icloud', '临时']],
  ['基础设施',
    ['infra', 'dns', 'cloudflare', 'server', 'backup', 'deploy'],
    ['cloudflare', 'dns', '服务器', '部署', 'deploy', '备份', 'backup', '代理', 'proxy', '网盘', 'launchd']],
];

function loadCategories() {
  const p = path.join(HOME, '.cchour', 'categories.json');
  try {
    const rules = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(rules) && rules.length) return rules;
  } catch {
    /* 无配置文件时用默认规则 */
  }
  return DEFAULT_CATEGORIES;
}

function makeCategorize(rules) {
  return (project) => {
    const p = project.toLowerCase();
    for (const [cat, keys] of rules) {
      for (const k of keys) {
        if (p.includes(k)) return cat;
      }
    }
    return '其他';
  };
}

// 内容级分类：只用带第三个数组（内容关键词）的规则，未命中返回 null（留在杂项）
function makeContentCategorize(rules) {
  const contentRules = rules.filter((r) => Array.isArray(r[2]) && r[2].length);
  return (text) => {
    if (!text) return null;
    const p = text.toLowerCase();
    for (const [cat, , keys] of contentRules) {
      for (const k of keys) {
        if (p.includes(k.toLowerCase())) return cat;
      }
    }
    return null;
  };
}

// 取 Claude Code 会话前几条真实用户消息的文本（头 256KB 内逐行解析）。
// 只看首条容易漏：不少会话第一句是"继续"、"看看这个"之类，主题在第 2-3 条才出现。
const CONTENT_MSGS = 3;

function claudeUserTexts(head) {
  const texts = [];
  for (const line of head.split('\n')) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type !== 'user' || !j.message || j.isMeta) continue;
    const c = j.message.content;
    let t = typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ')
        : '';
    t = t.replace(/<[^>]*>/g, ' ').trim();
    if (!t || t.startsWith('Caveat:')) continue;
    texts.push(t.slice(0, 2000));
    if (texts.length >= CONTENT_MSGS) break;
  }
  return texts.join('\n');
}

// 取 Codex 会话前几条真实用户输入（rollout 格式：response_item payload 里
// role=user 的 input_text）。首条往往是 <environment_context> 环境信息，
// 文本里含 "codex" 等字样会误命中内容关键词，需整块剔除后再判断。
function codexUserTexts(head) {
  const texts = [];
  for (const line of head.split('\n')) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const p = j && j.payload;
    if (!p) continue;
    let t = '';
    if (j.type === 'response_item' && p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
      t = p.content.filter((x) => x && x.type === 'input_text').map((x) => x.text).join(' ');
    } else if (j.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
      t = p.message;
    } else {
      continue;
    }
    t = t
      .replace(/<(environment_context|user_instructions|turn_context)>[\s\S]*?<\/\1>/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .trim();
    if (!t) continue;
    t = t.slice(0, 2000);
    // 同一条输入可能以 response_item 和 event_msg 两种形式各出现一次，去重
    if (texts[texts.length - 1] !== t) texts.push(t);
    if (texts.length >= CONTENT_MSGS) break;
  }
  return texts.join('\n');
}

function uniqSorted(ts) {
  const set = new Set();
  for (const t of ts) set.add(Math.floor(t));
  return Array.from(set).sort((a, b) => a - b);
}

function activeSeconds(ts) {
  if (!ts.length) return 0;
  const u = uniqSorted(ts);
  let total = 0;
  let prev = null;
  for (const t of u) {
    if (prev !== null && t - prev <= GAP) total += t - prev;
    else total += MIN_EVENT;
    prev = t;
  }
  return total;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dayKey(t) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 周以周一为起点，key 为周一的日期字符串
function weekKey(t) {
  const d = new Date(t * 1000);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return `${monday.getFullYear()}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`;
}

function monthKey(t) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function bucketActive(ts, keyFn) {
  const out = new Map();
  const u = uniqSorted(ts);
  let prev = null;
  for (const t of u) {
    const k = keyFn(t);
    const inc = prev !== null && t - prev <= GAP ? t - prev : MIN_EVENT;
    out.set(k, (out.get(k) || 0) + inc);
    prev = t;
  }
  return out;
}

const dailyActive = (ts) => bucketActive(ts, dayKey);
const weeklyActive = (ts) => bucketActive(ts, weekKey);
const monthlyActive = (ts) => bucketActive(ts, monthKey);
const hourlyActive = (ts) => bucketActive(ts, (t) => new Date(t * 1000).getHours());

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function walkJsonl(dir, cb) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(full, cb);
    else if (e.isFile() && e.name.endsWith('.jsonl')) cb(full);
  }
}

function collect(contentCategorize) {
  // tool -> Map(project -> [timestamps])
  const data = new Map();
  // 杂项会话经内容级分类拆出的合成项目名 -> 分类（覆盖按项目名的分类）
  const catOverride = new Map();
  const bucket = (tool, proj) => {
    if (!data.has(tool)) data.set(tool, new Map());
    const m = data.get(tool);
    if (!m.has(proj)) m.set(proj, []);
    return m.get(proj);
  };

  if (isDir(CLAUDE_DIR)) {
    for (const d of fs.readdirSync(CLAUDE_DIR).sort()) {
      const full = path.join(CLAUDE_DIR, d);
      if (!isDir(full)) continue;
      const proj = claudeProjectName(d);
      const isMisc = isMiscClaudeDir(d);
      for (const fn of fs.readdirSync(full)) {
        if (!fn.endsWith('.jsonl')) continue;
        const file = path.join(full, fn);
        let p = proj;
        if (isMisc) {
          const cat = contentCategorize(claudeUserTexts(readHead(file)));
          if (cat) {
            p = `${proj.replace('（杂项）', '')} · ${cat}`;
            catOverride.set(p, cat);
          }
        }
        scanTimestamps(file, bucket('Claude Code', p));
      }
    }
  }

  for (const rootDir of CODEX_DIRS) {
    walkJsonl(rootDir, (file) => {
      const head = readHead(file);
      const proj = codexProjectName(head);
      let p = proj;
      if (CODEX_MISC_PROJECTS.has(proj)) {
        const cat = contentCategorize(codexUserTexts(head));
        if (cat) {
          p = `${proj.replace('（杂项）', '')} · ${cat}`;
          catOverride.set(p, cat);
        }
      }
      scanTimestamps(file, bucket('Codex', p));
    });
  }

  return { data, catOverride };
}

function buildReport(data, categorize, catOverride, ndays, range = {}) {
  const toolSeconds = new Map();
  const toolDaily = new Map();
  const toolWeekly = new Map();
  const toolMonthly = new Map();
  const toolHourly = new Map();
  const toolDayHour = new Map(); // tool -> Map("YYYY-MM-DD|H" -> sec)，供报表内按范围重算 24 小时分布
  const projRows = []; // {tool, proj, sec, cat, first, last, daily}
  const catSeconds = new Map();

  for (const [tool, projects] of data) {
    const allTs = [];
    for (const [proj, ts] of projects) {
      if (!ts.length) continue;
      const sec = activeSeconds(ts);
      if (sec < 60) continue;
      const cat = catOverride.get(proj) || categorize(proj);
      catSeconds.set(cat, (catSeconds.get(cat) || 0) + sec);
      let first = Infinity;
      let last = -Infinity;
      for (const t of ts) {
        if (t < first) first = t;
        if (t > last) last = t;
      }
      projRows.push({ tool, proj, sec, cat, first, last, daily: dailyActive(ts) });
      for (const t of ts) allTs.push(t);
    }
    toolSeconds.set(tool, activeSeconds(allTs));
    toolDaily.set(tool, dailyActive(allTs));
    toolWeekly.set(tool, weeklyActive(allTs));
    toolMonthly.set(tool, monthlyActive(allTs));
    toolHourly.set(tool, hourlyActive(allTs));
    toolDayHour.set(tool, bucketActive(allTs, (t) => `${dayKey(t)}|${new Date(t * 1000).getHours()}`));
  }

  projRows.sort((a, b) => b.sec - a.sec);

  return {
    toolSeconds, toolDaily, toolWeekly, toolMonthly, toolHourly, toolDayHour,
    projRows, catSeconds, daysOpt: ndays,
    range: {
      since: range.since ? dayKey(range.since.getTime() / 1000) : null,
      until: range.until ? dayKey(range.until.getTime() / 1000) : null,
    },
  };
}

// 报表内嵌数据：每工具按日 / 按日×小时，每项目按日（工作分类由前端按项目行聚合得出），
// 页面里切换时间范围时就地重算所有数字。秒数取整以减小体积。
// 语义：按「日桶归属」求和（增量记到后一事件所在天），选「全部」与 CLI 总数完全一致，
// 子范围与 CLI --since/--until 仅在跨午夜的会话边界处有分钟级差异。
function buildEmbedData({ toolSeconds, toolDaily, toolDayHour, projRows, range, daysOpt }, lang) {
  const round = (m) => {
    const o = {};
    for (const [k, v] of Array.from(m.entries()).sort()) o[k] = Math.round(v);
    return o;
  };
  const tools = {};
  let minDay = null;
  for (const t of Array.from(toolSeconds.keys()).sort((a, b) => toolSeconds.get(b) - toolSeconds.get(a))) {
    const daily = round(toolDaily.get(t));
    for (const k in daily) if (!minDay || k < minDay) minDay = k;
    const dayHour = {};
    for (const [k, v] of toolDayHour.get(t)) {
      const [d, h] = k.split('|');
      if (!dayHour[d]) dayHour[d] = new Array(24).fill(0);
      dayHour[d][+h] += Math.round(v);
    }
    tools[t] = { daily, dayHour };
  }
  const now = new Date();
  const genDay = dayKey(now.getTime() / 1000);
  return {
    genDay,
    genTime: `${genDay} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    minDay: minDay || genDay,
    daysOpt,
    range,
    tools,
    t: T[lang].t,
    projects: projRows.map((r) => ({
      tool: r.tool,
      proj: localizeProj(r.proj, lang),
      cat: localizeCat(r.cat, lang),
      daily: round(r.daily),
    })),
  };
}

function renderHtml(report, lang) {
  const embed = buildEmbedData(report, lang);
  // </script> 防注入：JSON 里的 < 转义后再嵌入
  const json = JSON.stringify(embed).replace(/</g, '\\u003c');
  const r = report.range;
  const clipNote = r && (r.since || r.until)
    ? L.clip(r.since || L.clipEarliest, r.until || L.clipToday)
    : '';

  return `<!DOCTYPE html>
<html lang="${L.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${L.title}</title>
<style>
  :root { --ink:#2c2c2c; --muted:#8a8a8a; --line:#ececec; --bg:#fafaf8; --card:#ffffff; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,"PingFang SC","Hiragino Sans GB",sans-serif;
          background:var(--bg); color:var(--ink); padding:40px 24px 80px; }
  .wrap { max-width:980px; margin:0 auto; }
  h1 { font-size:26px; font-weight:700; letter-spacing:.5px; }
  .sub { color:var(--muted); font-size:13px; margin-top:6px; }
  h2 { font-size:16px; font-weight:600; margin:36px 0 14px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:14px; margin-top:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; }
  .card-label { font-size:13px; color:var(--muted); display:flex; align-items:center; gap:6px; }
  .card-value { font-size:32px; font-weight:700; margin-top:6px; }
  .card-value .unit { font-size:14px; font-weight:400; color:var(--muted); margin-left:4px; }
  .card-sub { font-size:12px; color:var(--muted); margin-top:4px; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; }
  .chart { display:flex; align-items:flex-end; gap:3px; height:190px; }
  .bar { flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; min-width:0; }
  .bar-stack { width:100%; display:flex; flex-direction:column-reverse; border-radius:3px 3px 0 0; overflow:hidden; }
  .bar:hover .bar-stack { opacity:.75; }
  .bar-x { font-size:9px; color:var(--muted); margin-top:5px; white-space:nowrap;
            transform:rotate(-45deg); transform-origin:top center; height:26px; }
  .hourchart .bar-x { transform:none; height:auto; }
  .legend { display:flex; gap:16px; margin-top:6px; font-size:12px; color:var(--muted); }
  .lg { display:flex; align-items:center; gap:5px; }
  .hrow { display:flex; align-items:center; gap:12px; padding:7px 0; border-bottom:1px solid var(--line); }
  .hrow:last-child { border-bottom:none; }
  .hname { width:200px; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
            display:flex; align-items:center; gap:6px; flex-shrink:0; }
  .htrack { flex:1; height:14px; background:#f3f3f0; border-radius:7px; overflow:hidden; }
  .hfill { height:100%; border-radius:7px; }
  .hval { width:230px; font-size:12px; text-align:right; flex-shrink:0; }
  .muted { color:var(--muted); }
  .controls { margin-top:18px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .chip { border:1px solid var(--line); background:var(--card); border-radius:16px; padding:5px 13px;
          font-size:13px; color:var(--ink); cursor:pointer; font-family:inherit; }
  .chip:hover { border-color:#c5c5c0; }
  .chip.active { background:var(--ink); color:#fff; border-color:var(--ink); }
  .custom { font-size:13px; color:var(--muted); display:flex; align-items:center; gap:6px; margin-left:6px; }
  .custom input { border:1px solid var(--line); border-radius:8px; padding:4px 8px; font-size:13px;
                  color:var(--ink); background:var(--card); font-family:inherit; }
  footer { margin-top:48px; font-size:12px; color:var(--muted); text-align:center; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${L.title}</h1>
  <div class="sub">${L.genAt} ${embed.genTime} · <span id="range-label"></span>${clipNote} · ${L.subTail}</div>

  <div class="controls">
    <button class="chip" data-preset="all">${L.chips.all}</button>
    <button class="chip" data-preset="today">${L.chips.today}</button>
    <button class="chip" data-preset="week">${L.chips.week}</button>
    <button class="chip" data-preset="lastweek">${L.chips.lastweek}</button>
    <button class="chip" data-preset="month">${L.chips.month}</button>
    <button class="chip" data-preset="lastmonth">${L.chips.lastmonth}</button>
    <button class="chip" data-preset="d7">${L.chips.d7}</button>
    <button class="chip" data-preset="d30">${L.chips.d30}</button>
    <button class="chip" data-preset="d90">${L.chips.d90}</button>
    <span class="custom">${L.custom} <input type="date" id="d-since"> ~ <input type="date" id="d-until"></span>
  </div>

  <div class="cards" id="cards"></div>

  <h2 id="h-daily"></h2>
  <div class="panel">
    <div class="chart" id="chart-daily"></div>
    <div class="legend" id="legend-daily"></div>
  </div>

  <h2 id="h-weekly"></h2>
  <div class="panel">
    <div class="chart" id="chart-weekly" style="height:180px"></div>
    <div class="legend" id="legend-weekly"></div>
  </div>

  <h2 id="h-monthly"></h2>
  <div class="panel">
    <div class="chart" id="chart-monthly" style="height:180px"></div>
    <div class="legend" id="legend-monthly"></div>
  </div>

  <h2>${L.hHourly}</h2>
  <div class="panel hourchart">
    <div class="chart" id="chart-hourly" style="height:150px"></div>
    <div class="legend" id="legend-hourly"></div>
  </div>

  <h2>${L.hCats}</h2>
  <div class="panel" id="cats"></div>

  <h2>${L.hProjects}</h2>
  <div class="panel" id="projects"></div>

  <footer>${L.footer}</footer>
</div>

<script type="application/json" id="cchour-data">${json}</script>
<script>
'use strict';
/* 范围切换全部在前端完成：按「日桶归属」对内嵌的按日数据求和。 */
var D = JSON.parse(document.getElementById('cchour-data').textContent);
var TOOL_COLORS = { 'Claude Code': '#D97757', 'Codex': '#4A7DBE' };
var CAT_COLORS = ['#D97757', '#4A7DBE', '#5BA88B', '#C9A227', '#9B7BB8', '#D86F8C', '#8A9BA8'];
var TOOLS = Object.keys(D.tools);

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function hrs(sec) { var h = sec / 3600; return h >= 100 ? h.toFixed(0) : h.toFixed(1); }
function fmtH(sec) { var h = sec / 3600; return h >= 1 ? h.toFixed(1) + ' ' + D.t.hour : Math.round(sec / 60) + ' ' + D.t.minute; }
function color(t) { return TOOL_COLORS[t] || '#888'; }
function dayStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function parseDay(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function mondayOf(d) { return addDays(d, -((d.getDay() + 6) % 7)); }
function inR(k, lo, hi) { return (!lo || k >= lo) && (!hi || k <= hi); }
function sumRange(daily, lo, hi) { var s = 0; for (var k in daily) if (inR(k, lo, hi)) s += daily[k]; return s; }

var cur = { since: null, until: null };

function stackedBars(keys, tools, valFn, labelFn, height) {
  var max = 1, totals = [], i, t, v;
  for (i = 0; i < keys.length; i++) {
    v = 0;
    for (t = 0; t < tools.length; t++) v += valFn(tools[t], keys[i]);
    totals.push(v);
    if (v > max) max = v;
  }
  var html = '';
  for (i = 0; i < keys.length; i++) {
    var segs = '';
    for (t = 0; t < tools.length; t++) {
      v = valFn(tools[t], keys[i]);
      var h = (v / max) * height;
      if (h > 0.5) segs += '<div class="seg" style="height:' + h.toFixed(1) + 'px;background:' + color(tools[t]) + '"></div>';
    }
    html += '<div class="bar" title="' + keys[i] + ' · ' + (totals[i] / 3600).toFixed(1) + 'h">' +
      '<div class="bar-stack">' + segs + '</div><div class="bar-x">' + labelFn(keys[i]) + '</div></div>';
  }
  return html;
}

function render() {
  var lo = cur.since, hi = cur.until, i;
  var toolSec = {}, total = 0;
  TOOLS.forEach(function (t) { toolSec[t] = sumRange(D.tools[t].daily, lo, hi); total += toolSec[t]; });
  var tools = TOOLS.slice().sort(function (a, b) { return toolSec[b] - toolSec[a]; });

  var start = lo && lo > D.minDay ? lo : D.minDay;
  var end = hi && hi < D.genDay ? hi : D.genDay;
  if (end < start) end = start;
  var spanDays = Math.max(1, Math.round((parseDay(end) - parseDay(start)) / 86400000) + 1);

  document.getElementById('range-label').textContent =
    (lo || hi) ? D.t.rangePrefix + ' ' + (lo || D.t.earliest) + ' ~ ' + (hi || D.t.today) : D.t.rangePrefix + ' ' + D.t.rangeAll;

  // 总览卡片
  var cards = '<div class="card"><div class="card-label">' + D.t.total + '</div>' +
    '<div class="card-value">' + hrs(total) + '<span class="unit">' + D.t.hour + '</span></div>' +
    '<div class="card-sub">' + start + ' ~ ' + end + ' · ' + spanDays + ' ' + D.t.days + '</div></div>';
  tools.forEach(function (t) {
    var pct = total ? (toolSec[t] / total) * 100 : 0;
    cards += '<div class="card"><div class="card-label"><span class="dot" style="background:' + color(t) + '"></span>' + t + '</div>' +
      '<div class="card-value">' + hrs(toolSec[t]) + '<span class="unit">' + D.t.hour + '</span></div>' +
      '<div class="card-sub">' + D.t.share + ' ' + pct.toFixed(0) + '% · ' + D.t.dailyAvg + ' ' + (toolSec[t] / 3600 / spanDays).toFixed(1) + ' ' + D.t.hour + '</div></div>';
  });
  document.getElementById('cards').innerHTML = cards;

  var legend = tools.map(function (t) {
    return '<span class="lg"><span class="dot" style="background:' + color(t) + '"></span>' + t + '</span>';
  }).join('');
  ['legend-daily', 'legend-weekly', 'legend-monthly', 'legend-hourly'].forEach(function (id) {
    document.getElementById(id).innerHTML = legend;
  });

  // 每日图：锚定范围末尾，最多 daysOpt 根
  var endD = parseDay(end);
  var days = [];
  for (i = D.daysOpt - 1; i >= 0; i--) {
    var ds = dayStr(addDays(endD, -i));
    if (ds < start) continue;
    days.push(ds);
  }
  document.getElementById('h-daily').textContent = D.t.dailyHead[0] + days.length + D.t.dailyHead[1];
  document.getElementById('chart-daily').innerHTML = stackedBars(days, tools, function (t, k) {
    return D.tools[t].daily[k] || 0;
  }, function (k) { return k.slice(5).replace('-', '/'); }, 160);

  // 周 / 月聚合（只含范围内的天）
  var wkByTool = {}, moByTool = {};
  tools.forEach(function (t) {
    var w = {}, m = {}, daily = D.tools[t].daily, k;
    for (k in daily) {
      if (!inR(k, lo, hi)) continue;
      var wk = dayStr(mondayOf(parseDay(k)));
      w[wk] = (w[wk] || 0) + daily[k];
      var mk = k.slice(0, 7);
      m[mk] = (m[mk] || 0) + daily[k];
    }
    wkByTool[t] = w;
    moByTool[t] = m;
  });
  var weeks = [], endWeek = mondayOf(endD), startWeek = dayStr(mondayOf(parseDay(start)));
  for (i = 11; i >= 0; i--) {
    var wkk = dayStr(addDays(endWeek, -7 * i));
    if (wkk < startWeek) continue;
    weeks.push(wkk);
  }
  document.getElementById('h-weekly').textContent = D.t.weeklyHead[0] + weeks.length + D.t.weeklyHead[1];
  document.getElementById('chart-weekly').innerHTML = stackedBars(weeks, tools, function (t, k) {
    return wkByTool[t][k] || 0;
  }, function (k) { return k.slice(5).replace('-', '/'); }, 150);

  var months = [], startMonth = start.slice(0, 7);
  for (i = 11; i >= 0; i--) {
    var md = new Date(endD.getFullYear(), endD.getMonth() - i, 1);
    var mk2 = md.getFullYear() + '-' + pad2(md.getMonth() + 1);
    if (mk2 < startMonth) continue;
    months.push(mk2);
  }
  document.getElementById('h-monthly').textContent = D.t.monthlyHead[0] + months.length + D.t.monthlyHead[1];
  document.getElementById('chart-monthly').innerHTML = stackedBars(months, tools, function (t, k) {
    return moByTool[t][k] || 0;
  }, function (k) { return k.slice(2).replace('-', '/'); }, 150);

  // 24 小时分布
  var hourByTool = {};
  tools.forEach(function (t) {
    var arr = [], j;
    for (j = 0; j < 24; j++) arr.push(0);
    var dh = D.tools[t].dayHour, k;
    for (k in dh) {
      if (!inR(k, lo, hi)) continue;
      for (j = 0; j < 24; j++) arr[j] += dh[k][j];
    }
    hourByTool[t] = arr;
  });
  var hourKeys = [];
  for (i = 0; i < 24; i++) hourKeys.push(i);
  document.getElementById('chart-hourly').innerHTML = stackedBars(hourKeys, tools, function (t, h) {
    return hourByTool[t][h];
  }, function (h) { return String(h); }, 120);

  // 工作分类（由项目行聚合，口径与 CLI 一致：分类只含具体项目，不含工具并集差额）
  var catSec = {};
  D.projects.forEach(function (p) {
    var s = sumRange(p.daily, lo, hi);
    if (s > 0) catSec[p.cat] = (catSec[p.cat] || 0) + s;
  });
  var cats = Object.keys(catSec).sort(function (a, b) { return catSec[b] - catSec[a]; });
  var catTotal = cats.reduce(function (a, c) { return a + catSec[c]; }, 0) || 1;
  var catRows = '';
  cats.forEach(function (c, idx) {
    var pct = (catSec[c] / catTotal) * 100;
    var col = CAT_COLORS[idx % CAT_COLORS.length];
    catRows += '<div class="hrow"><div class="hname"><span class="dot" style="background:' + col + '"></span>' + c + '</div>' +
      '<div class="htrack"><div class="hfill" style="width:' + pct.toFixed(1) + '%;background:' + col + '"></div></div>' +
      '<div class="hval">' + fmtH(catSec[c]) + ' · ' + pct.toFixed(0) + '%</div></div>';
  });
  document.getElementById('cats').innerHTML = catRows || '<div class="muted" style="font-size:13px">' + D.t.noData + '</div>';

  // Top 项目
  var rows = [];
  D.projects.forEach(function (p) {
    var s = sumRange(p.daily, lo, hi);
    if (s <= 0) return;
    var lastDay = null, k;
    for (k in p.daily) if (inR(k, lo, hi) && (!lastDay || k > lastDay)) lastDay = k;
    rows.push({ proj: p.proj, tool: p.tool, cat: p.cat, sec: s, last: lastDay });
  });
  rows.sort(function (a, b) { return b.sec - a.sec; });
  var top = rows.slice(0, 20);
  var maxProj = top.length ? top[0].sec : 1;
  var projHtml = '';
  top.forEach(function (r) {
    var pct = (r.sec / maxProj) * 100;
    projHtml += '<div class="hrow"><div class="hname" title="' + r.proj + '">' + r.proj + '</div>' +
      '<div class="htrack"><div class="hfill" style="width:' + pct.toFixed(1) + '%;background:' + color(r.tool) + '"></div></div>' +
      '<div class="hval">' + fmtH(r.sec) + ' <span class="muted">· ' + r.cat + ' · ' + D.t.last + ' ' + r.last.slice(5) + '</span></div></div>';
  });
  document.getElementById('projects').innerHTML = projHtml || '<div class="muted" style="font-size:13px">' + D.t.noData + '</div>';
}

function presetRange(name) {
  var t = new Date();
  var today = dayStr(t);
  var mon = mondayOf(t);
  if (name === 'today') return [today, today];
  if (name === 'week') return [dayStr(mon), today];
  if (name === 'lastweek') { var lm = addDays(mon, -7); return [dayStr(lm), dayStr(addDays(lm, 6))]; }
  if (name === 'month') return [today.slice(0, 8) + '01', today];
  if (name === 'lastmonth') {
    return [dayStr(new Date(t.getFullYear(), t.getMonth() - 1, 1)), dayStr(new Date(t.getFullYear(), t.getMonth(), 0))];
  }
  if (name === 'd7') return [dayStr(addDays(t, -6)), today];
  if (name === 'd30') return [dayStr(addDays(t, -29)), today];
  if (name === 'd90') return [dayStr(addDays(t, -89)), today];
  return [null, null]; // all
}

function setRange(since, until, activeChip) {
  cur.since = since;
  cur.until = until;
  document.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
  if (activeChip) activeChip.classList.add('active');
  document.getElementById('d-since').value = since || '';
  document.getElementById('d-until').value = until || '';
  render();
}

document.querySelectorAll('.chip').forEach(function (c) {
  c.addEventListener('click', function () {
    var r = presetRange(c.dataset.preset);
    setRange(r[0], r[1], c);
  });
});

function onCustom() {
  var s = document.getElementById('d-since').value || null;
  var u = document.getElementById('d-until').value || null;
  if (s && u && s > u) { var tmp = s; s = u; u = tmp; }
  setRange(s, u, null);
}
document.getElementById('d-since').addEventListener('change', onCustom);
document.getElementById('d-until').addEventListener('change', onCustom);

setRange(null, null, document.querySelector('.chip[data-preset="all"]'));
</script>
</body>
</html>`;
}

// --json 输出：报表数据序列化为 JSON，方便其他脚本消费
function renderJson({ toolSeconds, toolDaily, toolWeekly, toolMonthly, toolHourly, projRows, catSeconds, range }) {
  const m2o = (m) => Object.fromEntries(Array.from(m.entries()).sort());
  const tools = {};
  for (const [t, sec] of toolSeconds) {
    tools[t] = {
      seconds: sec,
      hours: +(sec / 3600).toFixed(2),
      daily: m2o(toolDaily.get(t)),
      weekly: m2o(toolWeekly.get(t)),
      monthly: m2o(toolMonthly.get(t)),
      hourly: m2o(toolHourly.get(t)),
    };
  }
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    gapSeconds: GAP,
    since: range ? range.since : null,
    until: range ? range.until : null,
    totalSeconds: Array.from(toolSeconds.values()).reduce((a, b) => a + b, 0),
    tools,
    categories: m2o(catSeconds),
    projects: projRows.map((r) => ({
      tool: r.tool,
      project: r.proj,
      seconds: r.sec,
      category: r.cat,
      firstTs: r.first,
      lastTs: r.last,
    })),
  }, null, 2);
}

function printHelp() {
  console.log(L.help);
}

function parseDayArg(name, s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  let d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  // new Date 会把 2026-13-99 这类值自动进位，回验分量拦住
  if (d && (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3])) d = null;
  if (!d || isNaN(d.getTime())) {
    console.error(L.errDate(name, s));
    process.exit(1);
  }
  return d;
}

// --week/--month 展开成 since/until。周一为一周起点（与周图一致），范围不超过今天。
function expandShortcutRange(opts) {
  if (!opts.week && !opts.month) return;
  if (opts.week && opts.month) {
    console.error(L.errWeekMonth);
    process.exit(1);
  }
  if (opts.since || opts.until) {
    console.error(L.errRangeConflict(opts.week ? 'week' : 'month'));
    process.exit(1);
  }
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let since, until;
  if (opts.week) {
    let anchor;
    if (opts.week === true) anchor = today;
    else if (opts.week === 'last') anchor = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7);
    else anchor = parseDayArg('--week', opts.week);
    const dow = (anchor.getDay() + 6) % 7; // 周一=0
    since = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - dow);
    until = new Date(since.getFullYear(), since.getMonth(), since.getDate() + 6);
  } else {
    let y, mo;
    if (opts.month === true) { y = today.getFullYear(); mo = today.getMonth(); }
    else if (opts.month === 'last') { y = today.getFullYear(); mo = today.getMonth() - 1; }
    else {
      const m = /^(\d{4})-(\d{2})$/.exec(opts.month);
      if (!m || +m[2] < 1 || +m[2] > 12) {
        console.error(L.errMonthFmt(opts.month));
        process.exit(1);
      }
      y = +m[1];
      mo = +m[2] - 1;
    }
    since = new Date(y, mo, 1);
    until = new Date(y, mo + 1, 0);
  }
  if (since > today) {
    console.error(L.errFuture(opts.week ? 'week' : 'month'));
    process.exit(1);
  }
  if (until > today) until = today;
  opts.since = since;
  opts.until = until;
}

function parseArgs(argv) {
  const opts = {
    output: 'cchour-report.html', outputSet: false, days: 30, open: false, json: false,
    since: null, until: null, week: null, month: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') {
      opts.output = argv[++i];
      opts.outputSet = true;
    } else if (a === '--days') opts.days = Math.max(1, parseInt(argv[++i], 10) || 30);
    else if (a === '--since') opts.since = parseDayArg('--since', argv[++i]);
    else if (a === '--until') opts.until = parseDayArg('--until', argv[++i]);
    else if (a === '--week' || a === '--month') {
      const next = argv[i + 1];
      opts[a.slice(2)] = next && !next.startsWith('-') ? argv[++i] : true;
    } else if (a === '--lang') {
      i++; // 语言已在 detectLang 里解析，这里只消费它的值
    } else if (a === '--open') opts.open = true;
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (a === '-v' || a === '--version') {
      console.log(pkg.version);
      process.exit(0);
    } else {
      console.error(L.errUnknown(a));
      printHelp();
      process.exit(1);
    }
  }
  if (!opts.output) {
    console.error(L.errNoOutput);
    process.exit(1);
  }
  expandShortcutRange(opts);
  if (opts.since && opts.until && opts.since > opts.until) {
    console.error(L.errSinceUntil);
    process.exit(1);
  }
  return opts;
}

function main() {
  const argv = process.argv.slice(2);
  const lang = detectLang(argv);
  L = T[lang];
  const opts = parseArgs(argv);
  const t0 = Date.now();

  console.error(L.scanning);
  const rules = loadCategories();
  const { data, catOverride } = collect(makeContentCategorize(rules));

  // --since/--until：按本地时区过滤事件，until 含当天整天
  const lo = opts.since ? opts.since.getTime() / 1000 : -Infinity;
  const hi = opts.until ? opts.until.getTime() / 1000 + 86400 : Infinity;
  if (opts.since || opts.until) {
    for (const projects of data.values()) {
      for (const [proj, ts] of projects) {
        const kept = ts.filter((t) => t >= lo && t < hi);
        if (kept.length) projects.set(proj, kept);
        else projects.delete(proj);
      }
    }
  }

  for (const [tool, projects] of data) {
    let n = 0;
    for (const ts of projects.values()) n += ts.length;
    console.error(L.projEvents(tool, projects.size, n));
  }

  const report = buildReport(data, makeCategorize(rules), catOverride, opts.days, {
    since: opts.since, until: opts.until,
  });

  const sorted = Array.from(report.toolSeconds.entries()).sort((a, b) => b[1] - a[1]);
  for (const [t, s] of sorted) console.error(L.toolHours(t, (s / 3600).toFixed(1)));

  if (opts.json) {
    const json = renderJson(report);
    if (opts.outputSet) {
      const outPath = path.resolve(opts.output);
      fs.writeFileSync(outPath, json + '\n', 'utf8');
      console.error(L.generated(outPath, ((Date.now() - t0) / 1000).toFixed(1)));
    } else {
      console.log(json);
      console.error(L.elapsed(((Date.now() - t0) / 1000).toFixed(1)));
    }
    return;
  }

  const html = renderHtml(report, lang);
  const outPath = path.resolve(opts.output);
  fs.writeFileSync(outPath, html, 'utf8');
  console.error(L.generated(outPath, ((Date.now() - t0) / 1000).toFixed(1)));

  if (opts.open) {
    const opener =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', outPath] : [outPath];
    spawn(opener, args, { detached: true, stdio: 'ignore' }).unref();
  }
}

main();
