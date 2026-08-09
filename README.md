# TampermonkeyScripts

[BlackCCCat/TampermonkeyScripts](https://github.com/BlackCCCat/TampermonkeyScripts) 用于管理个人 Tampermonkey 脚本。

## 哔哩哔哩动态关键字屏蔽

脚本文件：[scripts/bilibili-dynamic-filter.user.js](scripts/bilibili-dynamic-filter.user.js)

支持页面：

- `https://t.bilibili.com/*`
- `https://space.bilibili.com/*/dynamic*`

### 安装与测试

1. 安装浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/)。
2. [点击这里直接安装脚本](https://raw.githubusercontent.com/BlackCCCat/TampermonkeyScripts/main/scripts/bilibili-dynamic-filter.user.js)，或打开 `scripts/bilibili-dynamic-filter.user.js` 后复制全部内容。
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

7. 命中的动态会被隐藏；页面右下角会显示“已屏蔽 N 条动态 · 配置”。

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

自动化测试覆盖规则解析、非法正则、大小写、全局正则重复匹配、转义斜杠和空白归一化。页面 DOM 选择器仍需在已登录的哔哩哔哩页面进行人工验证；如果哔哩哔哩调整页面结构，可更新脚本中的 `CARD_SELECTOR` 和 `CONTENT_SELECTOR`。
