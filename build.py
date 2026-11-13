"""把 txt/ 里的帖子打包成前端可直接加载的数据包（纯前端方案的数据来源）

用法：
    python3 build.py                        # 把 txt/ 增量合并进已有的 js/data.js
    python3 build.py --list                 # 只打印合并计划，不写文件
    python3 build.py --fresh                # 忽略已有 data.js，完全按 txt/ 重建
    python3 build.py --from-js 旧posts.js    # 从旧版 posts.js 重新打包（不读 txt/）

合并规则（默认行为）：
    以文件名主干（如 "11.10｜Switch好价卡带"）作为一篇帖子的身份。
      · txt 里有、data.js 里也有，正文一样  → 保留，不算变化
      · txt 里有、data.js 里也有，正文不同  → 用 txt 的覆盖（认为是订正）
      · txt 里有、data.js 里没有            → 新增
      · data.js 里有、txt 里没有            → 原样保留（不会因为本地缺文件就丢数据）
    所以 txt/ 只需要放"新增的那几天"，不必凑齐全部历史帖子。

生成物：
    js/data.js   window.HAOJIA_DATA = base64( XOR( gzip(JSON) ) )
                 JSON 结构：{"v":1,"posts":[[date, stem, platform, text], ...]}
                 不落明文，体积也比裸 JSON 小一大截（gzip + base64）。
前端 index.html 用 <script src="js/data.js"> 加载，js/app.js 在浏览器里解码 + 解析。
数据在同一个文件里，双击本地 index.html 也能跑（file:// 没有 CORS 问题）。
"""
import os, re, json, glob, gzip, base64, datetime, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
TXT_DIR = os.path.join(HERE, "txt")
OUT_JS = os.path.join(HERE, "js", "data.js")

# 和 js/app.js 里的 DATA_KEY 必须完全一致（改一个就要改另一个）
XOR_KEY = b"haojia-radar-lzq-2026"

PLATFORM_MAP = [("switch", "Switch"), ("卡带", "Switch"),
                ("ps", "PS"), ("光盘", "PS"), ("playstation", "PS")]


def guess_platform(name):
    low = name.lower()
    for k, v in PLATFORM_MAP:
        if k in low:
            return v
    return "其他"


def parse_date(s, today=None):
    """'11.5' -> date，自动处理跨年（帖子日期不会晚于今天）"""
    today = today or datetime.date.today()
    m = re.match(r"\s*(\d{1,2})\s*[.\-/月]\s*(\d{1,2})", s)
    if not m:
        return None
    mo, d = int(m.group(1)), int(m.group(2))
    for y in (today.year, today.year - 1):
        try:
            cand = datetime.date(y, mo, d)
        except ValueError:
            continue
        if cand <= today + datetime.timedelta(days=1):
            return cand
    return None


def read_txt(path):
    for enc in ("utf-8", "utf-8-sig", "gb18030", "gbk"):
        try:
            with open(path, encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def clean_body(raw, stem):
    """去掉 BOM、首行标题、多余空行"""
    text = raw.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    lines = text.split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines:
        first = re.sub(r"\s", "", lines[0])
        if first.startswith(re.sub(r"\s", "", stem)[:4]) or re.search(r"好价(卡带|光盘|速通)", first):
            lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def collect():
    posts, skipped = [], []
    for fp in sorted(glob.glob(os.path.join(TXT_DIR, "*.txt"))):
        stem = os.path.splitext(os.path.basename(fp))[0]
        parts = re.split(r"[｜|]", stem, maxsplit=1)
        d = parse_date(parts[0])
        if not d:
            skipped.append((stem, "文件名里没有日期，按文件修改时间兜底"))
            d = datetime.date.fromtimestamp(os.path.getmtime(fp))
        platform = guess_platform(parts[1] if len(parts) > 1 else stem)
        body = clean_body(read_txt(fp), stem)
        if len(body) < 20:
            skipped.append((stem, "正文太短，跳过"))
            continue
        # 紧凑结构：[日期, 文件名主干, 平台, 正文]
        posts.append([d.isoformat(), stem, platform, body])
    posts.sort(key=lambda p: (p[0], p[2]))
    return posts, skipped


def encode(posts):
    raw = json.dumps({"v": 1, "posts": posts}, ensure_ascii=False,
                     separators=(",", ":")).encode("utf-8")
    comp = gzip.compress(raw, 9, mtime=0)          # mtime=0 保证可复现
    xored = bytes(b ^ XOR_KEY[i % len(XOR_KEY)] for i, b in enumerate(comp))
    return base64.b64encode(xored).decode("ascii"), len(raw), len(comp)


def decode(payload):
    """base64 → XOR → gzip → JSON.posts，和前端解密链路完全一致"""
    comp = base64.b64decode(payload)
    raw = bytes(b ^ XOR_KEY[i % len(XOR_KEY)] for i, b in enumerate(comp))
    pack = json.loads(gzip.decompress(raw).decode("utf-8"))
    return pack.get("posts") or []


def load_data_js(path):
    """读回已有的 js/data.js（没有这个文件就返回空列表）"""
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        src = f.read()
    m = re.search(r'HAOJIA_DATA\s*=\s*"([^"]+)"', src)
    if not m:
        raise ValueError("文件里没有 HOAJIA_DATA 变量，可能不是本脚本生成的")
    return decode(m.group(1))


def merge(txt_posts, old_posts):
    """把新抓到的 txt 合并进已有数据，返回 (合并结果, 统计)

    身份 = 文件名主干（含月.日与平台），正文按去首尾空白后比较。
    """
    old = {}
    for p in old_posts:
        if isinstance(p, list) and len(p) >= 4:
            old[p[1]] = p

    out, seen = [], set()
    st = {"same": 0, "updated": 0, "added": 0, "kept": 0,
          "same_stems": [], "updated_stems": [], "added_stems": [], "kept_stems": []}
    for p in txt_posts:
        stem = p[1]
        if stem in seen:                    # 同名文件只认第一次
            continue
        seen.add(stem)
        o = old.get(stem)
        if o is None:
            st["added"] += 1
            st["added_stems"].append(stem)
        elif o[3].strip() == p[3].strip():
            st["same"] += 1
            st["same_stems"].append(stem)
        else:
            st["updated"] += 1
            st["updated_stems"].append(stem)
        out.append(p)                       # 有 txt 就以 txt 为准（可能修过错字）

    for stem, o in old.items():
        if stem not in seen:
            st["kept"] += 1
            st["kept_stems"].append(stem)
            out.append(o)

    out.sort(key=lambda x: (x[0], x[2]))
    return out, st


def load_posts_js(path):
    """从旧版 posts.js 读回帖子（window.HAOJIA_POSTS = [...]），转成新的紧凑结构

    旧数据可能来自更早的数据集（比现在 txt/ 里的多），用这个入口可以直接续用，
    不用再费劲把 txt 找齐。
    """
    with open(path, encoding="utf-8") as f:
        src = f.read()
    m = re.search(r"\[\s*\{.*\}\s*\]", src, re.S)
    if not m:
        raise SystemExit(f"没在 {path} 里找到 HAOJIA_POSTS 数组")
    data = json.loads(m.group(0))

    posts, skipped = [], []
    for p in data:
        stem = (p.get("stem") or os.path.splitext(p.get("file") or "")[0] or "").strip()
        date = (p.get("date") or "").strip()
        # 旧数据在生成时已经清过首行标题和空行，这里不要重复清
        text = (p.get("text") or "").replace("\r\n", "\n").strip("\n")
        if not stem or not re.match(r"^\d{4}-\d{2}-\d{2}$", date) or len(text) < 20:
            skipped.append((stem or "（无文件名）", "字段不全或正文太短"))
            continue
        posts.append([date, stem, p.get("platform") or guess_platform(stem), text])
    posts.sort(key=lambda x: (x[0], x[2]))
    return posts, skipped


def report(merge_info, txt_count, old_count):
    if not merge_info:
        return
    st = merge_info
    print(f"  合并：txt {txt_count} 篇（新增 {st['added']} / 更新 {st['updated']} / 未变 {st['same']}）"
          f"＋ data.js 独有保留 {st['kept']} 篇")
    if st["added_stems"]:
        print(f"  [新增] {'、'.join(st['added_stems'])}")
    if st["updated_stems"]:
        print(f"  [更新] {'、'.join(st['updated_stems'])}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="只预览合并计划，不写文件")
    ap.add_argument("--fresh", action="store_true", help="忽略已有 js/data.js，完全按 txt/ 重建")
    ap.add_argument("--from-js", metavar="旧posts.js", help="从旧版 posts.js 重新打包（不读 txt/）")
    a = ap.parse_args()

    merge_info, old_count = None, 0
    if a.from_js:
        posts, skipped = load_posts_js(a.from_js)
        src_desc = a.from_js
    else:
        posts, skipped = collect()
        src_desc = "txt/"
        old_posts = []
        if not a.fresh:
            try:
                old_posts = load_data_js(OUT_JS)
            except Exception as e:
                raise SystemExit(
                    f"读不回已有的 {os.path.basename(OUT_JS)}：{e}\n"
                    f"  为免覆盖掉原有数据，本次没有写文件。确实想只用 txt/ 重建，加 --fresh。")
        old_count = len(old_posts)
        if old_posts:
            posts, merge_info = merge(posts, old_posts)
            src_desc = f"txt/ ＋ 已有 {os.path.basename(OUT_JS)}({old_count} 篇)"

    days = sorted({p[0] for p in posts})

    if a.list:
        if merge_info:
            for s in merge_info["added_stems"]:
                print(f"  [新增] {s}.txt")
            for s in merge_info["updated_stems"]:
                print(f"  [更新] {s}.txt")
        else:
            for p in posts:
                print(f"  {p[1]}.txt  →  {p[0]} {p[2]}  {len(p[3])} 字")
        for s, why in skipped:
            print(f"  [跳过] {s}: {why}")
        print(f"共 {len(posts)} 篇 · {len(days)} 天（来源：{src_desc}）")
        if merge_info:
            report(merge_info, len(posts) - merge_info["kept"], old_count)
        return

    payload, raw_len, comp_len = encode(posts)
    os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write('window.HAOJIA_DATA = "')
        f.write(payload)
        f.write('";\n')

    print(f"已生成 js/data.js（来源 {src_desc}）：{len(posts)} 篇，{len(days)} 天（{days[0]} ~ {days[-1]}）")
    print(f"  明文 {raw_len / 1024:.0f} KB → gzip {comp_len / 1024:.0f} KB "
          f"→ 输出 {os.path.getsize(OUT_JS) / 1024:.0f} KB")
    if merge_info:
        print(f"  其中来自 data.js 的旧帖子 {merge_info['kept']} 篇原样保留")
        report(merge_info, len(posts) - merge_info["kept"], old_count)
    for s, why in skipped:
        print(f"  [跳过] {s}: {why}")


if __name__ == "__main__":
    main()
