/* 好价雷达 · txt 解析核心
 * 纯前端实现（浏览器 <script> / Node require 都能跑），不依赖任何库。
 *
 * 输入：一篇帖子的纯文本（copy/*.txt 的正文，或小黑盒正文）
 * 输出：结构化条目数组
 *
 * 支持的写法（都是从 copy/ 里 172 个文件实际统计出来的）：
 *   1.宝可梦｜🇭🇰228              国旗 + 价格
 *   2。宝可梦｜🔑🇯🇵186            🔑 口令 / 🐴 渠道 前缀
 *   • 宝可梦｜🇭🇰38🇯🇵36（11.11）   一段多区 + 数字版截止日
 *   3.宝可梦朱/紫｜🇯🇵178/184       双版本双价
 *   4.动森｜🇭🇰/🇯🇵196             两国同价
 *   5.生化｜💰141｜新                💰 数字价
 *   6.只狼｜🇭🇰203｜凑-50            券（凑/积/福/加倍补/裸 -N）
 *   7.节奏天国｜🇺🇳164（凑-50可以151） 券后价
 *   8.红蓝281｜75折-80              无国旗裸价 / 折扣券
 *   9.史低181 ｜ 史209 ｜ 新史低     史低（可能不带数字）
 *  10.75-80 ｜8-100 ｜v3专享 ｜ns2 ｜二档 ｜整点抢券   噪声，不是价格
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HaojiaParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /* ---------------- 基础表 ---------------- */

  var REGION = {
    HK: '港版', JP: '日版', UN: '其他区', EU: '欧版', GB: '英版', KR: '韩版',
    CN: '国行', US: '美版', BR: '巴西', NZ: '新西兰', CA: '加拿大',
    NO: '挪威', TH: '泰国', SG: '新加坡', AU: '澳版', MO: '澳门', TW: '台版',
  };

  // 分区排序（越靠前越热门）
  var SEC_ORDER = ['实时新增', '福', '积', '消费', '数字'];
  function secRank(section) {
    for (var i = 0; i < SEC_ORDER.length; i++) {
      if (String(section).indexOf(SEC_ORDER[i]) === 0) return i;
    }
    return 9;
  }
  function secShort(section) {
    return String(section).replace(/（.*?）/g, '').replace(/\(.*?\)/g, '').trim() || String(section);
  }

  /* ---------------- 正则 ---------------- */

  var RE_FLAG_CHAR = /[\u{1F1E6}-\u{1F1FF}]/u;
  // 国旗（+可选“/第二国旗”）+ 可选价格
  var RE_FLAG_PRICE = /([\u{1F1E6}-\u{1F1FF}]{2})(?:\s*\/\s*([\u{1F1E6}-\u{1F1FF}]{2}))?\s*(\d+(?:\.\d+)?)?/gu;
  var RE_EMOJI = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u20E3]/gu;
  var RE_BULLET = /^[\s\u00A0\u2022\u2023\u25AA\u25AB\u25CF\u25C6\u25B8\u25BA\u2043\u2044\u2219\u00B7\u30FB\u2013\u2014\u2015\uFE63\-–—·•●◆◇►‣⁃∙\u{1F518}\u{1F538}\u{1F539}\u{1F53A}\u{1F53B}\u{1F784}\u{1F786}\u{1F788}]+/u;
  var RE_RANGE = /\d+(?:\.\d+)?\s*[-~～－至]\s*\d+(?:\.\d+)?/;      // 8-100 / 75-80
  var RE_TIME = /(\d{1,2}\s*[:：]\s*\d{1,2})|(\d{1,2}\s*点\s*(\d{1,2}\s*分?)?)|(^\s*(凌晨|早上|上午|中午|下午|晚上|晚|半夜|今日|昨天))/;
  var RE_DATE = /^\s*(\d{1,2})\s*[.\-/月]\s*(\d{1,2})\s*[日号]?\s*$/;
  var RE_IGNORE = /^(ns[12]|ps[45]?|switch|v\d+专享|v\d+|二档|三档|一档|新|消|福|积|全新|现货|国行|港版|日版|美版|单位|合计|共|全系列|全史低|史低|整点抢券|点亮券|送|包邮|预售|已结束|最后一天|仅剩|补货|到货|缺货|下架)/;

  /* ---------------- 小工具 ---------------- */

  function txt(s) { return s == null ? '' : String(s); }

  function flagToCode(f) {
    var out = '';
    for (var i = 0; i < f.length; i++) {
      var cp = f.codePointAt(i);
      if (cp > 0xFFFF) i++;                       // 跳过代理对的后半
      out += String.fromCharCode(cp - 0x1F1E6 + 65);
    }
    return out;
  }

  function regionName(code) {
    return REGION[code] || code || '';
  }

  // 名字里的装饰符：书名号 / 引号 / 间隔号 / 结尾标点 —— 同一款游戏常有两种写法
  // 例：《卧龙苍天陨落》 与 卧龙苍天陨落、《EA FC26》与 EA FC26
  var RE_DECOR = /[《》〈〉「」『』【】\[\]“”„‟"'‘’·・,，。:：、！!？?~～]/g;
  var RE_EMOJI_NAME = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u20E3]/gu;

  // 展示用名字：只清掉尾巴上的 emoji 和标点（书名号是作者原文写法，保留）
  function cleanName(name) {
    var s = txt(name).replace(RE_EMOJI_NAME, '');
    s = s.replace(/[\s\u00A0\u3000]+$/g, '');
    s = s.replace(/[·・,，。:：、！!？?~～\-—]+$/g, '');
    return s.trim();
  }

  // 名字归一：合并同一款游戏的多种写法（大小写、空格、全半角、书名号、括号尾注、ns1/ns2 尾巴）
  function normName(name) {
    var s = txt(name).toLowerCase();
    s = s.replace(/[\s\u00A0\u3000]/g, '');
    s = s.replace(/（/g, '(').replace(/）/g, ')');
    s = s.replace(RE_DECOR, '');
    s = s.replace(RE_EMOJI_NAME, '');
    s = s.replace(/\([^()]*\)$/g, '');          // 去掉结尾括号注释
    s = s.replace(/(ns\d|switch2?版?|ps[45]版?)$/g, ''); // 平台尾巴不算名字
    return s;
  }

  // 去掉行首：项目符号、序号（1. / 1。 / 10.. / 33xxx）
  function stripLead(line) {
    var s = line.replace(RE_BULLET, '');
    var m = s.match(/^(\d{1,2})\s*[.。．、,]{1,3}\s*/);
    if (m) return s.slice(m[0].length).trim();
    // "33合金装备食蛇者" 这种序号和名字黏在一起的
    m = s.match(/^([1-9]\d?)(?=[\u4e00-\u9fff\u3040-\u30ffA-Za-z])/);
    if (m) return s.slice(m[0].length).trim();
    return s.trim();
  }

  function isTitleLine(line, ctx) {
    var s = txt(line).replace(/[\s\u00A0]/g, '');
    if (!s) return false;
    if (/好价(卡带|光盘|速通)/.test(s)) return true;                 // 「7.25」Switch卡带好价速通
    if (/^(ps|switch)/i.test(s) && /好价/.test(s)) return true;
    if (ctx && ctx.stem && s.indexOf(ctx.stem.replace(/[\s\u00A0]/g, '')) === 0) return true;
    return false;
  }

  /* ---------------- 一段（｜分隔）的分类 ---------------- */

  function newSeg(digital) {
    return { price: null, region: '', altPrice: null, histLow: null, histClaimed: false,
             coupon: null, after: null, until: null, key: false, channel: false,
             money: false, digital: !!digital, multi: null, tags: [] };
  }

  // 括号里的内容：日期 / 券后价 / 其他说明
  function readParen(inner, st) {
    var s = txt(inner).trim();
    if (!s) return;
    var dm = s.match(/^(\d{1,2})\s*[.\-/月]\s*(\d{1,2})\s*[日号]?$/);
    if (dm) { st.until = dm[1] + '.' + dm[2]; return; }
    var af = s.match(/(?:可以|能|做到|到手|券后|折后)\s*(\d+(?:\.\d+)?)/);
    if (af) { st.after = +af[1]; }
    var cm = s.match(/(?:凑|积|券|减|满|福|加倍补|点亮|返)?\s*[-－]\s*(\d+(?:\.\d+)?)/);
    if (cm) { st.coupon = +cm[1]; }
    if (!af) {
      var af2 = s.match(/(?:可以|能)\s*(\d+(?:\.\d+)?)/);
      if (af2) st.after = +af2[1];
    }
  }

  function classifySeg(raw, st) {
    var s = txt(raw).trim();
    if (!s) return null;

    // 1) 标记位
    if (s.indexOf('🔑') >= 0) { st.key = true; s = s.replace(/🔑/gu, ''); }
    if (s.indexOf('🐴') >= 0) { st.channel = true; s = s.replace(/🐴/gu, ''); }
    if (/[💰💵💹]/u.test(s)) { st.money = true; s = s.replace(/[💰💵💹]/gu, ''); }

    // 2) 括号内容先摘出来
    s = s.replace(/[（(]([^）)]*)[）)]/g, function (m, inner) { readParen(inner, st); return ' '; });

    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return st;

    // 3) 史低：史低181 / 史209 / 新史低 / 史低🇯🇵224 / 💰全史低 / 史低（无数值）
    if (/史低|新史|全史|^史/.test(s)) {
      var hm = s.match(/(\d+(?:\.\d+)?)/);
      if (hm) st.histLow = +hm[1];
      else st.histClaimed = true;
      // "史低🇯🇵224" 这类，价格本身就是史低，仍要把价格读出来
      if (!/\d/.test(s)) return st;
      st.histLow = st.histLow || null;
      return st;
    }

    // 4) 国旗 + 价格
    var rows = [], m;
    RE_FLAG_PRICE.lastIndex = 0;
    while ((m = RE_FLAG_PRICE.exec(s))) {
      var code = flagToCode(m[1]);
      var code2 = m[2] ? flagToCode(m[2]) : '';
      if (m[3] == null) { if (code2) st.tags.push('多区'); continue; }
      rows.push({ region: regionName(code), code: code, price: +m[3], code2: code2 });
      if (code2) rows.rows2 = true;
    }
    if (rows.length) {
      st.price = rows[0].price;
      st.region = rows[0].region;
      st.regionCode = rows[0].code;
      if (rows[0].code2) st.region2 = regionName(rows[0].code2);
      if (rows.length > 1) {
        // "🇯🇵41🇭🇰46"：同一款两个区两个价，主价取低的那条，另一条留着展示
        var best = rows.slice().sort(function (a, b) { return a.price - b.price; })[0];
        st.price = best.price; st.region = best.region; st.regionCode = best.code;
        st.multi = rows.map(function (r) { return { r: r.region, p: r.price }; });
      } else if (rows[0].code2) {
        st.multi = [{ r: rows[0].region, p: rows[0].price }, { r: regionName(rows[0].code2), p: rows[0].price }];
      }
      // "🇯🇵178/184"：双版本第二价（不覆盖主价）
      var tail = s.slice(RE_FLAG_PRICE.lastIndex);
      var am = tail.match(/^\s*\/\s*(\d+(?:\.\d+)?)/);
      if (am) st.altPrice = +am[1];
      return st;
    }

    // 5) 区间 / 时间：都不是价格
    if (RE_RANGE.test(s)) return st;
    if (RE_TIME.test(s) && !/\d{2,}/.test(s.replace(RE_TIME, ''))) return st;

    // 6) 券："凑-50" "-70消" "福-80" "加倍补-30"
    var cm2 = s.match(/^\s*(凑|积|券|折|减|满|福|加倍补|点亮|消|返|红包)?\s*[-－]\s*(\d+(?:\.\d+)?)\s*(消|券|元)?/);
    if (cm2) { st.coupon = +cm2[2]; return st; }

    // 7) 折扣 "75折" / "75折-80"
    var dm2 = s.match(/^(\d{1,2})\s*折\s*[-－]?\s*(\d+(?:\.\d+)?)?/);
    if (dm2) {
      if (dm2[2]) st.coupon = +dm2[2];
      return st;
    }

    // 8) 券后价
    var afm = s.match(/^(?:可以|能|到手|券后|折后)\s*(\d+(?:\.\d+)?)$/);
    if (afm) { st.after = +afm[1]; return st; }

    // 9) 纯数字：日期 or 裸价
    var nm = s.match(/^(\d+(?:\.\d+)?)$/);
    if (nm) {
      var v = +nm[1];
      var dd = s.match(/^(\d{1,2})\.(\d{1,2})$/);
      if (dd) {
        var mo = +dd[1], da = +dd[2];
        // 9.09 / 10.14 / 10.8 这种是数字版截止日；已经有主价了就不该再当价格
        if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31 && (st.price != null || (typeof st.digital !== 'undefined' && st.digital))) {
          st.until = mo + '.' + da;
          return st;
        }
      }
      if (v >= 3 && v <= 9999) {
        if (st.price == null) { st.price = v; st.region = st.region || ''; }
        else st.altPrice = st.altPrice || v;
      }
      return st;
    }

    // 10) "红蓝281" "磁吸红蓝299" 这类：短前缀 + 数字
    var sm = s.match(/^[^\d]{1,8}?(\d+(?:\.\d+)?)\s*(?:元)?$/);
    if (sm && !RE_IGNORE.test(s)) {
      var v2 = +sm[1];
      if (v2 >= 3 && v2 <= 9999) { if (st.price == null) st.price = v2; }
      return st;
    }

    if (s === '新' || s === '新史低') st.tags.push('新');
    if (/ns[12]/.test(s)) st.tags.push(s.match(/ns[12]/)[0]);
    if (/二档|三档/.test(s)) st.tags.push('二档');
    return st;
  }

  /* ---------------- 一行 -> 若干条目 ---------------- */

  function splitSections(lines) {
    var out = [], section = '默认', isDigital = false;
    for (var i = 0; i < lines.length; i++) {
      var line = txt(lines[i]).trim();
      if (!line) continue;
      if (/^[—\-=~＿_]{3,}/.test(line)) {
        var sec = line.replace(/^[—\-=~＿_]+|[—\-=~＿_]+$/g, '').replace(RE_EMOJI, '').trim();
        if (sec && !/^分割线$/.test(sec)) { section = sec; isDigital = /数字/.test(sec); }
        continue;
      }
      out.push({ line: line, section: section, digital: isDigital });
    }
    return out;
  }

  // 单行是否能算「条目行」：行首是序号/符号（少了分隔符的行也收，后面再切）
  function looksItem(line) {
    if (/^[—\-=~＿_]{3,}/.test(line)) return false;
    if (RE_BULLET.test(line)) return true;
    if (/^\d{1,2}\s*[.。．、,]/.test(line)) return true;
    if (/^[1-9]\d?(?=[\u4e00-\u9fff\u3040-\u30ffA-Za-z])/.test(line)) return true; // 33合金装备
    return false;
  }

  // "1.勇者斗恶龙11s🇭🇰184" 这种没用 ｜ 分段的：在第一个国旗/💰 前切开
  function ensureSeparator(body) {
    if (/[｜|]/.test(body)) return body;
    var m = body.match(/[\u{1F1E6}-\u{1F1FF}]|[💰💵💹]/u);
    if (!m || m.index <= 0) return '';
    return body.slice(0, m.index).trim() + '｜' + body.slice(m.index);
  }

  function parsePost(post) {
    var text = txt(post.text).replace(/\r\n?/g, '\n');
    if (!text.trim()) return { items: [], bad: [] };
    var ctx = { stem: post.stem || '', };
    var lines = text.split('\n');
    var items = [], bad = [];

    var blocks = splitSections(lines);
    for (var i = 0; i < blocks.length; i++) {
      var line = blocks[i].line;
      if (isTitleLine(line, ctx)) continue;
      if (!looksItem(line)) {
        // 有国旗 + 数字但没被识别成条目行 —— 记下来方便排查
        if (RE_FLAG_CHAR.test(line) && /\d/.test(line)) bad.push(line);
        continue;
      }
      var body = ensureSeparator(line.replace(/\|/g, '｜'));
      if (!body) {
        if (RE_FLAG_CHAR.test(line) && /\d/.test(line)) bad.push(line);
        continue;
      }
      var parts = body.split('｜').map(function (p) { return p.trim(); });
      var head = stripLead(parts[0] || '');
      var segs = parts.slice(1).filter(Boolean);

      // 名字那一列里也可能混进价格，两种常见写法都要能切开：
      //   《赛博朋克2077》🇭🇰229（凑单-50）｜226   → 国旗前切断
      //   《赛博朋克2077》229（-50）｜史低241      → 书名号后面直接跟数字
      var cut = -1;
      var fm = head.match(/[\u{1F1E6}-\u{1F1FF}]|[💰💵💹]/u);
      if (fm && fm.index > 0) cut = fm.index;
      else {
        var gm = head.match(/^(.*?》)\s*([\d].*)$/);
        if (gm) cut = gm[1].length;
      }
      if (cut > 0) {
        segs.unshift(head.slice(cut).trim());
        head = head.slice(0, cut).trim();
      }
      var name = head;
      if (!name || name.length > 60) continue;

      var st = newSeg(blocks[i].digital);
      for (var j = 0; j < segs.length; j++) classifySeg(segs[j], st);

      if (st.price == null && st.after == null) {
        // 只有史低/券、没有价格的行不要（多半是"暂无""声明"）
        continue;
      }
      var price = st.price != null ? st.price : st.after;
      if (!(price >= 3 && price <= 9999)) continue;

      var region = st.region || '未标区';
      items.push({
        name: cleanName(name),
        norm: normName(name),
        section: blocks[i].section,
        digital: blocks[i].digital,
        regionCode: st.regionCode || '',
        region: region,
        region2: st.region2 || '',
        price: price,
        altPrice: st.altPrice,
        histLow: st.histLow,
        histClaimed: !!st.histClaimed,
        coupon: st.coupon,
        after: st.after,
        until: st.until,
        key: !!st.key,
        channel: !!st.channel,
        multi: st.multi,
        tags: st.tags,
        date: post.date,
        platform: post.platform,
        file: post.file || '',
        postTitle: post.title || '',
      });
    }
    return { items: items, bad: bad };
  }

  /* ---------------- 多篇合并（同日同款同区只留一条，取最低价） ---------------- */

  function buildItems(posts) {
    var all = [], badAll = [];
    for (var i = 0; i < posts.length; i++) {
      var r = parsePost(posts[i]);
      for (var k = 0; k < r.items.length; k++) all.push(r.items[k]);
      for (var b = 0; b < r.bad.length; b++) badAll.push((posts[i].file || '') + ' :: ' + r.bad[b]);
    }
    var map = Object.create(null), order = [];
    for (var j = 0; j < all.length; j++) {
      var it = all[j];
      var key = [it.date, it.norm, it.regionCode || it.region, it.digital ? 'd' : 'p'].join('\u0001');
      var cur = map[key];
      if (!cur) { map[key] = it; order.push(key); continue; }
      if (it.price < cur.price) {
        cur.price = it.price;
        if (it.after != null) cur.after = it.after;
      }
      if (cur.histLow == null && it.histLow != null) cur.histLow = it.histLow;
      if (cur.coupon == null && it.coupon != null) cur.coupon = it.coupon;
      if (cur.until == null && it.until != null) cur.until = it.until;
      if (cur.altPrice == null && it.altPrice != null) cur.altPrice = it.altPrice;
      cur.key = cur.key || it.key;
      cur.histClaimed = cur.histClaimed || it.histClaimed;
      // 「实时新增」优先展示
      if (it.section !== cur.section && /实时新增/.test(it.section)) cur.section = it.section;
    }
    var out = order.map(function (k) { return map[k]; });
    out.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
    return { items: out, bad: badAll };
  }

  return {
    parsePost: parsePost, buildItems: buildItems,
    normName: normName, secRank: secRank, secShort: secShort,
    REGION: REGION, SEC_ORDER: SEC_ORDER,
  };
});
