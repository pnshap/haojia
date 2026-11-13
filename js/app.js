(function () {
  'use strict';

  var Parser = window.HaojiaParser;
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var money = function (n) {
    if (n == null || isNaN(n)) return '—';
    var r = Math.round(n * 10) / 10;
    return (r % 1 === 0) ? String(r) : r.toFixed(1);
  };
  var secRank = Parser.secRank, secShort = Parser.secShort;

  /* 与 build.py 里的 XOR_KEY 必须完全一致 */
  var DATA_KEY = 'haojia-radar-lzq-2026';

  var BUILTIN = [];         // 内置数据（解码后的 posts）
  var DATA = null;          // 当前展示的数据
  var IMPORTED = null;      // 当场导入的 posts（有值就覆盖内置）
  var DAY = null;           // 选中的日期
  var GSEL = null;          // 选中的游戏
  var GQ = '';              // 游戏搜索词
  var GVIEW = null;         // 当前走势的 series（供图例切换）
  var GCHART = null;        // 当前走势图实例
  var GIDX = null;

  /* ================= 数据包解码（gzip + XOR + base64） ================= */

  function b64ToBytes(s) {
    var bin = atob(String(s).replace(/\s+/g, ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function xorBytes(bytes) {
    var out = new Uint8Array(bytes.length), k = DATA_KEY, kl = k.length;
    for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ (k.charCodeAt(i % kl) & 0xff);
    return out;
  }

  function gunzipText(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('当前浏览器不支持 DecompressionStream，请换用较新的浏览器'));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }

  function decodeData(payload) {
    return gunzipText(xorBytes(b64ToBytes(payload))).then(function (text) {
      var pack = JSON.parse(text);
      return (pack.posts || []).map(function (r) {
        // [日期, 文件名主干, 平台, 正文] → 解析器要的 posts 结构
        return {
          date: r[0], stem: r[1], platform: r[2], text: r[3],
          file: r[1] + '.txt', title: r[1],
        };
      });
    });
  }

  /* ================= 数据组装 ================= */

  function buildData(posts) {
    var r = Parser.buildItems(posts);
    var items = r.items;
    // 手动合并：js/merge.js 里配置的「同一款游戏的多种写法」
    if (window.HaojiaMerge) {
      window.HaojiaMerge.attach(items);
      items = window.HaojiaMerge.apply(items);
    }
    var slim = items.map(function (it) {
      return {
        n: it.name, f: it.norm, p: it.platform, s: it.section,
        r: it.region, rc: it.regionCode,
        pr: it.price, hl: it.histLow, hc: it.histClaimed ? 1 : 0,
        cp: it.coupon, af: it.after, du: it.until,
        dg: it.digital ? 1 : 0, al: it.altPrice, mu: it.multi, k: it.key ? 1 : 0,
        d: it.date,
      };
    });

    var byDay = {};
    posts.forEach(function (p) {
      var o = byDay[p.date] || (byDay[p.date] = { d: p.date, posts: 0, items: 0, digital: 0 });
      o.posts++;
    });
    slim.forEach(function (i) {
      var o = byDay[i.d];
      if (!o) return;
      o.items++;
      if (i.dg) o.digital++;
    });
    var days = Object.keys(byDay).sort().reverse().map(function (k) { return byDay[k]; });

    var dates = slim.map(function (i) { return i.d; }).sort();
    var games = {};
    slim.forEach(function (i) { games[i.f] = 1; });
    var secs = {};
    slim.forEach(function (i) { secs[i.s] = (secs[i.s] || 0) + 1; });

    return {
      updated: dates.length ? dates[dates.length - 1] : '—',
      parsedAt: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'),
      range: dates.length ? [dates[0], dates[dates.length - 1]] : null,
      days: days,
      items: slim,
      secs: Object.keys(secs).sort(function (a, b) { return secRank(a) - secRank(b); }),
      stats: {
        posts: posts.length,
        items: slim.length,
        games: Object.keys(games).length,
        digital: slim.filter(function (i) { return i.dg; }).length,
        days: days.length,
      },
    };
  }

  function useData(posts, imported) {
    DATA = buildData(posts);
    IMPORTED = imported || null;
    GIDX = null;
    GCHART = null;
    GVIEW = null;
    DAY = null;
    var first = DATA.days.filter(function (d) { return d.items > 0; })[0];
    DAY = first ? first.d : (DATA.days[0] || {}).d || null;
    renderAll();
    $('#srcbar').classList.toggle('on', !!IMPORTED);
    if (IMPORTED) {
      var s = IMPORTED;
      var t = '已导入 ' + s.count + ' 个 txt：'
        + (s.added ? '新增 ' + s.added + ' 篇 · ' : '')
        + (s.updated ? '更新 ' + s.updated + ' 篇 · ' : '')
        + '内容不变 ' + s.same + ' 篇';
      if (!s.added && !s.updated) t += '（没有新数据）';
      if (s.kept) t += '；另有 ' + s.kept + ' 篇内置数据原样保留';
      t += '。只在本次会话有效，刷新即恢复内置数据。';
      $('#srcTxt').textContent = t;
    }
  }

  /* ================= 提示气泡 ================= */
  function showTip(html, e) {
    var t = $('#tip');
    t.innerHTML = html;
    t.classList.add('on');
    var x = Math.min(e.clientX + 12, window.innerWidth - 200);
    var y = Math.min(e.clientY + 14, window.innerHeight - 60);
    t.style.left = x + 'px'; t.style.top = y + 'px';
  }
  function hideTip() { $('#tip').classList.remove('on'); }

  /* ================= 折线图（可缩放 / 可拖动） ================= */

  function niceTicks(lo, hi, count) {
    var span = (hi - lo) || 1;
    var pad = span * 0.10;
    var dlo = lo - pad, dhi = hi + pad;
    var raw = (dhi - dlo) / count;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / mag;
    var step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
    var ticks = [];
    for (var v = Math.ceil(dlo / step) * step; v <= dhi + step * 1e-6; v += step) ticks.push(Math.round(v * 100) / 100);
    if (!ticks.length) ticks = [Math.round(dlo), Math.round(dhi)];
    return { lo: dlo, hi: dhi, ticks: ticks };
  }

  var CP = { l: 52, r: 18, t: 16, b: 28 };   // 图表内边距

  function Chart(el, opt) {
    this.el = el;
    this.labels = opt.labels || [];
    this.series = opt.series || [];
    this.height = opt.height || 300;
    Chart.uid = (Chart.uid || 0) + 1;
    this.uid = 'hz' + Chart.uid;
    this.win = [0, 1];
    this._bind();
    this.reset();
  }

  Chart.prototype.n = function () { return this.labels.length; };
  Chart.prototype.maxIdx = function () { return Math.max(1, this.n() - 1); };
  Chart.prototype.minSpan = function () { return Math.min(this.maxIdx(), 4); };

  /* 所有可见线里第一条到最后一条有数据的索引 */
  Chart.prototype.dataBounds = function () {
    var lo = -1, hi = -1;
    this.series.forEach(function (s) {
      if (s.hidden) return;
      for (var i = 0; i < s.data.length; i++) {
        if (s.data[i] == null) continue;
        if (lo < 0 || i < lo) lo = i;
        if (i > hi) hi = i;
      }
    });
    return { lo: lo, hi: hi };
  };

  Chart.prototype.clamp = function (lo, hi) {
    var max = this.maxIdx();
    var span = hi - lo, c, ns;
    if (span > max) { c = (lo + hi) / 2; lo = c - max / 2; hi = c + max / 2; }
    if (span < this.minSpan()) { c = (lo + hi) / 2; ns = this.minSpan(); lo = c - ns / 2; hi = c + ns / 2; }
    if (lo < 0) { hi -= lo; lo = 0; }
    if (hi > max) { lo -= (hi - max); hi = max; }
    if (lo < 0) lo = 0;
    return [lo, hi];
  };

  /* 复位：自动裁掉两端大片空白，刚好显示出所有有数据的点 */
  Chart.prototype.reset = function () {
    var b = this.dataBounds();
    if (b.lo < 0) this.win = [0, this.maxIdx()];
    else {
      var lo = b.lo, hi = b.hi;
      if (hi - lo < 2) { lo -= 1; hi += 1; }        // 数据太集中 / 只有一两个点，给点余量
      var pad = (hi - lo) * 0.03;
      this.win = this.clamp(lo - pad, hi + pad);
    }
    this.render();
  };

  Chart.prototype.zoomBy = function (k) {
    var lo = this.win[0], hi = this.win[1], span = hi - lo, c = (lo + hi) / 2;
    var ns = Math.min(Math.max(span * k, this.minSpan()), this.maxIdx());
    this.win = this.clamp(c - ns / 2, c + ns / 2);
    this.render();
  };

  Chart.prototype.render = function () {
    var el = this.el, H = this.height, n = this.n(), self = this;
    var W = Math.max(280, el.clientWidth || 640);
    var lo = this.win[0], hi = this.win[1];
    var iw = W - CP.l - CP.r, ih = H - CP.t - CP.b;
    // 左右各留出一点内边距（≈圆点半径），首尾的点才不会被边框切掉半个
    var pad = 7;
    var X = function (i) {
      var sp = hi - lo;
      if (sp < 1e-6) return CP.l + iw / 2;
      return CP.l + pad + (iw - pad * 2) * (i - lo) / sp;
    };

    var i0 = Math.max(0, Math.floor(lo)), i1 = Math.min(n - 1, Math.ceil(hi));
    var vals = [], dotCount = 0;
    this.series.forEach(function (s) {
      if (s.hidden) return;
      for (var i = i0; i <= i1; i++) {
        var v = s.data[i];
        if (v == null) continue;
        vals.push(v); dotCount++;
      }
    });

    if (!vals.length) {
      el.innerHTML = '<div class="empty" style="padding:36px 0">这段区间没有数据 · 点「复位」回到全部</div>';
      return;
    }

    var lo2 = Math.min.apply(null, vals), hi2 = Math.max.apply(null, vals);
    if (lo2 === hi2) { lo2 = Math.max(0, lo2 - Math.max(2, lo2 * 0.08)); hi2 = hi2 + Math.max(2, hi2 * 0.08); }
    var sc = niceTicks(lo2, hi2, 4);
    var Y = function (v) { return CP.t + ih * (1 - (v - sc.lo) / ((sc.hi - sc.lo) || 1)); };
    var dotR = dotCount > 220 ? 2.6 : dotCount > 90 ? 3.2 : 4;

    var s = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="display:block">';
    s += '<defs><clipPath id="' + this.uid + '"><rect x="' + CP.l + '" y="' + CP.t
      + '" width="' + iw + '" height="' + ih + '"/></clipPath></defs>';

    sc.ticks.forEach(function (v) {
      var y = Y(v);
      s += '<line x1="' + CP.l + '" y1="' + y + '" x2="' + (W - CP.r) + '" y2="' + y + '" stroke="#eef0f5" stroke-width="1"/>';
      s += '<text x="' + (CP.l - 9) + '" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="#939bab">¥' + Math.round(v) + '</text>';
    });

    // 横轴：按可见跨度自动稀释标签
    var span = hi - lo;
    var step = Math.max(1, Math.round(span / 7));
    var lastLab = null;
    var xlab = function (idx) {
      return '<text x="' + X(idx) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#939bab">'
        + esc(self.labels[idx]) + '</text>';
    };
    for (var i = Math.ceil(lo / step) * step; i <= hi + 1e-6; i += step) {
      if (i < 0 || i > n - 1) continue;
      s += xlab(i);
      lastLab = i;
    }
    // 末尾那天单独补一个标签，免得看着像数据提前结束
    var endIdx = Math.min(n - 1, Math.max(0, Math.round(hi)));
    if (lastLab == null || endIdx - lastLab >= Math.max(1, step * 0.5)) {
      if (endIdx !== lastLab) s += xlab(endIdx);
    }

    s += '<g clip-path="url(#' + this.uid + ')">';
    this.series.forEach(function (se) {
      if (se.hidden) return;
      // 相邻点隔太久（>6 天）就断开，别跨着没数据的日子瞎连
      var segs = [], cur = [], last = null;
      for (var j = i0; j <= i1; j++) {
        var v = se.data[j];
        if (v == null) continue;
        if (last != null && j - last > 6) { if (cur.length) segs.push(cur); cur = []; }
        cur.push([X(j), Y(v)]);
        last = j;
      }
      if (cur.length) segs.push(cur);
      segs.forEach(function (pts) {
        if (pts.length < 2) return;
        s += '<polyline fill="none" stroke="' + se.color + '" stroke-width="2.2" stroke-linejoin="round" '
          + 'stroke-linecap="round" points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ')
          + '"' + (se.dash ? ' stroke-dasharray="6 4"' : '') + '/>';
      });
      for (var k = i0; k <= i1; k++) {
        var val = se.data[k];
        if (val == null) continue;
        s += '<circle class="dots" cx="' + X(k) + '" cy="' + Y(val) + '" r="' + (se.dash ? dotR - 0.6 : dotR)
          + '" fill="#fff" stroke="' + se.color + '" stroke-width="2.2" data-tip="'
          + esc(se.name + ' · ' + self.labels[k] + '｜¥' + money(val)) + '" style="cursor:pointer"/>';
      }
    });
    s += '</g></svg>';

    el.innerHTML = s;
    el.querySelectorAll('circle.dots').forEach(function (c) {
      c.addEventListener('mousemove', function (e) { showTip(c.dataset.tip, e); });
      c.addEventListener('mouseleave', hideTip);
    });
  };

  Chart.prototype._bind = function () {
    var self = this, el = this.el;

    el.addEventListener('wheel', function (e) {
      if (!self.series.length) return;
      if (!e.deltaY && !e.deltaX) return;
      e.preventDefault();
      var rect = el.getBoundingClientRect();
      var iw = Math.max(80, (rect.width || 640) - CP.l - CP.r);
      var f = Math.min(1, Math.max(0, (e.clientX - rect.left - CP.l) / iw));
      var lo = self.win[0], hi = self.win[1], sp = hi - lo;
      var anchor = lo + f * sp;
      var k = e.deltaY > 0 ? 1.25 : 0.8;
      var ns = Math.min(Math.max(sp * k, self.minSpan()), self.maxIdx());
      var nlo = anchor - f * ns;
      self.win = self.clamp(nlo, nlo + ns);
      hideTip();
      self.render();
    }, { passive: false });

    el.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || !self.series.length) return;
      e.preventDefault();
      var rect = el.getBoundingClientRect();
      var iw = Math.max(80, (rect.width || 640) - CP.l - CP.r);
      var startX = e.clientX, w0 = self.win.slice(), sp = w0[1] - w0[0];
      el.classList.add('panning');
      hideTip();
      function mv(ev) {
        var d = -(ev.clientX - startX) / iw * sp;
        self.win = self.clamp(w0[0] + d, w0[1] + d);
        self.render();
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        el.classList.remove('panning');
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });

    el.addEventListener('dblclick', function () { self.reset(); });
  };

  /* ================= 顶部 KPI ================= */
  function curDayItems() {
    return DAY ? DATA.items.filter(function (i) { return i.d === DAY; }) : [];
  }

  function renderHead() {
    var p = DATA, s = p.stats;
    $('#upd').textContent = p.updated;
    $('#rng').textContent = p.range ? (p.range[0] + ' ~ ' + p.range[1]) : '暂无';
    $('#cnt').textContent = s.items.toLocaleString();
    var day = curDayItems();
    var phys = day.filter(function (i) { return !i.dg; });
    var avg = phys.length ? phys.reduce(function (a, b) { return a + b.pr; }, 0) / phys.length : null;
    var kp = [
      ['覆盖天数', s.days, s.posts + ' 篇帖子'],
      ['条目总数', s.items.toLocaleString(), '卡带 + 光盘 + 数字'],
      ['收录游戏', s.games.toLocaleString(), '按名称归一合并'],
      ['数字版条目', s.digital.toLocaleString(), '已单独画线'],
      ['当日实体均价', avg == null ? '—' : '¥' + money(avg), (DAY || '—') + ' 全部实体条目'],
    ];
    $('#kpis').innerHTML = kp.map(function (k) {
      return '<div class="kpi"><div class="lab">' + k[0] + '</div><div class="val">' + k[1]
        + '</div><div class="sub">' + k[2] + '</div></div>';
    }).join('');
  }

  /* ================= 好价清单 ================= */
  function tagHTML(i, skipDigital) {
    var t = [];
    if (i.hl != null) t.push('<span class="tg low">史低 ' + money(i.hl) + '</span>');
    else if (i.hc) t.push('<span class="tg low">史低</span>');
    if (i.dg && !skipDigital) t.push('<span class="tg dg">数字' + (i.du ? ' ' + esc(i.du) : '') + '</span>');
    if (i.dg && skipDigital && i.du) t.push('<span class="tg dg">截止 ' + esc(i.du) + '</span>');
    if (i.cp) t.push('<span class="tg cp">券 -' + money(i.cp) + '</span>');
    if (i.af != null) t.push('<span class="tg cp">券后 ' + money(i.af) + '</span>');
    if (i.k) t.push('<span class="tg key">口令</span>');
    return t.join('');
  }

  function renderDaybar() {
    var days = DATA.days;
    if (!days.length) { $('#daybar').innerHTML = '<span class="lbl">还没有任何数据</span>'; return; }
    $('#daybar').innerHTML = '<span class="lbl">日期</span>' + days.map(function (d) {
      var dt = d.d.slice(5).replace('-', '.');
      var cls = 'dchip' + (d.d === DAY ? ' on' : '') + (d.items ? '' : ' miss');
      return '<button class="' + cls + '" data-d="' + d.d + '"><span class="dd">' + dt + '</span>'
        + '<span class="dc">' + (d.items ? d.items + ' 条' : '无数据') + '</span></button>';
    }).join('');
    $$('#daybar .dchip').forEach(function (b) {
      b.onclick = function () { DAY = b.dataset.d; renderDaybar(); renderDay(); renderHead(); };
    });
  }

  function dayCard(platform) {
    var items = curDayItems().filter(function (i) { return i.p === platform; });
    var head = '<span class="spill ' + (platform === 'Switch' ? 'sw' : 'ps') + '">'
      + (platform === 'Switch' ? 'Switch 卡带' : 'PS 光盘') + '</span>';
    if (!items.length) {
      return '<div class="card pcol"><div class="pcol-hd">' + head + '</div><div class="empty">这一天没有 ' + platform + ' 数据</div></div>';
    }
    var phys = items.filter(function (i) { return !i.dg; }).map(function (i) { return i.pr; });
    var med = phys.length ? phys.slice().sort(function (a, b) { return a - b; })[phys.length >> 1] : null;
    var secs = [];
    items.forEach(function (i) { if (secs.indexOf(i.s) < 0) secs.push(i.s); });
    secs.sort(function (a, b) { return secRank(a) - secRank(b); });

    var body = secs.map(function (sec) {
      var list = items.filter(function (i) { return i.s === sec; }).sort(function (a, b) { return a.pr - b.pr; });
      return '<div class="sec"><div class="sec-hd">' + esc(secShort(sec)) + ' · ' + list.length + '</div>'
        + list.map(function (i) {
          var low = i.hl != null && i.pr <= i.hl;
          var rg = i.r + (i.mu && i.mu.length > 1
            ? ' <span style="color:#b9c0cc">(' + i.mu.map(function (m) { return m.r.replace('版', '') + money(m.p); }).join('/') + ')</span>'
            : '');
          return '<div class="row"><span class="n" data-f="' + esc(i.f) + '" title="' + esc(i.n + '｜' + i.r + '｜' + secShort(sec)) + '">'
            + esc(i.n) + '</span><span class="rg">' + rg + '</span>' + tagHTML(i)
            + '<span class="pr" style="' + (low ? 'color:var(--down)' : '') + '">' + money(i.pr) + '</span></div>';
        }).join('') + '</div>';
    }).join('');

    return '<div class="card pcol"><div class="pcol-hd">' + head
      + '<span class="st">' + items.length + ' 条 · 实体中位 ¥' + (med == null ? '—' : money(med))
      + ' · 最低 ¥' + money(Math.min.apply(null, items.map(function (i) { return i.pr; }))) + '</span></div>'
      + body + '</div>';
  }

  function renderDay() {
    var has = curDayItems().length > 0;
    if (!has) {
      $('#dayBody').innerHTML = '<div class="empty"><b>' + (DAY || '—') + ' 这天没有数据</b>换一天看看，或点右上角导入 txt。</div>';
      return;
    }
    $('#dayBody').innerHTML = '<div class="cols" style="padding:0 16px 16px">'
      + dayCard('Switch') + dayCard('PS') + '</div>';
    $$('#dayBody .row .n').forEach(function (el) {
      el.onclick = function () { openGame(el.dataset.f); };
    });
  }

  /* ================= 单品走势 ================= */
  var DCOLORS = ['#7c4ddb', '#e08a2b', '#0f9d8a', '#b03a8c', '#6b7280', '#0b7fc4'];

  function gameIndex() {
    var m = {};
    DATA.items.forEach(function (i) {
      var g = m[i.f] || (m[i.f] = { f: i.f, name: i.n, k: Parser.normName(i.n), count: 0, days: {}, ps: {}, hasDg: false, hasPhy: false });
      g.count++;
      g.name = i.n;
      g.ps[i.p] = 1;
      g.days[i.d] = 1;
      if (i.dg) g.hasDg = true; else g.hasPhy = true;
    });
    return m;
  }

  // 列表按名字排（和文件名排序一致：汉字按拼音、数字按大小，《》这类符号不参与比较）
  var NAME_COLL = (typeof Intl !== 'undefined' && Intl.Collator)
    ? new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' }) : null;

  function cmpName(a, b) {
    var x = a.k || a.name, y = b.k || b.name;
    var c = NAME_COLL ? NAME_COLL.compare(x, y) : String(x).localeCompare(String(y), 'zh');
    return c || a.name.localeCompare(b.name, 'zh') || b.count - a.count;
  }

  function renderGameList() {
    if (!GIDX) GIDX = gameIndex();
    var list = Object.keys(GIDX).map(function (k) { return GIDX[k]; });
    list.sort(cmpName);
    if (!Object.keys(GIDX).length) {
      $('#glist').innerHTML = '<div class="gempty">暂无数据</div>';
      return;
    }
    var q = GQ.trim().toLowerCase();
    if (q) list = list.filter(function (g) { return g.name.toLowerCase().indexOf(q) >= 0 || String(g.f).indexOf(q) >= 0; });
    if (!list.length) {
      $('#glist').innerHTML = '<div class="gempty">没有匹配「' + esc(GQ.trim()) + '」的游戏</div>';
      return;
    }
    if (!GSEL || !list.some(function (g) { return g.f === GSEL; })) GSEL = list[0].f;
    $('#glist').innerHTML = list.map(function (g) {
      var tags = Object.keys(g.ps).join('/') + (g.hasDg ? '·数字' : '');
      return '<div class="gitem ' + (g.f === GSEL ? 'on' : '') + '" data-f="' + esc(g.f) + '">'
        + '<span class="nm">' + esc(g.name) + '</span>'
        + '<span class="ct">' + tags + '</span>'
        + '<span class="ct">' + g.count + '条</span></div>';
    }).join('');
    $$('#glist .gitem').forEach(function (el) {
      el.onclick = function () { GSEL = el.dataset.f; renderGameList(); renderGame(); };
    });
  }

  function buildSeries(items, days) {
    var physBy = {}, digBy = {};
    items.forEach(function (i) {
      if (!i.dg) (physBy[i.p] || (physBy[i.p] = {}))[i.d] = Math.min((physBy[i.p][i.d] == null ? 1e9 : physBy[i.p][i.d]), i.pr);
      else (digBy[i.r] || (digBy[i.r] = {}))[i.d] = Math.min((digBy[i.r][i.d] == null ? 1e9 : digBy[i.r][i.d]), i.pr);
    });
    var out = [];
    ['Switch', 'PS'].forEach(function (p) {
      var m = physBy[p];
      if (!m) return;
      out.push({
        key: 'p:' + p, name: p + ' 实体',
        color: p === 'Switch' ? '#e0524c' : '#2f6fdd',
        data: days.map(function (d) { return m[d] == null ? null : m[d]; }),
      });
    });
    var di = 0;
    Object.keys(digBy).sort().forEach(function (r) {
      out.push({
        key: 'd:' + r, name: '数字 · ' + r,
        color: DCOLORS[di++ % DCOLORS.length], dash: true,
        data: days.map(function (d) { return digBy[r][d] == null ? null : digBy[r][d]; }),
      });
    });
    return out;
  }

  function renderGame() {
    GCHART = null;
    if (!GSEL) { $('#gameBody').innerHTML = '<div class="card"><div class="empty">先选一只游戏</div></div>'; return; }
    var items = DATA.items.filter(function (i) { return i.f === GSEL; });
    if (!items.length) { $('#gameBody').innerHTML = '<div class="card"><div class="empty">暂无数据</div></div>'; return; }

    // 名字用出现次数最多的那个写法，别用最后一条的（有的帖子会简写）
    var nameCnt = {}, name = items[0].n;
    items.forEach(function (i) { nameCnt[i.n] = (nameCnt[i.n] || 0) + 1; });
    Object.keys(nameCnt).forEach(function (k) { if (nameCnt[k] > (nameCnt[name] || 0)) name = k; });

    var gameDays = [];
    items.forEach(function (i) { if (gameDays.indexOf(i.d) < 0) gameDays.push(i.d); });
    gameDays.sort();
    // 时间轴用全站日期，保证横轴间距 = 真实天数（空缺的日子留空）
    var days = DATA.days.map(function (d) { return d.d; }).sort();

    var phys = items.filter(function (i) { return !i.dg; });
    var dig = items.filter(function (i) { return i.dg; });
    var phyLow = phys.length ? Math.min.apply(null, phys.map(function (i) { return i.pr; })) : null;
    var digLow = dig.length ? Math.min.apply(null, dig.map(function (i) { return i.pr; })) : null;
    var plats = [];
    items.forEach(function (i) { if (plats.indexOf(i.p) < 0) plats.push(i.p); });

    var series = buildSeries(items, days);
    series.forEach(function (s) { s.hidden = false; });
    GVIEW = series;

    // 价格明细页去掉了，这里把全部记录都列出来（按日期倒序），外层可滚动
    var rows = items.slice().sort(function (a, b) {
      return a.d < b.d ? 1 : a.d > b.d ? -1 : a.pr - b.pr;
    });

    var legend = series.map(function (s) {
      var cnt = s.data.filter(function (v) { return v != null; }).length;
      return '<span data-k="' + esc(s.key) + '"><i style="background:' + s.color + ';'
        + (s.dash ? 'background-image:repeating-linear-gradient(90deg,' + s.color + ' 0 4px,transparent 4px 7px);background-color:transparent' : '')
        + '"></i>' + esc(s.name) + ' <b style="font-weight:500;color:var(--tx3)">' + cnt + '天</b></span>';
    }).join('');

    $('#gameBody').innerHTML = '<div class="card box">'
      + '<h3>' + esc(name) + '</h3>'
      + '<div class="desc">出现 ' + items.length + ' 次 · 覆盖 ' + gameDays.length + ' 天 · ' + plats.join(' / ')
      + (dig.length ? ' · 含数字版 ' + dig.length + ' 条（虚线）' : '') + '</div>'
      + '<div class="statrow">'
      + '<div class="mini"><div class="l">实体最低</div><div class="v" style="color:' + (phyLow != null ? 'var(--down)' : 'var(--tx3)') + '">'
      + (phyLow != null ? '¥' + money(phyLow) : '—') + '</div></div>'
      + '<div class="mini"><div class="l">数字最低</div><div class="v" style="color:' + (digLow != null ? 'var(--dg)' : 'var(--tx3)') + '">'
      + (digLow != null ? '¥' + money(digLow) : '—') + '</div></div>'
      + '<div class="mini"><div class="l">实体均价</div><div class="v">'
      + (phys.length ? '¥' + money(phys.reduce(function (a, b) { return a + b.pr; }, 0) / phys.length) : '—') + '</div></div>'
      + '<div class="mini"><div class="l">出现天数</div><div class="v">' + gameDays.length + '</div></div>'
      + '</div>'
      + (series.length ? '<div class="legend" id="glegend">' + legend + '</div>'
        + '<div class="chartbar"><span class="hint">滚轮缩放 · 拖动平移 · 双击复位（已自动裁掉空档日期）</span>'
        + '<span class="zb"><button class="btn sm" data-z="in">放大</button>'
        + '<button class="btn sm" data-z="out">缩小</button>'
        + '<button class="btn sm" data-z="reset">复位</button></span></div>'
        : '')
      + '<div id="gwrap"></div>'
      + (gameDays.length > 1 ? '' : '<div class="note" style="margin-top:8px">只有 1 天数据，先是一个点；多攒几天的 txt 就能连成线。</div>')
      + '<div class="hist"><div class="hist-hd">全部价格记录 <b>' + rows.length + '</b> 条 · 按日期倒序</div>'
      + rows.map(function (i) {
        return '<div class="row"><span class="rg" style="width:42px;font-variant-numeric:tabular-nums">' + i.d.slice(5) + '</span>'
          + '<span class="spill ' + (i.dg ? 'dg' : i.p === 'Switch' ? 'sw' : 'ps') + '" style="font-size:10px">' + (i.dg ? '数字' : i.p) + '</span>'
          + '<span class="rg">' + esc(i.r) + '</span>' + tagHTML(i, true)
          + '<span class="pr">' + money(i.pr) + '</span></div>';
      }).join('')
      + '</div></div>';

    if (!series.length) return;

    GCHART = new Chart($('#gwrap'), {
      labels: days.map(function (d) { return d.slice(5).replace('-', '.'); }),
      series: series,
      height: 300,
    });

    $$('#glegend span').forEach(function (el) {
      el.onclick = function () {
        var se = GVIEW.find(function (x) { return x.key === el.dataset.k; });
        if (!se) return;
        se.hidden = !se.hidden;
        el.classList.toggle('off', se.hidden);
        GCHART.reset();               // 隐藏某条线后重新裁空白
      };
    });

    $$('#gameBody .zb .btn').forEach(function (b) {
      b.onclick = function () {
        var z = b.dataset.z;
        if (z === 'reset') GCHART.reset();
        else GCHART.zoomBy(z === 'in' ? 0.72 : 1.4);
      };
    });
  }

  function openGame(norm) {
    GSEL = norm;
    GQ = '';
    $('#gq').value = '';
    $$('.tab').forEach(function (t) { t.classList.remove('on'); });
    $$('.panel').forEach(function (p) { p.classList.remove('on'); });
    $('[data-tab=game]').classList.add('on');
    $('#p-game').classList.add('on');
    renderGameList();
    renderGame();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ================= 数据说明 ================= */
  function renderAbout() {
    var s = DATA.stats;
    $('#aboutDesc').innerHTML = '共整理 <b>' + s.posts + '</b> 篇帖子，得到 <b>' + s.items.toLocaleString()
      + '</b> 条价格记录，覆盖 <b>' + s.days + '</b> 天、<b>' + s.games.toLocaleString() + '</b> 只游戏。'
      + '<br>数据最新到 ' + (DATA.range ? DATA.range[1] : '—') + '，本页解析时间 ' + DATA.parsedAt + '。';
    var bySec = {};
    DATA.items.forEach(function (i) { bySec[i.s] = (bySec[i.s] || 0) + 1; });
    var byReg = {};
    DATA.items.forEach(function (i) { byReg[i.r] = (byReg[i.r] || 0) + 1; });
    var html = Object.keys(bySec).sort(function (a, b) { return bySec[b] - bySec[a]; }).map(function (k) {
      return '<i>' + esc(secShort(k)) + ' ' + bySec[k] + '</i>';
    }).join('');
    html += Object.keys(byReg).sort(function (a, b) { return byReg[b] - byReg[a]; }).slice(0, 8).map(function (k) {
      return '<i>' + esc(k) + ' ' + byReg[k] + '</i>';
    }).join('');
    $('#aboutKv').innerHTML = html;
  }

  /* ================= 导入 txt ================= */
  function parseDateFromName(s) {
    var m = String(s).match(/(\d{1,2})\s*[.\-/月]\s*(\d{1,2})/);
    if (!m) return null;
    var today = new Date();
    var cands = [today.getFullYear(), today.getFullYear() - 1];
    for (var i = 0; i < cands.length; i++) {
      var d = new Date(cands[i], +m[1] - 1, +m[2]);
      if (d.getMonth() === +m[1] - 1 && d.getDate() === +m[2] && d <= today) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      }
    }
    return null;
  }

  function platformFromName(s) {
    var low = String(s).toLowerCase();
    if (low.indexOf('switch') >= 0 || low.indexOf('卡带') >= 0) return 'Switch';
    if (low.indexOf('ps') >= 0 || low.indexOf('光盘') >= 0) return 'PS';
    return '其他';
  }

  function cleanBody(raw, stem) {
    var lines = raw.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    if (lines.length) {
      var first = lines[0].replace(/\s/g, '');
      var head = stem.replace(/\s/g, '').slice(0, 4);
      if (first.indexOf(head) === 0 || /好价(卡带|光盘|速通)/.test(first)) lines.shift();
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n');
  }

  /* 与 build.py 的 merge() 同一套规则：以文件名主干为身份，
     同名同内容算未变、同名不同内容用新导入的覆盖、只在内置数据里有的原样保留。 */
  function mergePosts(base, inc) {
    var map = {}, seen = {}, out = [];
    var st = { same: 0, updated: 0, added: 0, kept: 0 };
    (base || []).forEach(function (p) { map[p.stem] = p; });
    inc.forEach(function (p) {
      if (seen[p.stem]) return;          // 同名文件只认第一次，避免重复计入
      seen[p.stem] = 1;
      var o = map[p.stem];
      if (!o) st.added++;
      else if (String(o.text || '').trim() === String(p.text || '').trim()) st.same++;
      else st.updated++;
      out.push(p);
    });
    (base || []).forEach(function (p) {
      if (!seen[p.stem]) { st.kept++; out.push(p); }
    });
    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
      return 0;
    });
    return { posts: out, stats: st };
  }

  function loadFiles(files) {
    var list = Array.prototype.slice.call(files).filter(function (f) { return /\.txt$/i.test(f.name); });
    if (!list.length) { alert('没有找到 .txt 文件'); return; }
    var posts = [], done = 0;

    function finish() {
      if (!posts.length) { alert('这些文件里没有识别出可用的帖子（检查文件名是否带日期）'); return; }
      var m = mergePosts(BUILTIN, posts);      // 只并入新/改动过的，内置数据不动
      useData(m.posts, {
        count: posts.length, added: m.stats.added, updated: m.stats.updated,
        same: m.stats.same, kept: m.stats.kept,
      });
    }

    list.forEach(function (f) {
      var reader = new FileReader();
      reader.onload = function () {
        var stem = f.name.replace(/\.txt$/i, '');
        var date = parseDateFromName(stem);
        var text = cleanBody(String(reader.result || ''), stem);
        if (date && text.length > 20) {
          posts.push({
            file: f.name, stem: stem, date: date,
            platform: platformFromName(stem), title: stem, text: text,
          });
        }
        if (++done === list.length) finish();
      };
      reader.onerror = function () { if (++done === list.length) finish(); };
      reader.readAsText(f, 'utf-8');
    });
  }

  /* ================= 渲染入口 ================= */
  function renderAll() {
    GIDX = null;
    GVIEW = null;
    GCHART = null;
    renderHead();
    renderDaybar();
    renderDay();
    renderGameList();
    renderGame();
    renderAbout();
  }

  function showEmpty(title, desc) {
    DATA = buildData([]);
    renderAll();
    $('#dayBody').innerHTML = '<div class="empty"><b>' + title + '</b>' + desc + '</div>';
    $('#gameBody').innerHTML = '<div class="card"><div class="empty">' + title + '</div></div>';
  }

  /* ================= 绑定 ================= */
  function bind() {
    $$('.tab').forEach(function (t) {
      t.onclick = function () {
        $$('.tab').forEach(function (x) { x.classList.remove('on'); });
        t.classList.add('on');
        $$('.panel').forEach(function (p) { p.classList.remove('on'); });
        $('#p-' + t.dataset.tab).classList.add('on');
        if (t.dataset.tab === 'game') { renderGameList(); renderGame(); }
        if (t.dataset.tab === 'about') renderAbout();
      };
    });

    var gq = $('#gq');
    if (gq) gq.oninput = function () { GQ = gq.value; renderGameList(); renderGame(); };

    $('#btnPick').onclick = function () { $('#pickDir').click(); };
    $('#btnBack').onclick = function () {
      if (!BUILTIN.length) return;
      IMPORTED = null;
      $('#srcbar').classList.remove('on');
      useData(BUILTIN);
    };
    $('#pickDir').onchange = function (e) { loadFiles(e.target.files); e.target.value = ''; };

    window.addEventListener('resize', function () {
      if (GCHART && $('#p-game').classList.contains('on')) GCHART.render();
    });
  }

  function boot() {
    bind();
    var payload = window.HAOJIA_DATA;
    if (!payload) {
      showEmpty('没有内置数据', '先运行 <code>python3 build.py</code> 生成 <code>js/data.js</code>，<br>或点右上角「导入 txt 文件夹」。');
      return;
    }
    decodeData(payload).then(function (posts) {
      BUILTIN = posts;
      if (!BUILTIN.length) {
        showEmpty('没有内置数据', '先运行 <code>python3 build.py</code> 生成 <code>js/data.js</code>。');
        return;
      }
      useData(BUILTIN);
    }).catch(function (err) {
      showEmpty('数据包解码失败', esc(err && err.message ? err.message : String(err)));
    });
  }

  boot();
})();
