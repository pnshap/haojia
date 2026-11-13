## 说明

- 整合自小黑盒博主 **笼中雀sama** 每日发布的 NS 卡带 / PS 光盘好价帖；本项目不提供任何网络抓包爬虫脚本或工具，只提供静态页面展示。
- 价格均为帖子原文标注，仅作比价参考，不构成购买建议；实际成交以商家为准。
- **精力有限，数据不可能能够随时更新，想要第一时间获得好价推荐请关注 @笼中雀sama喵，关注 @笼中雀sama 谢谢喵。**
- 若您想帮忙每日更新数据，或是对项目有改进更新建议，欢迎提交 Issue 或直接 Pull requests。

## 使用方式

先把帖子正文保存成文本文件，文件名形如：

```
11.10｜Switch好价卡带.txt
11.10｜Ps好价光盘.txt
```

### 1、临时导入数据

点击页面右上角的 **「导入 txt 文件夹」** 按钮，选择 txt 所在的文件夹，浏览器会解析并**按增量并入**现有数据，只留在本页内存里：

- 刷新页面即恢复内置数据；

### 2、生成静态页面

```bash
git clone  https://github.com/pnshap/haojia.git
cd haojia

# txt 放进 txt/ 目录后
python3 build.py

# 直接用浏览器打开 index.html 
```


常用参数：

```bash
python3 build.py            # 合并并写入 js/data.js
python3 build.py --list     # 只打印合并计划（会列出 [新增] / [更新] 的文件名），不写文件
python3 build.py --fresh    # 忽略已有 data.js，完全按 txt/ 重建
```

