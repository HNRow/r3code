# R3 Rebrand Design

## Context

R3 Code 的所有客户端（Web、Desktop、Mobile）和营销站点目前都显示 “R3 Code”。用户要求把品牌展示统一改为 “R3 Code”，但不改动代码中的标识符、协议名、包名、bundle ID、URL scheme、环境变量和本地存储键。

已确认：

- 方案 A：只改用户可见的品牌展示。
- 字形处理：简单把 SVG 中的 “T3” 字形替换为 “R3”，不做全新视觉设计。
- 落地方式：混合式（脚本批量替换用户可见文本 + 手动改 SVG 字形 + 重新生成图标）。

## Approach

采用**混合式 rebranding**：

1. 用脚本批量替换用户可见文本 `"R3 Code"` → `"R3 Code"`。
2. 手动修改 SVG 字形文件，把 “T” 换成 “R”、保留 “3”。
3. 更新 manifest、title、branding 常量、安装素材文案。
4. 用现有脚本重新生成各平台图标。
5. 运行 i18n:check、typecheck 和相关测试，确保没有破坏。

## Scope

### 必须修改

**文本与品牌名**

- 所有用户可见的 `"R3 Code"` 字符串（UI 文案、HTML title、CLI 帮助、About 窗口、空状态、设置页）。
- 营销站点文案（`apps/marketing/src/pages/*.astro`、`apps/marketing/src/i18n/*.ts`）。
- 用户文档（`docs/user/*.md`、`docs/README.md`）。
- i18n 翻译文件中的 `"R3 Code"`（`apps/web/src/i18n/translations/*.json`、`apps/mobile/src/i18n/translations/*.json`）。

**配置与常量**

- `apps/web/src/branding.ts` 中的 `APP_BASE_NAME`。
- `apps/web/public/manifest.webmanifest` 的 `name` / `short_name`。
- `apps/web/index.html` 的 `<title>`。
- `apps/web/vite.config.ts` 的 `bootstrapTitlePlugin`。
- `apps/desktop/package.json` 的 `productName`。
- `apps/desktop/src/app/DesktopEnvironment.ts` 的 `APP_BASE_NAME`。
- `apps/desktop/src/app/DesktopAppIdentity.ts` 的 About / User-Agent 名称。
- `apps/desktop/resources/linux/com.t3tools.t3code.metainfo.xml` 的应用名、summary、homepage。
- `apps/desktop/resources/dmg/dmg-background-*.svg` 的提示文字。
- `apps/desktop/resources/installer.nsh` 的提示文字。

**SVG 字形**

- `apps/web/src/components/T3Wordmark.tsx`。
- `apps/mobile/src/components/T3Wordmark.tsx`。
- `apps/mobile/assets/widget/T3Mark.svg`。
- `assets/prod/logo.svg`。
- `assets/{dev,nightly,prod}/app-icon.icon/Assets/text.svg`。

**图标生成**

- 运行 `vp run icons:export` 生成 macOS / Windows / Web 图标。
- 运行 `vp run icons:export:android` 生成 Android 图标与 splash。
- 运行 `vp run apply-web-brand-assets` 把 Web 图标复制到 `apps/web/public`。

### 明确不改

- 包名：`@t3tools/*`、`oxlint-plugin-t3code`。
- 环境变量：`T3CODE_*`、`VITE_T3CODE_*`。
- URL scheme：`t3code://`、`t3code-dev://`。
- Bundle ID / package：`com.t3tools.t3code`、`com.t3tools.t3code.dev` 等。
- 本地存储键：`t3code:theme`、`t3code:themes:v1` 等。
- 域名：`app.t3.codes`、`clerk.t3.codes`。
- 内部模块名：`t3-terminal`、`t3-widget-expiry` 等。
- Vite 插件名：`t3code:bootstrap-title` 等。

## Risks & Mitigations

| 风险                             | 缓解措施                                                         |
| -------------------------------- | ---------------------------------------------------------------- |
| 批量替换误伤代码标识符           | 替换时只针对用户可见字符串，排除代码变量/常量名；diff 后人工抽查 |
| SVG 字形改后不美观               | 采用简单 “T→R” 替换，保留原有 “3” 和排版；生成后截图检查         |
| 测试 fixture 断言 “R3 Code” 失败 | 运行相关测试并同步更新 fixture                                   |
| 原生图标生成失败                 | 使用现有脚本；若失败则回退到手动替换已有 PNG                     |
| i18n 结构破坏                    | 替换只改值，不改 key 和插值结构；跑 `vp run i18n:check`          |
| 中文/其他语言翻译中的品牌名      | 统一替换为 `"R3 Code"`，不翻译为其他形式                         |

## Validation

1. `vp run i18n:check` — 确保翻译目录与源码一致。
2. `vp run typecheck`（受影响包）— 确保 TS 无错误。
3. `vp test run`（相关测试文件）— 确保 fixture 和断言通过。
4. 启动 dev server，用浏览器验证：
   - 页面标题显示 “R3 Code”。
   - 主 logo/wordmark 显示 “R3”。
   - Settings / About / 空状态等高频页面品牌名一致。
5. 抽查生成的图标：
   - `apps/web/public/icon-512x512.png`
   - `apps/mobile/assets/android-icon-foreground.png`
   - `assets/prod/black-macos-1024.png`

## Assumptions

- 用户接受简单 “T3 → R3” 字形替换，不要求全新设计。
- 用户接受同时更新用户文档和营销站点。
- 不改动任何会影响协议兼容性、已安装应用标识或 CI/CD 的标识符。
- 原生图标生成脚本在当前 macOS 环境可用；若不可用，则手动替换关键 PNG。
