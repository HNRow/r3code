# Installed Plugin Management Design

## Context

Skills 统一管理已完成，但插件本身不能管理：插件贡献的 skills 在 Settings → Skills 里一律只读（`SkillInventoryService.ts` 的 `isReadOnlySource`），也没有插件级 RPC。用户本机 Claude 装了 16 个插件、Codex 装了 21 个，目前只能回到各自 CLI 里开关或卸载。

用户的诉求是“管好已经装了的”插件：在 R3 里看清每个 provider 实例装了什么，能启用、停用、卸载。不在 R3 里浏览市场或装新插件。

## Goals

- Settings 新增 **Plugins** 页（Web、Desktop、Mobile），按 environment → provider 实例 → 项目查看已安装插件。
- 每个插件展示：名称、id、版本、来源 marketplace、安装范围（user / project / local / managed）、启用状态、包含的组件（skills、hooks、MCP servers 等能拿到的部分）。
- 支持启用、停用、卸载；不能操作的条目显示原因。
- 覆盖 Claude 和 Codex 两类 provider；其他 provider 在页面上标“不支持插件管理”。
- 改动后刷新该实例的 skills 快照（`$` 菜单与 Skills 页同步更新），并提示 Restart agent session。

## Non-Goals

- 不做市场浏览、安装新插件、添加/删除 marketplace。
- 不做插件更新（update 会拉取新的第三方代码，并可能要求人工确认 marketplace 声明的命令）；留给 CLI。
- 不做插件 userConfig 配置（`claude plugin configure`）。
- 不改 Claude 同步插件（claude.ai 账号下发）、managed 策略插件、`CLAUDE_CODE_PLUGIN_DIRS` 内联插件、`@skills-dir` 插件。
- 不支持 OpenCode、Cursor、Pi 等其他 provider。
- 不给 agent 暴露 MCP 工具（agent 改自己的插件风险高，且现有 Skills 管理也没有暴露）。

## Anti-Goals

- R3 自己改写 `settings.json`、`installed_plugins.json`、`config.toml` 或删除插件缓存目录。
- 把命令行参数拼成 shell 字符串，或把客户端传来的任意字符串直接交给 CLI。
- 列表扫描失败时显示成“没有插件”。

## Constraints

- Provider 原生配置是唯一事实来源，R3 不存插件状态，不加 SQLite 表。
- 多个 provider 实例可能共用同一个配置目录：Claude 按 `CLAUDE_CONFIG_DIR`（实例 `homePath`），Codex 的 shadow home 会把 `config.toml` 和 `plugins/` 软链到共享 home（`CodexHomeLayout.ts`，只有 `auth.json` 等是私有的）。一次改动会影响所有共用这个目录的实例。
- Remote ready：操作在 environment 的服务端执行，远程浏览器和手机通过 RPC 调用，不能依赖本机路径。
- 改动在下次 agent session 才生效，正在跑的 session 不受影响。

## Approaches

1. **调用 provider 自己的管理接口（已选）**：Claude 走 `claude plugin … --json`，Codex 走 app-server 的 `plugin/installed`、`plugin/uninstall`、`config/value/write`。优先级、托管策略、卸载清理都由 provider 负责；代价是每次操作起一次子进程（约 1 秒），依赖 CLI 的 JSON 输出。
2. **R3 直接改配置文件**：省子进程，但要重写优先级和卸载语义，还要改 JSONC/TOML，Skills 设计已明确禁止；格式一变就坏。否决。
3. **挂在 Skills 页按插件分组**：复用 `containerId`，但 hooks、MCP、命令、agent 在 Skills 页看不到，没 skill 的 Codex 插件会隐身。否决。

## Design

### 1. Contracts（`packages/contracts/src/plugins.ts`）

结构仿照 `skills.ts`：

```ts
interface PluginInventoryEntry {
  instanceId: ProviderInstanceId;
  cwd: string;
  configHome: string; // 共用同一配置目录的实例取值相同，UI 据此提示影响范围
  pluginId: string; // provider 原生 id，如 "superpowers@claude-plugins-official"
  name: string;
  version?: string;
  marketplace?: string;
  scope: "user" | "project" | "local" | "managed";
  state: "enabled" | "disabled" | "unavailable";
  components?: { skills?: number; hooks?: boolean; mcpServers?: ReadonlyArray<string> };
  notes: ReadonlyArray<string>; // CLI 给出的 notes，原样展示
  actions: { canSetEnabled: boolean; canUninstall: boolean; reason?: string };
}

interface PluginInstanceInventory {
  instanceId: ProviderInstanceId;
  supported: boolean; // 没有 pluginManagement 的实例为 false，entries 为空
  configHome?: string;
  revision: string; // 本实例条目的摘要；变更只重扫这一个实例来比对
  entries: ReadonlyArray<PluginInventoryEntry>;
}

interface PluginInventory {
  checkedAt: string;
  instances: ReadonlyArray<PluginInstanceInventory>;
  diagnostics: ReadonlyArray<string>;
}
```

revision 按实例算，变更时只需重扫目标实例（每次扫描都要起子进程，不能每次改动把所有实例都扫一遍）。

RPC（`rpc.ts`）：`plugins.list`、`plugins.setEnabled`、`plugins.uninstall`。变更输入：`instanceId / cwd / pluginId / scope / expectedRevision`（setEnabled 另加 `enabled`）。返回 `{ requiresSessionRestart: true }`。错误：`PluginMutationError`（带 `reason`）、`PluginInventoryConflictError`。两个变更 RPC 加进 `CLIENT_GUARDED_RPC_SCOPES`，权限用 `AuthProvidersManageScope`，与 skills 一致。

### 2. Driver adapter（`packages/provider-core/src/server/driver.ts`）

`ProviderInstance` 新增可选：

```ts
readonly pluginManagement?: {
  readonly configHome: string;
  readonly list: (cwd: string) => Effect<{ entries; diagnostics }, ProviderDriverError>;
  readonly setEnabled: (input: { cwd; pluginId; scope; enabled }) => Effect<void, ProviderDriverError>;
  readonly uninstall: (input: { cwd; pluginId; scope }) => Effect<void, ProviderDriverError>;
};
```

没有这个字段的实例在清单里标 `supported: false`。

### 3. Claude（`apps/server/src/provider/Drivers/ClaudePlugins.ts`，在 `ClaudeDriver.ts` 里接上）

- 复用 `runClaudeCommand`，带实例自己的 binary、合并后的进程环境（含 `CLAUDE_CONFIG_DIR`），cwd 设为所选项目。参数用数组传，不经过 shell。
- 列表：`claude plugin list --json`。字段已核实：`id`、`version`、`scope`、`enabled`、`projectEnabled`、`installPath`、`mcpServers`、`notes`。
- 启用/停用：`claude plugin enable|disable <id> --scope <scope> --json`，scope 显式传条目的安装范围，不用 CLI 的 auto-detect。
- 卸载：`claude plugin uninstall <id> --scope <scope> --keep-data --json`。默认保留插件数据目录，也不带 `--prune`（依赖清理留给 `claude plugin prune`）。
- 只读：`managed` 范围；R3 已能识别、但 CLI 列表里没有的同步插件、内联插件和 `@skills-dir` 插件（来源见 `ClaudeSkills.ts`）。显示为只读，并写明在哪里管理。
- 组件：skills 数量可从现有 Claude skill 扫描结果按插件前缀统计；hooks/commands 可读 `installPath` 下的 manifest。拿不到就不显示，不额外起进程。

### 4. Codex（`apps/server/src/provider/Drivers/CodexPlugins.ts`，在 `CodexDriver.ts` 里接上）

- 复用 `withCodexAppServerClient`（参照 `CodexDriver.ts` 的 `consumeResetCredit`）。用短生命周期 client，给超时。
- 列表：`plugin/installed`，`cwds: [cwd]`。取 `installed === true` 的条目，用 `enabled`、`id`、`installPolicy`、`installPolicySource`、`source`。
- 启用/停用：`config/value/write { keyPath: "plugins", mergeStrategy: "upsert", value: { [id]: { enabled } } }`。这样插件 id 不用放进 keyPath，避开 `@` 和 `.` 的转义问题；并发冲突由 `PluginManager` 的 revision 负责。
- 卸载：`plugin/uninstall { pluginId }`。
- 只读：`installPolicySource === "WORKSPACE_SETTING"` 的由工作区管理员控制，全部只读。`installPolicy === "INSTALLED_BY_DEFAULT"` 的可以停用，但不能卸载（卸了会被装回来）。

### 5. 服务端 `PluginManager`（`apps/server/src/provider/PluginManager.ts`）

一个服务同时管列表和变更（不像 Skills 拆成两个服务，因为插件没有文件事务）：

- `list(cwd)`：遍历已启用的实例，有 adapter 的调 `list`，失败记入 diagnostics；没有 adapter 的标 `supported: false`。每个实例各算一个 `revision`。
- 变更流程：
  1. 重新列出该实例的插件，比对 `expectedRevision`，不一致就返回冲突；
  2. 确认 `pluginId` 和 `scope` 在最新列表里存在，且对应 action 允许；
  3. 按 `configHome` 加互斥锁，串行执行；
  4. 调 adapter；
  5. 对所有共用该 `configHome` 的实例调 `ProviderRegistry` 刷新 skills 快照；
  6. 返回 `requiresSessionRestart`。
- `ws.ts` 只做解码、调一个服务方法、映射错误。

### 6. 客户端

- `packages/client-runtime/src/pluginInventory.ts`：分组（environment → 实例 → scope）、搜索、按 `configHome` 找出受影响实例，Web 和 Mobile 共用。
- Web：`routes/_chat.settings.plugins.tsx` 和 `components/settings/PluginsSettings.tsx`；在 `settingsSearch.ts` 里加 `/settings/plugins`；变更走 `createEnvironmentRpcCommand`，按钮可用性用它的 `permissionAtom`。
- Mobile：`features/settings/PluginsSettingsScreen.tsx`，接进设置导航。
- Skills 页：插件来源 skill 的只读原因改成“在 Plugins 页管理”，并给出链接。
- 卸载前弹确认框，说明 R3 里不能重新安装，以及重新安装用的 CLI 命令（`claude plugin install <id>` / `codex plugin add <id>`）。
- 共用配置目录时，开关旁注明“也会影响：实例 B、C”。

页面草图：

```
Plugins                                   [项目: r3code ▾] [刷新]
Claude (default)  · ~/.claude
  superpowers  claude-plugins-official · 7.0.2 · user   [●启用] [卸载]
    skills 14 · hooks
  context7     claude-plugins-official · 1.0.0 · user   [●启用] [卸载]
    MCP: context7
  acme-policy  managed                                  只读：组织策略管理
Codex  · ~/.codex          也会影响：Codex (work)
  documents    openai-primary-runtime                   [●启用]  默认安装，不能卸载
OpenCode                                                不支持插件管理
```

### 7. 文案、文档

- 新增文案在 `apps/{web,mobile}/src/i18n/translations` 的所有语言里补齐，跑 `vp run i18n:check`。
- `docs/user/providers-claude.md` 和 `providers-codex.md` 各加一小段：Settings → Plugins 能做什么、哪些插件只读、改完要 Restart agent session。同时更新 `providers-claude.md` 里“插件 skill 只读，要在来源处管理”那句。

## Testing

- **server**：
  - `ClaudePlugins` 用假的命令执行器，覆盖：list JSON 解析（含 `notes`、`mcpServers`）、参数组装（显式 `--scope`、`--keep-data`）、managed 和同步插件只读、非零退出转成错误；
  - `CodexPlugins` 用假的 app-server client，覆盖：`installed` 过滤、`INSTALLED_BY_DEFAULT` 不能卸载、`WORKSPACE_SETTING` 只读、`config/value/write` 的参数；
  - `PluginManager` 覆盖：revision 冲突、不在列表里的 `pluginId` 被拒、同一 `configHome` 串行、改完刷新共用目录的所有实例。
- **client-runtime**：分组和受影响实例的推导。
- **权限**：在现有 permission 行为测试里给三个新 RPC 各加一行。
- **端到端验证**：用 `test-t3-app` 在 Web 上手动走一遍，`test-t3-mobile` 在 Mobile 上走一遍。先在 dev 的 `.t3` 里拷贝 Claude/Codex 配置目录再操作，不要动真实的 `~/.claude` 和 `~/.codex`。

## Left to the Builder

- 组件信息展示到什么程度（拿不到的字段直接省略）。
- 列表的缓存和超时具体数值。
- `plugin/uninstall` 返回内容怎么解析。
- 页面细节样式（遵守 `components/ui` 的 variant 规则）。

## Calls Made Without Explicit Sign-off

- 启用/停用只写插件的安装范围，不做“仅本项目停用一个全局插件”这种覆盖。
- 卸载默认保留数据目录，不清理依赖。
- 插件更新不进首版。
- 不暴露 MCP 工具给 agent。
- Plugins 是 Settings 里单独的页面，放在 Skills 旁边。
