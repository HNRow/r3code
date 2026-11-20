# Installed Plugin Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Settings → Plugins 管理 Claude 和 Codex 实例上已安装的插件：查看、启用、停用、卸载。

**Architecture:** 每个 provider 驱动可选地提供 `pluginManagement` 适配器，底下调用 provider 自己的管理接口：Claude 用 `claude plugin … --json`，Codex 用 app-server 的 `plugin/installed`、`plugin/uninstall`、`config/value/write`。服务端 `PluginManager` 负责列清单、比对 revision、按配置目录串行执行、改完刷新 skills 快照。Web 和 Mobile 共用 client-runtime 的推导逻辑。

**Tech Stack:** Effect、Effect Schema、`effect/unstable/rpc`、React（web）、React Native（mobile）、gt-react i18n、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-19-plugin-management-design.md`

## Global Constraints

- 不改写 `settings.json`、`installed_plugins.json`、`config.toml`，不删插件目录。所有改动都通过 provider 自己的 CLI 或 app-server 完成。
- 调 CLI 的参数一律用数组传，不拼 shell 字符串。`pluginId` 必须先在最新清单里找到，才能交给 CLI。
- 启用/停用只写插件的安装范围，不做“仅本项目停用”。
- 卸载：Claude 固定带 `--keep-data`，不带 `--prune`。
- 不做：安装新插件、更新、marketplace 管理、userConfig 配置、MCP 工具、OpenCode 等其他 provider。
- 不能在模块顶层或 layer 构建时调用 gt 的 `t()`，会白屏或断开 /ws。模块级文案用 `msg()`，渲染时再用 `m()`；路由标题照 `settingsSearch.ts` 里现有的 getter 写法。
- 代码注释用中文，默认不写注释。
- 不要 commit。不跑全仓检查。迭代时用 `vp test run <files>`，交付前跑一次 `vp run check:changed`。
- 手动验证用 dev `.t3` 里的配置副本，不要碰真实的 `~/.claude`、`~/.codex`、`~/.t3/userdata`。
- 工作区里已经有未提交的 Skills 管理改动，在它的基础上做。除了 Task 5 的只读原因链接，不改 Skills 的行为。

## Review Focus

1. 旧版 Claude 没有 `plugin list --json`，或者 binary 不存在：该实例显示诊断信息，不能显示成“没有插件”，也不能让整页报错（Task 2 和 Task 4 的测试）。
2. 客户端传来以 `-` 开头、或带空格的 `pluginId`：在 schema 解码时就拒绝，到不了 CLI（Task 1 的测试）。
3. 两台设备用旧 revision 改同一个配置目录：第二个请求返回冲突，不能静默覆盖（Task 4 的测试）。
4. `cwd` 不是已知 workspace：直接拒绝，不能借 project 范围写到任意目录（Task 4 的测试）。
5. Codex app-server 卡住不返回：20 秒后报错，界面不能一直转圈（Task 3 的测试）。

---

### Task 1: Contracts、权限、driver 接口

**Files:**

- Create: `packages/contracts/src/plugins.ts`
- Modify: `packages/contracts/src/index.ts`（导出）
- Modify: `packages/contracts/src/rpc.ts`（在 `WS_METHODS` 的 skills 条目旁加三条；仿照 `WsSkills*Rpc` 写三个 `Rpc.make`；在约第 2332 行把它们加进 group）
- Modify: `packages/contracts/src/clientRpcPermissions.ts`
- Modify: `apps/server/src/auth/RpcAuthorization.ts:70` 附近
- Modify: `apps/server/src/observability/RpcInstrumentation.ts:193` 附近
- Modify: `packages/provider-core/src/server/driver.ts`（`ProviderInstance`）
- Test: `packages/contracts/src/rpc.test.ts`、`apps/server/src/auth/RpcAuthorization.test.ts`（在已有的 skills 用例里加行）

**Interfaces:**

- Produces（`plugins.ts`）：
  - `PluginId = TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._@:/+-]{0,199}$/))`
  - `PluginScope = Schema.Literals(["user", "project", "local", "managed"])`
  - `PluginInventoryEntry`：`{ instanceId, cwd, configHome, pluginId, name, version?, marketplace?, scope, state: "enabled"|"disabled"|"unavailable", components?: { skills?: number; hooks?: boolean; mcpServers?: string[] }, notes: string[], actions: { canSetEnabled, canUninstall, reason? } }`
  - `PluginInstanceInventory`：`{ instanceId, supported: boolean, configHome?: string, revision: string, entries }`
  - `PluginInventory`：`{ checkedAt, instances, diagnostics }`
  - `PluginListInput`：`{ cwd: TrimmedNonEmptyString }`
  - `PluginSetEnabledInput`：`{ instanceId: ProviderInstanceId, cwd, pluginId: PluginId, scope: PluginScope, expectedRevision, enabled: boolean }`
  - `PluginUninstallInput`：同上，去掉 `enabled`
  - `PluginMutationResult`：`{ requiresSessionRestart: true }`
  - 错误类型：
    - `PluginInventoryListError { cwd, cause }`
    - `PluginMutationError { operation: "setEnabled"|"uninstall", instanceId, cwd, pluginId, reason }`，`reason` 取值为 `"unknown-workspace"|"management-unavailable"|"unknown-plugin"|"action-not-allowed"|"provider-failed"`
    - `PluginInventoryConflictError { instanceId, cwd, expectedRevision, actualRevision }`
  - `WS_METHODS.pluginsList = "plugins.list"`、`pluginsSetEnabled = "plugins.setEnabled"`、`pluginsUninstall = "plugins.uninstall"`
- Produces（`driver.ts`）：

  ```ts
  export interface ProviderPluginManagement {
    readonly configHome: string;
    readonly list: (cwd: string) => Effect.Effect<
      {
        readonly entries: ReadonlyArray<PluginInventoryEntry>;
        readonly diagnostics: ReadonlyArray<string>;
      },
      ProviderDriverError
    >;
    readonly setEnabled: (input: {
      readonly cwd: string;
      readonly pluginId: string;
      readonly scope: PluginScope;
      readonly enabled: boolean;
    }) => Effect.Effect<void, ProviderDriverError>;
    readonly uninstall: (input: {
      readonly cwd: string;
      readonly pluginId: string;
      readonly scope: PluginScope;
    }) => Effect.Effect<void, ProviderDriverError>;
  }
  ```

  `ProviderInstance` 新增 `readonly pluginManagement?: ProviderPluginManagement;`

- [ ] **Step 1: 写失败的测试**
  - `rpc.test.ts`：`PluginSetEnabledInput` 能解码 `pluginId: "superpowers@claude-plugins-official"`；`"-rf"`、`"a b"`、`""` 都解码失败。
  - `RpcAuthorization.test.ts` 和 `clientRpcRequiredScopes` 的已有用例里加行：
    - `plugins.list` 需要 `AuthOrchestrationReadScope`；
    - `plugins.setEnabled` / `plugins.uninstall` 在 `scope: "user"` 时需要 `[AuthProvidersManageScope]`，在 `scope: "project"` 或 `"local"` 时需要 `[AuthProvidersManageScope, AuthFilesystemWriteScope]`。
- [ ] **Step 2: 跑测试，确认失败**：`vp test run packages/contracts/src/rpc.test.ts apps/server/src/auth/RpcAuthorization.test.ts`
- [ ] **Step 3: 实现上面 Interfaces 里列的内容**
  - `clientRpcRequiredScopes` 仿照 skills 的 `nativeId.startsWith("project:")` 分支，改成按 `scope` 判断；
  - 两个变更 RPC 加进 `CLIENT_GUARDED_RPC_SCOPES`，值为 `AuthProvidersManageScope`；
  - instrumentation 三条都记 `"provider"`。
- [ ] **Step 4: 跑测试，确认通过**；再在 `packages/contracts` 和 `packages/provider-core` 里分别跑 `vp run typecheck`。

### Task 2: Claude 适配器

**Files:**

- Create: `apps/server/src/provider/Drivers/ClaudePlugins.ts`
- Modify: `apps/server/src/provider/ClaudeProvider.ts:622`（导出 `runClaudeCommand`）
- Modify: `apps/server/src/provider/Drivers/ClaudeDriver.ts:439` 附近（接上 `pluginManagement`）
- Test: `apps/server/src/provider/Drivers/ClaudePlugins.test.ts`

**Interfaces:**

- Consumes：Task 1 的 `ProviderPluginManagement`、`PluginInventoryEntry`；`discoverClaudeSkillInventory`（已有，插件来源的 skill 带 `source.kind === "plugin"`，`containerId` 是插件名）。
- Produces：
  - `type ClaudePluginRun = (args: ReadonlyArray<string>, cwd: string) => Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, ProviderDriverError>`
  - `parseClaudePluginList(stdout: string): ReadonlyArray<ClaudeListedPlugin>`，字段为 `id, version?, scope, enabled, installPath?, mcpServers?, notes?`
  - `claudePluginEntries(input: { listed; pluginSkills: ReadonlyArray<SkillInventoryEntry>; instanceId; cwd; configHome }): ReadonlyArray<PluginInventoryEntry>`
  - `makeClaudePluginManagement(input: { configHome: string; run: ClaudePluginRun; listSkills: (cwd: string) => Effect.Effect<ReadonlyArray<SkillInventoryEntry>, ProviderDriverError>; instanceId: ProviderInstanceId }): ProviderPluginManagement`

- [ ] **Step 1: 写失败的测试**（用假的 `run`，不起真进程）
  - `parses claude plugin list json`：用两条 fixture。
    - `superpowers@claude-plugins-official`（user，enabled，version `7.0.2`）解析成 `name: "superpowers"`、`marketplace: "claude-plugins-official"`、`state: "enabled"`；
    - `caveman@caveman` 带 `notes: ["…"]`，`notes` 原样保留。
  - `counts plugin skills by plugin name`：`pluginSkills` 里有 2 条 `containerId: "superpowers"`，结果 `components.skills === 2`；`mcpServers: ["context7"]` 透传。
  - `managed scope is read-only`：`canSetEnabled` 和 `canUninstall` 都是 false，`reason` 非空。
  - `plugin skills without a CLI entry become read-only entries`：`containerId: "synced-tool"` 不在 CLI 列表里，生成 `pluginId: "synced-tool"`、`actions` 全 false 的条目，reason 为 `"Not managed by claude plugin; manage it at its source."`。
  - `setEnabled passes explicit scope`：`run` 收到的参数是 `["plugin","disable","x@m","--scope","project","--json"]`，cwd 等于输入的 cwd。
  - `uninstall keeps data without pruning`：参数是 `["plugin","uninstall","x@m","--scope","user","--keep-data","--json"]`。
  - `non-zero exit fails`：`run` 返回 `exitCode: 1, stderr: "error: unknown command 'list'"`，`list` 以 `ProviderDriverError` 失败，`detail` 里包含 stderr 的最后一行。
- [ ] **Step 2: 跑测试，确认失败**：`vp test run apps/server/src/provider/Drivers/ClaudePlugins.test.ts`
- [ ] **Step 3: 实现 `ClaudePlugins.ts`**
  - `list` 先 `run(["plugin","list","--json"], cwd)`，再调 `listSkills(cwd)` 统计组件数量。
  - 插件名取 id 里 `@` 前面的部分。
  - 每次 `run` 加 `Effect.timeout("30 seconds")`。
  - 先确认 project/local 范围在其他项目里的安装记录会不会出现在当前 cwd 的列表里：
    - 设置 `CLAUDE_CONFIG_DIR` 指向 `.t3` 下的副本；
    - 在两个临时目录里各用 `--scope project` 装一个插件；
    - 分别在两个目录里看 `list --json` 的输出。
  - 如果会出现，就过滤掉不属于当前 cwd 的条目，否则会把别的项目的插件写进当前项目的 settings；同时补一个测试 `drops project installs of other workspaces`。
- [ ] **Step 4: 在 `ClaudeDriver.ts` 接上**
  - `configHome` 用第 142 行的 `configDir`；
  - `run` 是 `(args, cwd) => runClaudeCommand(effectiveConfig, args, processEnv, cwd)`，映射成 `ProviderDriverError`；
  - `listSkills` 复用 `skillInventory.list` 的那段调用，取 `.entries`。
- [ ] **Step 5: 跑测试，确认通过**；在 `apps/server` 里跑 `vp run typecheck`。

### Task 3: Codex 适配器

**Files:**

- Create: `apps/server/src/provider/Drivers/CodexPlugins.ts`
- Modify: `apps/server/src/provider/Drivers/CodexDriver.ts`（仿照约第 356 行 `consumeResetCredit` 的写法接上 `pluginManagement`）
- Test: `apps/server/src/provider/Drivers/CodexPlugins.test.ts`

**Interfaces:**

- Consumes：Task 1 的接口；`withCodexAppServerClient`（`CodexProvider.ts:641`）；`CodexSchema.V2PluginInstalledResponse`。
- Produces：
  - `type CodexPluginRequest = <M extends "plugin/installed" | "plugin/uninstall" | "config/value/write">(method: M, params: CodexParams[M]) => Effect.Effect<CodexResult[M], ProviderDriverError>`
  - `codexPluginEntries(response: V2PluginInstalledResponse, ctx: { instanceId; cwd; configHome }): ReadonlyArray<PluginInventoryEntry>`
  - `makeCodexPluginManagement(input: { configHome: string; request: CodexPluginRequest; instanceId: ProviderInstanceId }): ProviderPluginManagement`
  - `CODEX_PLUGIN_TIMEOUT = "20 seconds"`，在适配器里对每次 `request` 生效

- [ ] **Step 1: 写失败的测试**（用假的 `request`）
  - `keeps only installed plugins`：两条 summary，一条 `installed: true`、一条 `installed: false`，只剩第一条；`scope === "user"`；`marketplace` 取所在 marketplace 的 `name`。
  - `installed by default can disable but not uninstall`：`installPolicy: "INSTALLED_BY_DEFAULT"` 时 `canSetEnabled: true`、`canUninstall: false`，reason 非空。
  - `workspace setting is read-only`：`installPolicySource: "WORKSPACE_SETTING"` 时两个 action 都是 false。
  - `setEnabled upserts plugins table`：`request` 收到 `("config/value/write", { keyPath: "plugins", mergeStrategy: "upsert", value: { "documents@openai-primary-runtime": { enabled: false } } })`。
  - `uninstall sends plugin id`：`request` 收到 `("plugin/uninstall", { pluginId: "x@m" })`。
  - `times out a hung app-server`：`request` 返回 `Effect.never`；fork `list`，`TestClock.adjust("21 seconds")`，结果是 `ProviderDriverError`。
- [ ] **Step 2: 跑测试，确认失败**：`vp test run apps/server/src/provider/Drivers/CodexPlugins.test.ts`
- [ ] **Step 3: 实现 `CodexPlugins.ts`**；`list` 调 `plugin/installed { cwds: [cwd] }`。
- [ ] **Step 4: 在 `CodexDriver.ts` 接上**
  - `configHome` 用 `homeLayout.sharedHomePath`；
  - `request` 内部用 `withCodexAppServerClient({ binaryPath, homePath, launchArgs, cwd, environment: processEnv })`，加 `Effect.scoped`，提供 `ChildProcessSpawner`。
- [ ] **Step 5: 跑测试，确认通过**；在 `apps/server` 里跑 `vp run typecheck`。
- [ ] **Step 6: 手动确认 upsert 是深合并**
  - 准备一份 `CODEX_HOME` 副本，在某个插件下面手动加一个额外的 key；
  - 用这个副本跑一次 setEnabled；
  - 检查那个额外 key 还在。
  - 如果被覆盖了，改成整张 `plugins.<id>` 表先读后写，并把发现写进交付说明。

### Task 4: PluginManager、ws handler、server layer

**Files:**

- Create: `apps/server/src/provider/PluginManager.ts`
- Modify: `apps/server/src/ws.ts`（约第 1565 行取服务；约第 2646 行加三个 handler；仿照 `toSkillMutationError` 写错误映射）
- Modify: `apps/server/src/server.ts:750` 附近（提供 `PluginManager.layer`）
- Test: `apps/server/src/provider/PluginManager.test.ts`（fake instance registry 的写法照 `SkillManager.test.ts`）

**Interfaces:**

- Consumes：Task 1 的类型；`ProviderInstanceRegistry`（`getInstance` 和实例列表）、`KnownWorkspaces.assertContains`、`ProviderRegistry.refreshWorkspaceSnapshot`、`Digest`。
- Produces：

  ```ts
  class PluginManager extends Context.Service<PluginManager, {
    readonly list: (input: { readonly cwd: string }) => Effect.Effect<PluginInventory>;
    readonly setEnabled: (input: PluginSetEnabledInput) => Effect.Effect<PluginMutationResult, PluginManagerError>;
    readonly uninstall: (input: PluginUninstallInput) => Effect.Effect<PluginMutationResult, PluginManagerError>;
  }>
  ```

  `PluginManagerError` 是服务内部的 tagged error，在 `ws.ts` 里映射成 contracts 的 `PluginMutationError` 或 `PluginInventoryConflictError`。

- [ ] **Step 1: 写失败的测试**（用 fake 适配器）
  - `marks instances without adapter unsupported`：没有 `pluginManagement` 的实例出现在 `instances` 里，`supported: false`、`entries: []`。
  - `list failure becomes a diagnostic`：适配器的 `list` 失败时，该实例 `entries: []`，`diagnostics` 里有一条带 `instanceId` 的信息，其他实例照常返回。
  - `rejects stale revision`：`expectedRevision: "old"` 时返回冲突，适配器的 `setEnabled` 一次都没被调用。
  - `second device with old revision gets conflict`：第一次 setEnabled 成功、清单内容改变后，再用旧 revision 调用，返回冲突。
  - `rejects unknown plugin`：`pluginId` 不在清单里时返回 `reason: "unknown-plugin"`。
  - `rejects disallowed action`：`canUninstall: false` 的条目调 uninstall，返回 `reason: "action-not-allowed"`。
  - `rejects unknown workspace`：`assertContains` 失败时返回 `reason: "unknown-workspace"`。
  - `serializes mutations sharing a configHome`：两个实例 `configHome` 相同；第一个适配器调用阻塞在一个 `Deferred` 上；断言此时第二个调用没开始（计数器还是 1），释放后变成 2。
  - `refreshes every instance sharing the configHome`：改完后，同一 `configHome` 的所有已启用实例都以该 `cwd` 调了 `refreshWorkspaceSnapshot`，其他实例没有。
- [ ] **Step 2: 跑测试，确认失败**：`vp test run apps/server/src/provider/PluginManager.test.ts`
- [ ] **Step 3: 实现 `PluginManager.ts`**
  - revision 是 `sha256` 的十六进制，输入为该实例条目按 `pluginId + scope` 排序后的 `{pluginId, scope, state, actions}` 的 JSON；
  - 每个 `configHome` 一个 `Semaphore(1)`，懒创建；
  - 变更顺序：assertContains → 只重扫目标实例 → 比对 revision → 找条目和检查 action → 拿锁 → 调适配器 → 刷新共用目录的实例。
  - 用 `Effect.fn("PluginManager.list")` 这类命名，给出稳定的 span 名。
- [ ] **Step 4: 接 `ws.ts` 和 `server.ts`**：handler 只做调用服务和映射错误。
- [ ] **Step 5: 跑测试，确认通过**；在 `apps/server` 里跑 `vp run typecheck`。

### Task 5: client-runtime 与 Web 页面

**Files:**

- Create: `packages/client-runtime/src/pluginInventory.ts`、`packages/client-runtime/src/pluginInventory.test.ts`
- Modify: `packages/client-runtime/src/state/server.ts:1396` 附近（加三个 `createEnvironmentRpcCommand`）
- Create: `apps/web/src/routes/_chat.settings.plugins.tsx`（照 `_chat.settings.skills.tsx`）、`apps/web/src/components/settings/PluginsSettings.tsx`
- Modify: `apps/web/src/components/settings/SettingsSidebarNav.tsx:102`（`"/settings/plugins"` 的图标）、`apps/web/src/components/settings/settingsSearch.ts`（第 30 行 route union、第 124 行 label getter、第 198 行 scope map）
- Modify: `apps/web/src/components/settings/SkillsSettings.tsx:481-504` 附近：插件来源 skill 的只读原因旁加一个跳到 `/settings/plugins` 的链接
- Modify: `apps/web/src/i18n/translations/*.json`（9 个语言）

**Interfaces:**

- Consumes：Task 1 的 contracts 和 RPC。
- Produces：
  - `instancesSharingConfigHome(inventory: PluginInventory, instanceId: ProviderInstanceId): ReadonlyArray<ProviderInstanceId>`：不包含自己。
  - `filterPluginEntries(entries: ReadonlyArray<PluginInventoryEntry>, query: string): ReadonlyArray<PluginInventoryEntry>`：在 `name`、`pluginId`、`marketplace` 里做不区分大小写的匹配。
  - `server.ts` 里的 command：`pluginInventory`（`plugins.list`）、`setPluginEnabled`、`uninstallPlugin`。

- [ ] **Step 1: 写失败的测试**（`pluginInventory.test.ts`）
  - 三个实例中 A、B 的 `configHome` 相同：`instancesSharingConfigHome(inv, A)` 等于 `[B]`；C 的结果是 `[]`；没有 `configHome` 的实例结果也是 `[]`。
  - `filterPluginEntries(entries, "SUPER")` 命中 `superpowers@claude-plugins-official`。
- [ ] **Step 2: 跑测试，确认失败，然后实现，再跑一次确认通过**：`vp test run packages/client-runtime/src/pluginInventory.test.ts`
- [ ] **Step 3: 做 `PluginsSettings.tsx`**
  - 布局照设计文档里的草图：项目选择器和刷新按钮；按实例分组，组头显示 `configHome`，以及“也会影响：…”；
  - 每行显示名称、marketplace、版本、范围、组件，再加启用开关和卸载按钮；
  - 只读条目显示 reason；`supported: false` 的实例只占一行“不支持插件管理”；
  - 有 diagnostics 时单独显示，不能和空列表混在一起。
  - 卸载前确认框写明：“R3 里不能重新安装。重新安装：`claude plugin install <id>` / `codex plugin add <id>`”。
  - 改动成功后提示 Restart agent session（照 Skills 页的提示写法）；遇到冲突错误就自动重新拉清单。
  - 按钮是否可用用 command 的 `permissionAtom` 判断。
  - 组件用 `components/ui` 的 variant，不要用 className 改样式。
- [ ] **Step 4: 补翻译**：跑 `vp run i18n:check`，把它报出的新 key 补进 9 个语言的文件，直到检查不再报这次新加的文案。
- [ ] **Step 5: 验证**：在 `apps/web` 里跑 `vp run typecheck`；用 `test-t3-app` 在 dev 实例上走一遍。
  - dev 实例的 Claude `homePath` 和 Codex `homePath` 指向 `.t3` 下面的副本目录。
  - 依次走：停用、启用、卸载、只读条目、不支持的实例。
  - 截图放进交付说明。

### Task 6: Mobile 页面与用户文档

**Files:**

- Create: `apps/mobile/src/features/settings/PluginsSettingsScreen.tsx`（结构照 `SkillsSettingsScreen.tsx`）
- Modify: `apps/mobile/src/Stack.tsx:236` 附近（`SettingsPlugins`，`linking: "settings/plugins"`，`settingsPage(msg("Plugins"))`）
- Modify: `apps/mobile/src/features/settings/SettingsRouteScreen.tsx:279`（在 Skills 后面加 `serverPage("SettingsPlugins", "puzzlepiece.extension", gt("Plugins"))`）
- Modify: `apps/mobile/src/i18n/translations/*.json`（9 个语言）
- Modify: `docs/user/providers-claude.md:106-110`、`docs/user/providers-codex.md`

**Interfaces:**

- Consumes：Task 5 的 `instancesSharingConfigHome`、`filterPluginEntries` 和三个 command。

- [ ] **Step 1: 做 `PluginsSettingsScreen.tsx`**
  - 显示和交互与 Web 一致：分组、开关、卸载确认、只读原因、不支持的实例、diagnostics、重启提示；
  - 推导逻辑只用 client-runtime 里的，不要在 mobile 里另写一份。
- [ ] **Step 2: 补 mobile 翻译**：跑 `vp run i18n:check`，补齐 9 个语言。
- [ ] **Step 3: 写文档**
  - `providers-claude.md`：把“plugins…are read-only here; manage them at their source”改成指向 Settings → Plugins；
  - `providers-claude.md` 和 `providers-codex.md` 各加一小段：能做什么、哪些插件只读、改完要 Restart agent session、R3 里不能安装新插件。
- [ ] **Step 4: 验证**：在 `apps/mobile` 里跑 `vp run typecheck`；用 `test-t3-mobile` 走一遍停用、启用、卸载；最后跑一次 `vp run check:changed`，把输出贴进交付说明。
