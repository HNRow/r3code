# Grok 插件管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Settings → Plugins 能列出、启用、停用、卸载 Grok CLI 装的插件。

**Architecture:** 结构同 Claude 适配器（`apps/server/src/provider/Drivers/ClaudePlugins.ts`）：一个纯逻辑适配器加注入的 `run`。列表合并两条 CLI 输出：`grok inspect --json` 给生效状态和组件数，`grok plugin list --json` 判断哪些插件由 Grok 自己安装、可以改，并给出版本和来源。改动直接调 `grok plugin …`。`PluginManager`、契约、Web、Mobile 都不用改。

**Tech Stack:** Effect、`spawnAndCollect`（`@t3tools/provider-core/server/snapshotProbe`）、`resolveSpawnCommand`（`@t3tools/shared/shell`）。

**Spec:** `docs/superpowers/specs/2026-11-19-plugin-management-design.md`（Claude/Codex 版已实现）。下面的 Grok CLI 事实是 2026-11-19 在 Grok 1.0.89 上用配置副本实测的。

## Global Constraints

- `grok inspect --json`（受 cwd 影响）的 `plugins[]` 每项为 `{name, scope, path, enabled, trusted, provides:{skills, agents, hooks, mcpServers}}`。
  - 列表里还包括 Grok 从 `~/.claude/plugins/…` 加载的 Claude Code 插件。
  - `enabled` 是真实的生效状态。
- `grok plugin list --json` 返回 `[{status, name, repo_key, version|null, path, source, marketplace}]`，只含 Grok 自己装的插件。
  - `status` 停用后仍是 `"installed"`，不能用来判断启用状态。
- `grok plugin enable <name>` 和 `grok plugin disable <name>` 改的是 `$GROK_HOME/config.toml` 的 `[plugins] enabled/disabled`，重复执行仍返回 0。
- `grok plugin uninstall <name> --keep-data`：不传 `--confirm`，stdin 关闭。多插件仓库需要确认时会失败，不会顺带删掉别的插件。
- 失败时退出码非 0，输出形如 `Error: Plugin "nope" not found.` 加一行提示。
- 对 Claude 来源的插件执行 enable、disable、uninstall 都会报 not found，所以这类插件只读。
- 没有范围参数；带 `GROK_HOME` 时插件命令只读写该目录，不需要也不会起 leader（已实测）。
- 所有 Grok 插件命令的 env 都用 `grokProbeEnvironment(processEnv)`，它会关掉自动更新。
- `configHome`：`processEnv.GROK_HOME?.trim()` 有值就用它，否则用 `<home>/.grok`（同 `usage.ts:207`），解析成绝对路径。
- 可改的判定：inspect 条目的 `path` 去掉末尾 `/` 后，等于某个 `plugin list` 条目的 `path`。
- 只读原因文案：
  - path 含 `/.claude/` 时：`Loaded from Claude Code; manage it in Claude Code.`
  - 其余：`Not installed by \`grok plugin\`; manage it at its source.`
  - 与别的已装插件共用同一个 `repo_key` 时，只是不可卸载：`Installed together with other plugins; uninstall it with \`grok plugin uninstall\`.`
- 每条命令超时 `"30 seconds"`，写法同 `ClaudePlugins.ts:167-189`。
- 不直接读写 `config.toml` 和 `registry.json`；CLI 参数一律用数组。
- server 端文案用英文，代码注释用中文。
- 不 commit；不跑全仓检查；不碰真实的 `~/.grok`。实测只用仓库 `.t3/` 下的副本，副本 `installed-plugins/registry.json` 里的路径必须改写到副本目录，验完删除。
- 排在 Kimi 计划（`2026-11-19-kimi-plugin-management.md`）之后做。两者互不依赖，但都会改 Settings → Plugins 的手动验证环境，不要同时开两个 dev server。

## Review Focus

1. Grok 也加载了 Claude 插件：这些行只读，并写明去 Claude 那边管，不能出现可点的按钮 → Task 1 `keeps Claude-sourced plugins read-only`。
2. 停用后 `plugin list` 仍显示 `installed`：状态必须取自 inspect，不能显示成"已启用" → Task 1 `takes the enabled state from inspect`。
3. 多插件仓库里的一个插件：不能一键卸掉整个仓库 → Task 1 `blocks uninstall for plugins sharing a repo`。
4. 旧版 Grok 没有 `plugin` 子命令，或 inspect 输出格式不对：页面显示 "Scan failed: …"，不能显示成空列表 → Task 1 `fails the list when a grok command fails`。
5. 命令卡住：30 秒超时 → Task 1 `times out a hung grok command`。

---

### Task 1: Grok 插件适配器（纯逻辑 + 测试）

**Files:**

- Create: `packages/provider-grok/src/server/plugins.ts`
- Test: `packages/provider-grok/src/server/plugins.test.ts`

**Interfaces:**

- Consumes: `ProviderPluginManagement`（`@t3tools/provider-core/server/driver`）、`ProviderDriverError`（`@t3tools/provider-core/server/errors`）、`PluginInventoryEntry`（`@t3tools/contracts`）。
- Produces:
  - `export type GrokPluginRun = (args: ReadonlyArray<string>, cwd: string) => Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, ProviderDriverError>`
  - `export function grokPluginEntries(input: { readonly inspected: ReadonlyArray<GrokInspectedPlugin>; readonly installed: ReadonlyArray<GrokInstalledPlugin>; readonly instanceId: ProviderInstanceId; readonly cwd: string; readonly configHome: string }): ReadonlyArray<PluginInventoryEntry>`，其中两个类型是对应 JSON 的 Schema 解码类型。
  - `export function makeGrokPluginManagement(input: { readonly configHome: string; readonly instanceId: ProviderInstanceId; readonly run: GrokPluginRun }): ProviderPluginManagement`

- [ ] **Step 1: 写失败测试**（假 `run` 按 args 返回预设输出，并记录调用）

样本取自实测：

- `installed` 为 `superpowers`（version `"6.4.2"`，repo_key `"superpowers-21e2a56d"`，marketplace `"xAI Official"`）和 `pstack`（version `null`，repo_key `"plugins-git-pstack-87940968"`）。两者的 path 都在 `/g/installed-plugins/…` 下。
- `inspected` 里有：
  - 这两项，`superpowers` 的 `enabled: false`；
  - `{ name: "caveman", scope: "user", path: "/u/.claude/plugins/marketplaces/caveman/plugins/caveman", enabled: true, provides: { skills: 6, agents: 3, hooks: false, mcpServers: 0 } }`。

- `maps Grok plugins to inventory entries`：`superpowers` 的
  - `pluginId` 为 `"superpowers"`、`version` 为 `"6.4.2"`、`marketplace` 为 `"xAI Official"`、`scope` 为 `"user"`；
  - `components` 为 `{ skills: <provides.skills> }`（skills 为 0 时不带 `components`）；
  - `actions` 为 `{ canSetEnabled: true, canUninstall: true }`。

  `pstack` 没有 `version`。

- `takes the enabled state from inspect`：`superpowers` 的 `state` 为 `"disabled"`（`plugin list` 里它是 `"installed"`）。
- `keeps Claude-sourced plugins read-only`：`caveman` 的 `actions` 等于 `{ canSetEnabled: false, canUninstall: false, reason: "Loaded from Claude Code; manage it in Claude Code." }`，`components` 为 `{ skills: 6 }`。
- `blocks uninstall for plugins sharing a repo`：再加一个与 `pstack` 同 `repo_key` 的已装插件 `other`，两者都是 `canSetEnabled: true`、`canUninstall: false`，reason 为共用仓库那条文案。
- `runs grok plugin commands with array args`：
  - `setEnabled(true)` 的 args 为 `["plugin", "enable", "superpowers"]`；
  - `setEnabled(false)` 为 `["plugin", "disable", "superpowers"]`；
  - `uninstall` 为 `["plugin", "uninstall", "superpowers", "--keep-data"]`；
  - `list` 调用了 `["inspect", "--json"]` 和 `["plugin", "list", "--json"]`；
  - 每次调用的 cwd 都是传入的 cwd。
- `reports Grok's error line`：exitCode 1、输出 `Error: Plugin "nope" not found.\nRun \`grok plugin list\` to see installed plugins.` 时，`detail === 'Plugin "nope" not found.'`。错误行在 stderr 和 stdout 都要找，stderr 优先。
- `fails the list when a grok command fails`：`plugin list` 退出码非 0，或 inspect 输出不是合法 JSON 时，`list` 以 `ProviderDriverError` 失败，不返回空列表。
- `times out a hung grok command`：`run` 返回 `Effect.never`，`TestClock.adjust("30 seconds")` 后失败，`detail` 含 `timed out`。

- [ ] **Step 2: 跑测试确认失败**

Run: `vp test run packages/provider-grok/src/server/plugins.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `plugins.ts`**

- 两条 JSON 都用 Schema 解码，未知字段忽略。
- inspect 的 `scope` 为 `"project"` 时映射成 `"project"`，其余都映射成 `"user"`。
- `name` 与 `pluginId` 都用 inspect 的 `name`。

- [ ] **Step 4: 跑测试确认通过**

Run: `vp test run packages/provider-grok/src/server/plugins.test.ts`
Expected: 8 passed

---

### Task 2: 驱动接线、手动验证、文档

**Files:**

- Modify: `packages/provider-grok/src/server/driver.ts:285-298`（返回的实例里加 `pluginManagement`）
- Modify: `docs/user/` 里 Grok 的用户文档（先 `grep -ril grok docs/user` 找到所在页面，没有专页就写进 `docs/user/providers-acp.md`）

**Interfaces:**

- Consumes: Task 1 的 `makeGrokPluginManagement`、`GrokPluginRun`。
- Produces: Grok 实例的 `pluginManagement`。

- [ ] **Step 1: 驱动接线**

在 `driver.ts` 返回的实例里加 `pluginManagement: makeGrokPluginManagement({ configHome, instanceId, run })`：

- `configHome` 按 Global Constraints 计算。
- `run` 的写法照 `skills.ts:89-119` 的 `discoverGrokSkills`：
  - 命令 `effectiveConfig.binaryPath || "grok"`，经 `resolveSpawnCommand`；
  - env 为 `grokProbeEnvironment(processEnv)`，cwd 为传入的 cwd；
  - 用 `spawnAndCollect` 收集输出，提供 `spawner`；
  - 映射成 `{ stdout, stderr, exitCode }`，spawn 失败映射成 `ProviderDriverError`。

- [ ] **Step 2: 类型检查与测试**

Run: `vp run typecheck`，以及 `vp test run packages/provider-grok/src/server/plugins.test.ts packages/provider-grok/src/server/driver.test.ts packages/provider-grok/src/server/skills.test.ts`
Expected: 全部通过

- [ ] **Step 3: 手动验证（只用副本）**

1. 建副本：
   ```bash
   mkdir -p .t3/grok-plugin-home && cp -R ~/.grok/installed-plugins ~/.grok/config.toml .t3/grok-plugin-home/
   sed -i '' "s#$HOME/.grok#$PWD/.t3/grok-plugin-home#g" .t3/grok-plugin-home/installed-plugins/registry.json
   grep -c "$HOME/.grok" .t3/grok-plugin-home/installed-plugins/registry.json   # 必须是 0
   shasum ~/.grok/config.toml > .t3/grok-real.sum
   ```
   不拷 `auth.json`，插件命令不需要登录。
2. 在仓库 `.t3/userdata/settings.json` 的 Grok 实例环境变量里加 `GROK_HOME=<绝对路径>/.t3/grok-plugin-home`。
3. `vp run dev`，打开 Settings → Plugins，Grok 段应显示：
   - `superpowers`、`pstack`、`modern-web-guidance` 三项可操作，带版本和 `xAI Official`；
   - Claude 来源的插件只读，提示去 Claude Code 管。
4. 停用 `superpowers`：页面显示为已停用，副本 `config.toml` 出现 `disabled = ["superpowers"]`。再启用，应恢复。
5. 卸载 `modern-web-guidance`：从列表消失，副本 `installed-plugins/` 下不再有它的记录。
6. `shasum -c .t3/grok-real.sum` 应为 OK，`ls ~/.grok/installed-plugins` 应与验证前一致。
7. 清理：用 harness 停 dev server，删除 `.t3/grok-plugin-home` 和 `.t3/grok-real.sum`，去掉第 2 步加的环境变量。

- [ ] **Step 4: 文档**

在 Grok 的用户文档里加：

```markdown
## Manage Grok plugins

**Settings → Plugins** lists the plugins Grok loads and lets you enable,
disable, or uninstall the ones `grok plugin` installed. Plugins Grok picks up
from Claude Code are shown read-only; manage them under Claude Code. Install
new plugins with `grok plugin install`. Changes reach the next agent session,
so use **Restart agent session** in the command palette afterwards.
```

- [ ] **Step 5: 变更检查**

Run: `vp run check:changed`
Expected: 本次改动的文件没有新增失败。之前就失败的项（品牌 i18n 那批）照常列出，并在报告里说明。
