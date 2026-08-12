# TampermonkeyScripts

[BlackCCCat/TampermonkeyScripts](https://github.com/BlackCCCat/TampermonkeyScripts) 用于管理个人 Tampermonkey 脚本。

## 哔哩哔哩动态关键字屏蔽

脚本文件：[bilibili-dynamic-filter.user.js](bilibili-dynamic-filter.user.js)

支持页面：

- `https://t.bilibili.com/*`
- `https://space.bilibili.com/*/dynamic*`

### 安装与测试

1. 安装浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/)。
2. [点击这里直接安装脚本](https://raw.githubusercontent.com/BlackCCCat/TampermonkeyScripts/refs/heads/main/scripts/bilibili/bilibili-dynamic-filter.user.js)，或打开 `scripts/bilibili/bilibili-dynamic-filter.user.js` 后复制全部内容。
3. 如果采用复制方式，请在 Tampermonkey 中新建脚本，替换编辑器内容并保存。
4. 打开或刷新哔哩哔哩动态页面。
5. 点击浏览器工具栏中的 Tampermonkey 图标，选择“配置动态屏蔽规则”。
6. 输入规则并保存，例如：

   ```text
   广告
   带货
   /抽奖|推广/i
   # 以井号开头的行是注释
   ```

7. 命中的动态会被隐藏；启用状态显示后，页面右下角会显示屏蔽总数、视频命中数和操作按钮。

### 自动更新

- `bilibili-dynamic-filter.meta.js` 只提供版本元数据，Tampermonkey 通过它检查更新；发现新版本后，再从 `bilibili-dynamic-filter.user.js` 下载完整脚本。
- 如果仍无法检查更新，请确认 Tampermonkey 中该脚本的“检查更新”选项以及扩展的全局更新间隔没有被关闭。

### 状态面板

- 在“配置动态屏蔽规则”中可开启或关闭“在右下角显示过滤状态”。旧版本配置会默认开启此选项。
- “过滤视频动态”默认开启；关闭后，命中规则的视频动态会保留显示，但仍计入“视频命中”数量并标注为“未过滤”。
- “查看全部”会在动态流原位置临时恢复所有被屏蔽的卡片，但不会滚动或跳转页面；再次点击“恢复屏蔽”即可重新隐藏。
- 存在被屏蔽的视频动态时会显示“仅看视频”按钮，只恢复视频卡片并用蓝色标记；没有被屏蔽的视频时自动隐藏该按钮。
- 保存配置时会等待 Tampermonkey Storage 确认写入完成，成功后才重新过滤并关闭配置窗口；写入失败时保留窗口并显示错误。
- “配置”按钮会直接打开规则配置弹窗。
- 展开状态下可按住统计标题行任意拖动；点击右上角“−”可缩成仅显示两个数字的迷你面板，粉色代表已屏蔽动态数，蓝色代表视频命中数。
- 迷你面板单击后恢复完整样式，也可以直接拖动；拖动位置和缩小状态会单独保存在 Tampermonkey Storage 中，刷新页面后继续沿用。
- 状态面板只在过滤已启用且至少配置了一条有效规则时显示；即使当前屏蔽数量为零，也会显示运行状态。

### 规则格式

- 每行一条规则，空行会被忽略。
- 普通文本是关键字规则，按包含关系匹配且不区分大小写。
- `/表达式/标志` 是 JavaScript 正则表达式，例如 `/AI\s*培训/i`。
- `#` 开头的行是注释。
- 非法正则会在配置窗口显示行号，修正前不会保存。

脚本会匹配动态正文、转发内容、视频或文章标题及简介。滚动加载的新动态也会自动处理。可以通过 Tampermonkey 菜单中的“启用 / 暂停动态屏蔽”临时切换。

### 配置存储

- 保存配置时，脚本会先写入 Tampermonkey Storage，再立即回读比对；只有校验成功才会关闭配置弹窗并重新过滤。
- 状态面板的位置和缩小状态也会在操作后立即写入并回读校验，使用独立的 `bilibili-dynamic-filter:ui:v1` 存储项，不会改动过滤规则配置。
- 写入或回读失败时，配置弹窗会保留并显示错误，不会用未持久化的配置继续运行。
- Tampermonkey 的 Storage 编辑器不是实时监视器。如果编辑器仍显示旧值，请点击 Storage 页中的“Reload / 重新加载”；脚本端的回读校验不依赖该页面是否刷新。

### 本地验证

项目不需要安装第三方依赖，使用 Node.js 运行：

```bash
npm test
npm run check
```

自动化测试覆盖规则解析、非法正则、大小写、全局正则重复匹配、转义斜杠、空白归一化、转发动态文本、视频分类与过滤开关、Storage 写入回读、旧配置迁移、状态面板位置约束、拖动判定、显示条件和自动更新元数据链路。页面 DOM 选择器、拖动交互与原位预览仍需在已登录的哔哩哔哩页面进行人工验证；如果哔哩哔哩调整页面结构，可更新脚本中的 `CARD_SELECTOR`、`CONTENT_SELECTOR` 和 `VIDEO_SELECTOR`。
