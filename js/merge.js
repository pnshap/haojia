/* 好价雷达 · 手动合并配置
 * 改完怎么验证：刷新页面 → 打开控制台 → haojiaMerge.find('关键词')
 *      会列出命中的规则、每种写法各有多少条、合并后共多少条。
 */
(function (root) {
  'use strict';

  /* ======================= 配置区（只改这里） ======================= */

  var GROUPS = [

    ['识质存在', '识智存在','《识质存在》 ns2版'],
    ['007初露锋芒', '007'],
    ['卡比的驭天飞行者', '卡比的驭天飞行', '卡比飞天', '卡比驭天行者', '星之卡比驭天行者'],
    ['超级忍反攻的斩击', '超级忍反攻斩击', '《超级忍反攻》'],
    ['耀西与不可思议图鉴', '耀西不可思议图鉴'],
    ['耀西的手工世界', '耀西手工世界'],
    ['合金装备3食蛇者', '合金装备食蛇者', '《合金装备3》'],
    ['马里奥赛车8', '马里赛车8'],
    ['最终幻想7重生', '最终幻想七重生'],
    ['最终幻想7重制版', '《最终幻想7重制》'],
    ['宝可梦朱紫', '宝可梦朱/紫'],
    ['勇者斗恶龙7重制版', '勇者斗恶龙7重置'],
    ['地平线零之曙光重制版', '地平线零之曙光重置'],
    ['刺客信条黑旗重制版', '刺客信条黑旗重置'],
    ['女神异闻录3重制版', '女神异闻录3重制'],
    ['最后生还者1重制版', '最后生还者1重制', '最后生还者1重置'],
    ['黑暗之魂1重制版', '黑暗之魂1重置'],
    ['古墓丽影456重制版', '古墓丽影456重置'],
    ['艾尔登法环+dlc', '艾尔登法环dlc同捆'],
    ['艾尔登法环褪色者版', '艾尔登法环褪色版', '艾尔登法环褪色者'],
    ['八方旅人0', '《八方旅人0》ns1版', '《八方旅人0》ns版'],
    ['百日战记 最终防卫学园', '《百日战纪防卫学园》', '《百日战纪最终防卫》', '《百日战纪最终防卫学园》'],
    ['超级马里奥奥德赛', '马里奥奥德赛'],
  ];

  /* ======================= 以下不用改 ======================= */

  var P = root.HaojiaParser;
  var norm = (P && typeof P.normName === 'function')
    ? function (s) { return P.normName(s); }
    : function (s) {
        return String(s == null ? '' : s).toLowerCase()
          .replace(/[\s\u00A0\u3000《》〈〉「」『』【】\[\]"'“”‘’·・]/g, '');
      };

  var aliasOf = Object.create(null);   // 别名键 → 标准键
  var labelOf = Object.create(null);   // 标准键 → 展示名
  var conflicts = [];

  (function build() {
    for (var g = 0; g < GROUPS.length; g++) {
      var grp = GROUPS[g];
      if (!grp || !grp.length) continue;
      var disp = String(grp[0]).trim();
      var ck = norm(disp);
      if (!ck) continue;
      if (!labelOf[ck]) labelOf[ck] = disp;
      for (var a = 0; a < grp.length; a++) {
        var k = norm(String(grp[a]).trim());
        if (!k) continue;
        if (aliasOf[k] && aliasOf[k] !== ck) conflicts.push(String(grp[a]).trim());
        aliasOf[k] = ck;
      }
    }
  })();

  // 允许链式配置（A 的别名是 B 的展示名），最多走 8 层防死循环
  function resolve(k) {
    for (var i = 0; i < 8 && aliasOf[k] && aliasOf[k] !== k; i++) k = aliasOf[k];
    return k;
  }

  /* ---- 应用：改写归一键 + 展示名，并把合并后撞车的同日记录再收一次 ---- */

  function apply(items) {
    var out = [], seen = Object.create(null);
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var ck = resolve(it.norm);
      if (ck !== it.norm || labelOf[ck]) {
        it.norm = ck;
        // 组内所有写法（包括本来就叫展示名的）统一成配置里的展示名
        if (labelOf[ck]) it.name = labelOf[ck];
      }
      // 两种写法原来是两条，合并后可能落在同一天同一区：只留最低价那条
      var k = [it.date, it.norm, it.regionCode || it.region, it.digital ? 'd' : 'p'].join('\u0001');
      var cur = seen[k];
      if (!cur) { seen[k] = it; out.push(it); continue; }
      if (it.price < cur.price) cur.price = it.price;
      if (cur.histLow == null && it.histLow != null) cur.histLow = it.histLow;
      if (cur.coupon == null && it.coupon != null) cur.coupon = it.coupon;
      if (cur.altPrice == null && it.altPrice != null) cur.altPrice = it.altPrice;
      if (cur.until == null && it.until != null) cur.until = it.until;
      cur.histClaimed = cur.histClaimed || it.histClaimed;
      cur.key = cur.key || it.key;
      if (it.section !== cur.section && /实时新增/.test(it.section)) cur.section = it.section;
    }
    return out;
  }

  /* ---- 排查工具（控制台用） ---- */

  var snapshot = null, warned = false;

  function attach(items) {           // apply 之前调用：先记下合并前每种写法各有多少条
    snapshot = Object.create(null);
    (items || []).forEach(function (i) { snapshot[i.norm] = (snapshot[i.norm] || 0) + 1; });
    if (warned) return;
    warned = true;
    if (conflicts.length) console.warn('[合并配置] 同一个名字出现在多组里，以后出现的为准：\n  ' + conflicts.join('\n  '));
    var miss = unused();
    if (miss.length) console.warn('[合并配置] 这些名字在数据里没找到（写错了？可以删掉）：\n  ' + miss.join('\n  '));
  }

  function countByName() {
    return snapshot || Object.create(null);
  }

  function unused() {
    var m = countByName(), out = [];
    GROUPS.forEach(function (grp) {
      (grp || []).forEach(function (n) {
        var k = norm(String(n).trim());
        if (k && !m[k]) out.push(String(n).trim());
      });
    });
    return out;
  }

  function find(q) {
    var key = norm(String(q == null ? '' : q));
    var m = countByName(), rows = [];
    GROUPS.forEach(function (grp) {
      var hit = (grp || []).some(function (n) { return norm(String(n)).indexOf(key) >= 0; });
      if (!hit) return;
      var ck = resolve(norm(String(grp[0])));
      var detail = grp.map(function (n) { return String(n).trim() + ' ×' + (m[norm(String(n))] || 0); }).join('  |  ');
      var total = 0;
      for (var kk in m) { if (resolve(kk) === ck) total += m[kk]; }
      rows.push({ 展示名: labelOf[ck] || String(grp[0]).trim(), 合并后: total, 写法与条数: detail });
    });
    if (!rows.length) console.log('[合并配置] 没有命中「' + q + '」的规则');
    else if (console.table) console.table(rows);
    else console.log(rows);
    return rows;
  }

  var api = {
    groups: GROUPS,
    apply: apply,
    attach: attach,
    find: find,
    unused: unused,
    key: function (name) { return resolve(norm(name)); },
  };
  root.HaojiaMerge = api;
  root.haojiaMerge = api;      // 控制台里敲小写的更顺手：haojiaMerge.find('关键词')
})(typeof globalThis !== 'undefined' ? globalThis : this);
