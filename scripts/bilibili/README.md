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

7. 命中的动态会被隐藏；启用状态显示后，页面右下角会显示屏蔽数量和操作按钮。

### 自动更新

- `bilibili-dynamic-filter.meta.js` 只提供版本元数据，Tampermonkey 通过它检查更新；发现新版本后，再从 `bilibili-dynamic-filter.user.js` 下载完整脚本。
- `scripts/bilibili-dynamic-filter.user.js` 是旧版错误更新地址的兼容桥接文件。已经安装旧版本的用户在更新到 `0.2.1` 后，会自动切换到新的元数据地址。
- 如果仍无法检查更新，请确认 Tampermonkey 中该脚本的“检查更新”选项以及扩展的全局更新间隔没有被关闭。

### 状态面板

- 在“配置动态屏蔽规则”中可开启或关闭“在右下角显示过滤状态”。旧版本配置会默认开启此选项。
- “查看屏蔽内容”会在动态流的原位置临时恢复被屏蔽的卡片，并用粉色标记命中的内容；再次点击“恢复屏蔽”即可重新隐藏。
- “配置”按钮会直接打开规则配置弹窗。
- 状态面板只在过滤已启用且至少配置了一条有效规则时显示；即使当前屏蔽数量为零，也会显示运行状态。

### 规则格式

- 每行一条规则，空行会被忽略。
- 普通文本是关键字规则，按包含关系匹配且不区分大小写。
- `/表达式/标志` 是 JavaScript 正则表达式，例如 `/AI\s*培训/i`。
- `#` 开头的行是注释。
- 非法正则会在配置窗口显示行号，修正前不会保存。

脚本会匹配动态正文、转发内容、视频或文章标题及简介。滚动加载的新动态也会自动处理。可以通过 Tampermonkey 菜单中的“启用 / 暂停动态屏蔽”临时切换。

### 本地验证

项目不需要安装第三方依赖，使用 Node.js 运行：

```bash
npm test
npm run check
```

自动化测试覆盖规则解析、非法正则、大小写、全局正则重复匹配、转义斜杠、空白归一化、转发动态文本、旧配置迁移、状态面板显示条件和自动更新元数据链路。页面 DOM 选择器与原位预览仍需在已登录的哔哩哔哩页面进行人工验证；如果哔哩哔哩调整页面结构，可更新脚本中的 `CARD_SELECTOR` 和 `CONTENT_SELECTOR`。
