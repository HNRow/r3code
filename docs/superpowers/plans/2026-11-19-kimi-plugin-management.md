# Kimi Code 插件管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Settings → Plugins 能列出、启用、停用、卸载 Kimi Code 已安装的插件。

**Architecture:** Kimi 实例走 ACP Registry 驱动，CLI 没有 `plugin` 子命令，插件只能通过 Kimi 本地 server 的 HTTP API 管理。给 Kimi 实例加 `pluginManagement`：优先连已在运行的 Kimi server；没有就用同一个 Kimi 可执行文件临时起 `kimi web`，请求完立即关掉。`PluginManager`、契约、Web、Mobile 都不用改，它们已经按 provider 通用。

**Tech Stack:** Effect、`ChildProcessSpawner`、`@t3tools/shared/Net`、Node `fetch`（只连 loopback）。

**Spec:** `docs/superpowers/specs/2026-11-19-plugin-management-design.md`（Claude/Codex 版已实现）。下面 Global Constraints 里的 Kimi 接口事实是 2026-11-19 在 Kimi 2.5.3 和 2.6.2（registry 里的版本）上用配置副本实测的。

## Global Constraints

- 只对 Kimi 实例生效：registry `agentId === "kimi-code"`，或 local source 的命令名是 `kimi`（与 `adapter.ts:210-213` 现有判断相同）。其他 ACP agent 仍然没有 `pluginManagement`。
- `configHome`：`processEnvironment.KIMI_CODE_HOME` 有值就用它，否则用 `<home>/.kimi-code`（与 `kimiAcp.ts:64` 同规则），解析成绝对路径。
- Kimi API base 是 `http://127.0.0.1:<port>/api/v1`。鉴权头 `Authorization: Bearer <token>`，token 取 `<configHome>/server.token` 的内容并 trim。
- `GET /plugins` 返回 `{code:0,msg,data:{plugins:[{id,displayName?,version?,enabled,state,skillCount,mcpServerCount,hasErrors,source,originalSource?}]}}`。
- `POST /plugins/{id}:enable`、`:disable`、`:remove` 返回 `{code:0,data:{ok:true}}`。`{id}` 用 `encodeURIComponent` 编码。
- 失败时 body 的 `code !== 0`，带 `msg`，例如 `40101` Unauthorized、`40419` `Plugin "x" is not installed`、`40001` `unsupported action: …`。body 可能带 `stack`，绝不能透出。不依赖 HTTP 状态码，只看 body。
- 临时 server 命令：`<spawn.command> web --no-open --port <port> --log-level silent`，env 为 `{...spawn.env, KIMI_CODE_HOME: configHome, KIMI_DISABLE_TELEMETRY: "1"}`。stdout 出现 `Kimi server ready` 即就绪（实测约 1.8 s）。scope 结束时杀掉整个进程组，做法同 `OpenCodeRuntime.ts:583` 的 `startServerAttempt`。
- 只有 resolve 出来的 `spawn.args` 恰好是 `["acp"]` 时才能换成 `web` 参数；否则失败，detail 为 `Plugin management needs Kimi launched as \`kimi acp\`.`
- 运行中的 Kimi server 会登记在 `<configHome>/server/instances/*.json`，内容含 `{pid, host, port}`，退出时删除。同一个 home 上的两个 server 不共享内存状态，旧的那个下次写插件时会把旧状态整份写回、覆盖别人的改动（已实测）。所以有存活的 loopback server 时必须复用它，不能另起一个。
- Kimi 插件没有范围：所有条目 `scope: "user"`，列表与 cwd 无关；`actions` 一律可启用、可卸载。卸载只删记录，`managed/` 下的文件 Kimi 自己保留。
- `components` 只给 `skills: skillCount`（大于 0 时），不给 MCP 名字，与 Codex 适配器一致。
- 每个操作总超时 `"30 seconds"`，包含临时 server 启动。没有 server 在跑时，每次打开插件页都会起一次临时 server（约 2 s）；不加缓存。
- 不直接读写 `installed.json`。server 端文案用英文，与现有适配器一致。代码注释用中文。
- 不 commit；不跑全仓检查；不碰真实的 `~/.kimi-code`。实测只用仓库 `.t3/` 下的配置副本，副本里 `installed.json` 的 `root` 路径必须改写到副本目录，验完删除。

## Review Focus

1. 有 Kimi 桌面版或 `kimi web` 在用同一个 home：必须复用它，不能另起 server 导致改动被回写覆盖 → Task 1 `reuses only a live loopback Kimi server`，Task 2 手动步骤 6。
2. instances 目录里残留了已崩溃进程的记录：pid 已死要忽略，改起临时 server → Task 1 同一测试的 dead-pid 断言。
3. Kimi 可执行文件缺失或起不来：页面显示 "Scan failed: …"，不能显示成"没有插件" → Task 1 `surfaces a transport failure as a list error`。
4. Kimi server 卡住不响应：30 秒后报超时 → Task 1 `times out a hung Kimi server`。
5. 临时 server 不能比请求活得久：每次操作后不留 `kimi web` 监听，`server/instances` 为空 → Task 2 手动步骤 5。

---

### Task 1: Kimi 插件适配器（纯逻辑 + 测试）

**Files:**

- Create: `packages/provider-acp-registry/src/server/kimiPlugins.ts`
- Test: `packages/provider-acp-registry/src/server/kimiPlugins.test.ts`

**Interfaces:**

- Consumes: `ProviderPluginManagement`（`@t3tools/provider-core/server/driver`）、`ProviderDriverError`（`@t3tools/provider-core/server/errors`）、`PluginInventoryEntry`（`@t3tools/contracts`）。
- Produces:
  - `export type KimiPluginRequest = (input: { readonly method: "GET" | "POST"; readonly path: string }) => Effect.Effect<unknown, ProviderDriverError>`。返回已解析的 JSON body，不做信封判断；`path` 不含 `/api/v1` 前缀。
  - `KimiListedPlugin`：列表 Schema 解码出的单个插件类型，字段见 Global Constraints。
  - `export function kimiPluginEntries(plugins: ReadonlyArray<KimiListedPlugin>, context: { readonly instanceId: ProviderInstanceId; readonly cwd: string; readonly configHome: string }): ReadonlyArray<PluginInventoryEntry>`
  - `export function kimiPluginActionPath(pluginId: string, action: "enable" | "disable" | "remove"): string`
  - `export function kimiWebArgs(acpArgs: ReadonlyArray<string>, port: number): ReadonlyArray<string> | undefined`
  - `export function pickRunningKimiServer(records: ReadonlyArray<unknown>, isAlive: (pid: number) => boolean): string | undefined`，返回 base URL，如 `http://127.0.0.1:58627`。
  - `export function makeKimiPluginManagement(input: { readonly configHome: string; readonly instanceId: ProviderInstanceId; readonly request: KimiPluginRequest }): ProviderPluginManagement`

- [ ] **Step 1: 写失败测试**（用 `@effect/vitest`，假 `request` 记录调用并返回预设 body）

```ts
// 列表样本取自实测
const listed = {
  code: 0,
  msg: "success",
  data: {
    plugins: [
      {
        id: "kimi-datasource",
        displayName: "Kimi Datasource",
        version: "3.3.0",
        enabled: true,
        state: "ok",
        skillCount: 1,
        mcpServerCount: 1,
        hasErrors: false,
        source: "zip-url",
      },
      {
        id: "superpowers",
        displayName: "Superpowers",
        version: "6.1.1",
        enabled: false,
        state: "ok",
        skillCount: 14,
        mcpServerCount: 0,
        hasErrors: false,
        source: "github",
      },
    ],
  },
};
```

- `maps Kimi plugins to inventory entries`：`superpowers` 条目的 `pluginId` 为 `"superpowers"`、`name` 为 `"Superpowers"`、`version` 为 `"6.1.1"`、`scope` 为 `"user"`、`state` 为 `"disabled"`、`components` 为 `{ skills: 14 }`、`actions` 为 `{ canSetEnabled: true, canUninstall: true }`、`marketplace` 为 undefined、`configHome` 与 `cwd` 透传。`kimi-datasource` 为 `state: "enabled"`、`components: { skills: 1 }`。
- `notes a plugin Kimi reports as broken`：`state: "error", hasErrors: true` 的条目 `notes` 等于 `["Kimi reports a problem with this plugin."]`；正常条目 `notes` 为 `[]`。
- `sends enable, disable and remove to the action route`：依次断言 `request` 收到 `{ method: "POST", path: "/plugins/superpowers:enable" }`、`":disable"`、`"/plugins/superpowers:remove"`；`kimiPluginActionPath("a b", "disable") === "/plugins/a%20b:disable"`。
- `fails with Kimi's message when the envelope code is not 0`：body `{ code: 40419, msg: 'Plugin "nope" is not installed', stack: "Error2: …" }` 让 `setEnabled` 失败，`detail === 'Plugin "nope" is not installed'`，且 detail 不含 `"Error2"`。
- `rejects a malformed plugin list`：body `{ code: 0, data: {} }` 让 `list` 失败，`detail === "Could not read Kimi's plugin list."`。
- `surfaces a transport failure as a list error`：`request` 直接失败时，`list` 以同一个 `ProviderDriverError` 失败（不吞成空列表）。
- `times out a hung Kimi server`：`request` 返回 `Effect.never`，`TestClock.adjust("30 seconds")` 后失败，`detail === "Kimi plugin request timed out."`。
- `builds web args only for a kimi acp launch`：`kimiWebArgs(["acp"], 4123)` 等于 `["web", "--no-open", "--port", "4123", "--log-level", "silent"]`；`kimiWebArgs(["acp", "--x"], 1)` 和 `kimiWebArgs([], 1)` 都是 `undefined`。
- `reuses only a live loopback Kimi server`：
  - `pickRunningKimiServer([{ pid: 1, host: "127.0.0.1", port: 58627 }], (pid) => pid === 1) === "http://127.0.0.1:58627"`；
  - `host` 为 `"0.0.0.0"` 或 `"localhost"` 时同样连 `127.0.0.1`；
  - pid 已死、`host` 为 `"10.0.0.5"`、记录缺 `port` 时都返回 `undefined`。

- [ ] **Step 2: 跑测试确认失败**

Run: `vp test run packages/provider-acp-registry/src/server/kimiPlugins.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `kimiPlugins.ts`**

- 列表和信封都用 Schema 解码。信封 `code !== 0` 时用 `msg` 作为 detail；列表解码失败时 detail 为 `Could not read Kimi's plugin list.`。
- `makeKimiPluginManagement` 的每个请求包 `Effect.timeoutOption("30 seconds")`，写法同 `CodexPlugins.ts:84-98`。
- `setEnabled` 和 `uninstall` 忽略 `scope` 和 `cwd`。

- [ ] **Step 4: 跑测试确认通过**

Run: `vp test run packages/provider-acp-registry/src/server/kimiPlugins.test.ts`
Expected: 9 passed

---

### Task 2: 传输层、驱动接线、文档

**Files:**

- Modify: `packages/provider-acp-registry/src/server/kimiPlugins.ts`（加传输层）
- Modify: `packages/provider-acp-registry/src/server/kimiAcp.ts`（导出 Kimi 判断）
- Modify: `packages/provider-acp-registry/src/server/adapter.ts:210-213`（改用该判断）
- Modify: `packages/provider-acp-registry/src/server/driver.ts:986-1101`（返回的实例里加 `pluginManagement`）
- Modify: `docs/user/providers-acp.md`（新增一节）

**Interfaces:**

- Consumes: Task 1 的 `KimiPluginRequest`、`kimiWebArgs`、`pickRunningKimiServer`、`makeKimiPluginManagement`；`catalog.resolve(settings, cwd, environment)` 返回的 `spawn: AcpSpawnInput`（`AcpRegistrySupport.ts:1935-1944`）。
- Produces:
  - `export function isKimiAcpSettings(settings: AcpRegistrySettings): boolean`（kimiAcp.ts）；
  - `export const makeKimiServerRequest = (input: { readonly configHome: string; readonly spawn: AcpSpawnInput; readonly instanceId: ProviderInstanceId }): KimiPluginRequest`（kimiPlugins.ts）。所需服务由驱动提供。

- [ ] **Step 1: `isKimiAcpSettings`**

把 `adapter.ts:210-213` 的判断搬进 `kimiAcp.ts` 导出，`adapter.ts` 改为调用它。行为不变，跑 `vp test run packages/provider-acp-registry/src/server/kimiAcp.test.ts packages/provider-acp-registry/src/server/driver.test.ts` 应保持全绿。

- [ ] **Step 2: 实现 `makeKimiServerRequest`**

每次请求都在一个 `Effect.scoped` 里完成：

1. 读 `<configHome>/server/instances/*.json`，目录不存在当空、坏 JSON 跳过，再调 `pickRunningKimiServer`。`isAlive` 用 `process.kill(pid, 0)`：不抛错或抛 `EPERM` 算存活。
2. 找到 URL 就直接请求；连接被拒时继续第 3 步，其他失败原样返回。
3. 否则：
   - 端口用 `Net.reserveLoopbackPort()`；
   - `kimiWebArgs(spawn.args, port)` 为 undefined 时失败，detail 用 Global Constraints 里的固定文案；
   - 按 Global Constraints 的命令和 env 起进程，finalizer 杀进程组；
   - 等 stdout 出现 `Kimi server ready`。
4. 读 token；为空时失败，detail 为 `Kimi server token is missing.`。
5. 用 `fetch` 发请求（`Effect.tryPromise` 传 signal），把 body 按 JSON 解析后返回，不看 HTTP 状态码。

- [ ] **Step 3: 驱动接线**

在 `driver.ts` 返回的实例里，`isKimiAcpSettings(effectiveConfig)` 为真时加入：

```ts
pluginManagement: makeKimiPluginManagement({
  configHome,
  instanceId,
  request: (req) =>
    provideAcpManagementServices(
      catalog.resolve(effectiveConfig, host.paths.cwd, processEnvironment).pipe(
        Effect.flatMap((resolved) =>
          makeKimiServerRequest({ configHome, spawn: resolved.spawn, instanceId })(req),
        ),
      ),
    ),
}),
```

`configHome` 按 Global Constraints 计算。resolve 失败要映射成 `ProviderDriverError`。其余 provider 不受影响。

- [ ] **Step 4: 类型检查与单测**

Run: `vp run typecheck`，以及 `vp test run packages/provider-acp-registry/src/server/kimiPlugins.test.ts packages/provider-acp-registry/src/server/kimiAcp.test.ts packages/provider-acp-registry/src/server/driver.test.ts`
Expected: 全部通过

- [ ] **Step 5: 手动验证（只用副本）**

1. 建副本：
   ```bash
   mkdir -p .t3/kimi-plugin-home && cp -R ~/.kimi-code/plugins ~/.kimi-code/config.toml .t3/kimi-plugin-home/
   sed -i '' "s#$HOME/.kimi-code#$PWD/.t3/kimi-plugin-home#g" .t3/kimi-plugin-home/plugins/installed.json
   grep -c "$HOME/.kimi-code" .t3/kimi-plugin-home/plugins/installed.json   # 必须是 0
   ```
   不拷 credentials，列表和操作都不需要登录。
2. 在仓库 `.t3/userdata/settings.json` 里，给 `acpRegistry_kimi_code` 实例的环境变量加 `KIMI_CODE_HOME=<绝对路径>/.t3/kimi-plugin-home`。
3. `vp run dev`，打开 Settings → Plugins，Kimi Code 段应列出 `superpowers`（14 skills）和 `kimi-datasource`（1 skill）。
4. 停用 `superpowers`，副本 `installed.json` 里 `enabled` 应为 false；再启用，应为 true；卸载 `kimi-datasource`，记录应消失。
5. 每次操作后，`ls .t3/kimi-plugin-home/server/instances` 应为空，且没有残留的 `kimi web` 监听。
6. 复用路径：
   - 手动起 `KIMI_CODE_HOME=$PWD/.t3/kimi-plugin-home kimi web --no-open --port 58627 --log-level silent`，记下 PID；
   - 在 R3 里切换一次 `superpowers`；
   - 用 token `curl -H "Authorization: Bearer $(cat .t3/kimi-plugin-home/server.token)" http://127.0.0.1:58627/api/v1/plugins`，应看到新状态；
   - 按记下的 PID 停掉它。
7. 清理：用 harness 停 dev server，删除 `.t3/kimi-plugin-home`，去掉第 2 步加的环境变量。

- [ ] **Step 6: 文档**

在 `docs/user/providers-acp.md` 的 `## Commands and skills` 之后加：

```markdown
## Manage Kimi Code plugins

For Kimi Code, **Settings → Plugins** lists the plugins Kimi has installed and
lets you enable, disable, or uninstall them. R3 Code talks to Kimi's local
server for this and starts one briefly when none is running, so a change can
take a few seconds. Install new plugins with `/plugins` inside Kimi. Changes
reach the next agent session, so use **Restart agent session** in the command
palette afterwards.
```

- [ ] **Step 7: 变更检查**

Run: `vp run check:changed`
Expected: 本次改动的文件没有新增失败。之前就失败的项（品牌 i18n 那批）照常列出，并在报告里说明。
