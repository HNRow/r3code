# Unified Skills Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Settings → Skills 中统一管理普通 AI skills，支持库存查看、安装、启用/禁用、受约束卸载和 Claude 配置目录同步。

**Architecture:** Provider 原生文件和配置仍是唯一事实来源。ProviderRegistry 负责 instance 路由和刷新，新的服务端 SkillManager 负责受约束文件事务；Web/Desktop/Mobile 复用 client-runtime 的库存与过滤逻辑。不新增 SQLite 表，不做通用插件平台。

**Tech Stack:** TypeScript、Effect/Schema、React、React Native、Vite+、Node filesystem。

## Global Constraints

- 不做插件市场、hooks、通用插件运行时或中央 skills 仓库。
- ACP、系统托管、同步插件和 package cache 首版只读，不能卸载。
- 不同步凭据、会话、`.claude.json` 或 transcript。
- RPC 只接受 `instanceId / cwd / nativeId`，不接受任意目标绝对路径。
- 卸载仅允许带 R3 安装标记的目录。
- 所有 mutation 必须校验 `expectedRevision` 并返回 `requiresSessionRestart`。
- 除非用户明确要求，否则不执行 `git commit`。

---

### Task 1: Skill Inventory 契约与只读聚合

**Files:**

- Create: `packages/contracts/src/skills.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/client-runtime/src/skillInventory.ts`
- Test: `packages/client-runtime/src/skillInventory.test.ts`

**Interfaces:**

- Produces: `SkillInventoryEntry`、`SkillInventory`、`buildSkillInventory()`、`filterSkillInventory()`。

- [ ] **Step 1: 先写失败测试**

在 `packages/client-runtime/src/skillInventory.test.ts` 中添加：

```ts
import { describe, expect, it } from "vite-plus/test";
import { buildSkillInventory, filterSkillInventory } from "./skillInventory";

describe("skill inventory", () => {
  it("keeps disabled and shadowed entries while `$` filtering only shows enabled unique names", () => {
    const inventory = buildSkillInventory({
      instanceId: "claude_dp41sf",
      cwd: "/work/project",
      revision: "rev-1",
      entries: [
        {
          nativeId: "a",
          name: "review",
          state: "disabled",
          source: { kind: "file", scope: "user", path: "/home/u/skills/review" },
        },
        {
          nativeId: "b",
          name: "review",
          state: "shadowed",
          source: { kind: "file", scope: "project", path: "/work/project/.claude/skills/review" },
        },
        {
          nativeId: "c",
          name: "test",
          state: "enabled",
          source: { kind: "file", scope: "project", path: "/work/project/.claude/skills/test" },
        },
      ],
      diagnostics: [],
    });
    expect(inventory.entries).toHaveLength(3);
    expect(
      filterSkillInventory(inventory, { state: "enabled" }).map((entry) => entry.name),
    ).toEqual(["test"]);
  });
});
```

Run:

```bash
. ~/.config/vite-plus/env && vp test run packages/client-runtime/src/skillInventory.test.ts
```

Expected: FAIL，模块尚不存在。

- [ ] **Step 2: 定义契约**

在 `packages/contracts/src/skills.ts` 使用 `effect/Schema` 定义：

```ts
import * as Schema from "effect/Schema";

export const SkillSource = Schema.Struct({
  kind: Schema.Literal("file", "plugin", "package", "agent", "managed"),
  scope: Schema.Literal("user", "project", "local", "managed", "agent"),
  path: Schema.optionalKey(Schema.String),
  containerId: Schema.optionalKey(Schema.String),
});

export const SkillInventoryEntry = Schema.Struct({
  instanceId: Schema.String,
  cwd: Schema.String,
  nativeId: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  source: SkillSource,
  state: Schema.Literal("enabled", "disabled", "shadowed", "unavailable"),
  actions: Schema.Struct({
    canSetEnabled: Schema.Boolean,
    canUninstall: Schema.Boolean,
    reason: Schema.optionalKey(Schema.String),
  }),
});

export const SkillInventory = Schema.Struct({
  checkedAt: Schema.String,
  revision: Schema.String,
  entries: Schema.Array(SkillInventoryEntry),
  diagnostics: Schema.Array(Schema.String),
});
```

在 `packages/contracts/src/index.ts` 添加：

```ts
export * from "./skills.ts";
```

- [ ] **Step 3: 实现纯聚合逻辑**

`buildSkillInventory()` 只补全 `checkedAt` 并保留全部条目；`filterSkillInventory()` 支持 `state`、`instanceId`、`cwd`、`query` 和 `enabledOnly` 过滤，禁止删除 disabled/shadowed 项。

- [ ] **Step 4: 运行测试**

Run:

```bash
. ~/.config/vite-plus/env && vp test run packages/client-runtime/src/skillInventory.test.ts
```

Expected: PASS。

---

### Task 2: ProviderRegistry 只读库存服务

**Files:**

- Create: `apps/server/src/provider/SkillInventoryService.ts`
- Test: `apps/server/src/provider/SkillInventoryService.test.ts`
- Modify: `apps/server/src/provider/ProviderRegistry.ts`（仅在现有接口确实需要扩展时）
- Modify: `packages/provider-core/src/server/driver.ts`

**Interfaces:**

- Consumes: Task 1 的 `SkillInventory`。
- Produces: `SkillInventoryService.list({ instanceId?, cwd, expectedRevision? })`。
- Produces: `ProviderInstance` 的可选完整库存 adapter，供 Task 4 的 Claude 文件发现与写操作复用。

- [ ] **Step 1: 写失败测试**

覆盖：合并 provider 与 cwd 快照、adapter 保留 disabled/shadowed、ACP 只读、扫描错误进入 diagnostics、revision 改变。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
. ~/.config/vite-plus/env && vp test run apps/server/src/provider/SkillInventoryService.test.ts
```

Expected: FAIL，service 不存在。

- [ ] **Step 3: 实现服务**

服务通过 `ProviderInstanceRegistry` 路由 instance，通过 `ProviderRegistry` 获取和刷新 cwd 快照。完整 adapter 存在时使用其条目；否则把现有快照映射为只读库存，不能从 `enabled` 臆造 shadowed 状态。对 `acp://`、managed、plugin/package 来源设置：

```ts
actions: {
  canSetEnabled: false,
  canUninstall: false,
  reason: "This source is read-only in the first version.",
}
```

revision 使用排序后的条目和 diagnostics 的 SHA-256 digest。`expectedRevision` 不匹配时返回 `SkillInventoryConflictError`。完整 Claude 文件发现属于 Task 4，本任务不修改 `$` 菜单现有快照语义。

- [ ] **Step 4: 运行测试**

Run:

```bash
. ~/.config/vite-plus/env && vp test run apps/server/src/provider/SkillInventoryService.test.ts
```

Expected: PASS。

---

### Task 3: Settings → Skills 只读页面

**Files:**

- Create: `apps/web/src/components/settings/SkillsSettings.tsx`
- Create: `apps/web/src/routes/_chat.settings.skills.tsx`
- Modify: `apps/web/src/components/settings/settingsSearch.ts`
- Modify: `apps/web/src/components/settings/SettingsSidebarNav.tsx`
- Modify: `apps/web/src/routes/_chat.settings.tsx`
- Create: `apps/mobile/src/features/settings/SkillsSettingsScreen.tsx`
- Modify: `apps/mobile/src/Stack.tsx`
- Modify: `apps/mobile/src/features/settings/SettingsRouteScreen.tsx`
- Modify: `apps/mobile/src/features/settings/components/settings-page-targets.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/client-runtime/src/state/server.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**

- Consumes: Task 2 的只读库存服务和 Task 1 的过滤函数。
- Produces: 只读 `skills.list` RPC 与 `serverEnvironment.skillInventory` command；mutation RPC 仍属于 Task 6。

- [ ] **Step 1: 页面与导航**

页面提供 environment/provider/project/state/query 筛选，使用现有 Settings row、search input、empty state 和 Button variants，不新增 UI 设计风格。

- [ ] **Step 2: 接入库存**

提前接通只读 `skills.list` RPC、应用根 layer 和 `serverEnvironment.skillInventory` command，避免页面依赖后续 Task 6。`ws.ts` 只做 decode → `SkillInventoryService.list` → error mapping。Loading、diagnostics、空库存分别展示，不把扫描失败显示为空列表。

- [ ] **Step 3: 接入 Mobile**

复用 `filterSkillInventory()`，添加 Settings → Skills 导航和页面，不复制聚合逻辑。

- [ ] **Step 4: 验证**

Run:

```bash
. ~/.config/vite-plus/env && vp run --filter @t3tools/web --filter @t3tools/mobile typecheck
. ~/.config/vite-plus/env && vp run i18n:check
```

Expected: 均通过。

---

### Task 4: SkillManager 受约束文件事务与 Claude 完整库存

**Files:**

- Create: `apps/server/src/provider/SkillManager.ts`
- Test: `apps/server/src/provider/SkillManager.test.ts`
- Modify: `packages/provider-core/src/server/driver.ts`
- Modify: `apps/server/src/provider/Drivers/ClaudeSkills.ts`
- Test: `apps/server/src/provider/Drivers/ClaudeSkills.test.ts`
- Modify: `apps/server/src/provider/Drivers/ClaudeDriver.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/package.json` 与 lockfile（复用仓库已有 `jsonc-parser@3.3.1`）

**Interfaces:**

- Produces: `installSkill()`、`setSkillEnabled()`、`uninstallSkill()`。
- Produces: provider `skillManagement` 路径解析/原生配置 adapter；Claude `skillInventory.list` 复用完整文件发现。
- 所有 mutation 返回 `requiresSessionRestart`，并在写前校验 `expectedRevision`。

- [ ] **Step 1: 写安全边界失败测试**

至少覆盖：

- `../` 名称和绝对路径拒绝。
- symlink 指向允许根目录之外时拒绝。
- 目标已有同名目录时冲突。
- revision 不匹配时拒绝。
- staging 失败不留下目标目录。
- 无安装标记时禁止卸载。
- Claude 完整库存保留 disabled/shadowed，原生 skillOverrides 同时影响 `$` 快照与管理库存。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
. ~/.config/vite-plus/env && vp test run apps/server/src/provider/SkillManager.test.ts apps/server/src/provider/Drivers/ClaudeSkills.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现文件事务和 Claude adapter**

`installSkill()` 只接受 `instanceId / cwd / nativeId / sourceFolder`，由 adapter 解析允许根目录。校验来源与目标的 realpath、递归深度、文件数和总大小；写入同父目录 staging、校验 `SKILL.md`、原子 rename，并创建 `.t3-skill-install.json`：

```json
{
  "version": 1,
  "instanceId": "claude_dp41sf",
  "nativeId": "review",
  "installedBy": "r3-code"
}
```

`setSkillEnabled()` 使用 Claude 原生 `skillOverrides`：用户级写 `<configDir>/settings.json`，项目级写 `<cwd>/.claude/settings.local.json`。使用仓库已有的 `jsonc-parser@3.3.1` 仅修改目标条目，保留其他 JSONC 内容，不重写 `.claude.json`，也不使用只有 R3 能识别的私有 sidecar。

`uninstallSkill()` 只有标记文件中的 `installedBy === "r3-code"` 才允许卸载。为关闭校验后递归删除被外部进程替换目录的竞态，首版卸载是原子移动到 provider 配置域内、skills 扫描根之外的 R3 quarantine，不递归物理删除；quarantine 复核失败时保留现场且不自动覆盖恢复原目标。Claude 完整库存显示普通 file 的 disabled/shadowed、managed 与已加载 plugin 的只读来源，不改变 `$` 菜单现有去重语义。

- [ ] **Step 4: 运行测试**

Run:

```bash
. ~/.config/vite-plus/env && vp test run apps/server/src/provider/SkillManager.test.ts apps/server/src/provider/Drivers/ClaudeSkills.test.ts
```

Expected: PASS。

---

### Task 5: Claude 配置目录复制与链接同步

**Files:**

- Modify: `apps/server/src/provider/SkillManager.ts`
- Test: `apps/server/src/provider/SkillManager.test.ts`
- Modify: `packages/provider-core/src/server/driver.ts`（仅同步所需 adapter 信息）
- Modify: `apps/server/src/provider/Drivers/ClaudeSkills.ts`（仅同步所需 adapter 信息）

**Interfaces:**

- Produces: `syncClaudeSkills({ sourceInstanceId, targetInstanceId, cwd, mode, nativeIds, expectedRevision, onConflict })`，`mode = "copy" | "link"`，`onConflict = "cancel" | "backup"`。
- 返回 `requiresSessionRestart`；备份模式返回备份位置。复制项带目标 instance 的 R3 marker，链接项不改源目录且首版不可由 R3 卸载。

- [ ] **Step 1: 添加失败测试**

覆盖复制成功、链接成功、目标冲突默认取消、显式备份、stale revision、凭据和 `.claude.json` 不被复制、源目录不被链接 marker 修改，以及批量失败的安全回滚。

- [ ] **Step 2: 实现同步**

只允许从 Claude `homePath` 对应的 `skills/<nativeId>` 同步到另一个 Claude `homePath`，由 adapter 解析 source/target，客户端不传目录。复制只复制 skill 目录并写目标 instance 的安装 marker；链接使用目录 symlink，不写源目录。目标冲突时 `cancel` 直接取消，`backup` 原子移动到扫描根外带时间戳的备份位置，不能静默覆盖。批量先验证和 staging，失败时安全回滚本服务已提交项；如外部冲突阻止回滚，保留备份/现场并返回明确错误，不递归删除用户目录。

- [ ] **Step 3: 运行测试**

Run:

```bash
. ~/.config/vite-plus/env && vp test run apps/server/src/provider/SkillManager.test.ts
```

Expected: PASS。

---

### Task 6: RPC、权限与 Mutation UI

**Files:**

- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/clientRpcPermissions.ts`
- Modify: `apps/server/src/auth/RpcAuthorization.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `packages/client-runtime/src/state/server.ts`
- Modify: `apps/web/src/components/settings/SkillsSettings.tsx`

**Interfaces:**

- Consumes: Task 3 已接通的只读 `skills.list`。
- Produces: `skills.install`、`skills.setEnabled`、`skills.uninstall`、`skills.sync` command。

- [ ] **Step 1: 添加权限测试**

验证 `providers:manage` 可修改 provider 配置，项目文件写入需要 `filesystem:write`，普通只读 token 不能 mutation。

- [ ] **Step 2: 实现 RPC 与 command**

`ws.ts` 只 decode → service method → error mapping。客户端使用 `createEnvironmentRpcCommand` 和 `permissionAtom`。

- [ ] **Step 3: 接入按钮和确认流程**

设置页提供 Install、Enable/Disable、Uninstall、Copy、Link。卸载和链接冲突必须显示确认对话框；成功后刷新库存并提示 `requiresSessionRestart`。

- [ ] **Step 4: 运行验证**

Run:

```bash
. ~/.config/vite-plus/env && vp test run packages/client-runtime/src/state/server.test.ts apps/server/src/auth/RpcAuthorization.test.ts
. ~/.config/vite-plus/env && vp run i18n:check
```

Expected: 均通过。

---

### Task 7: 端到端验收

**Files:**

- 仅测试和文档，不新增生产文件。

- [ ] **Step 1: 运行 focused checks**

Run:

```bash
. ~/.config/vite-plus/env && vp run check:changed
```

Expected: 通过；若有与本功能无关的既有失败，单独列出。

- [ ] **Step 2: 真实环境验收**

在隔离 `.t3` 环境验证：

1. 默认 Claude 与 DP41FS 的 skills 均显示。
2. 将默认目录中的 skill 复制到 DP41FS，`$` 菜单可用。
3. 禁用后 `$` 隐藏，启用后恢复。
4. 链接另一个 skill，两个目录都能使用。
5. 卸载只允许 R3 安装项，原生动skill不受影响。
6. ACP/同步插件显示只读且不能卸载。

- [ ] **Step 3: 文档**

更新 `docs/user/providers-claude.md` 和 `docs/user/composer.md`，说明 Settings → Skills、复制/链接、卸载限制和 session 重启要求。

## Self-Review

- Spec coverage: 库存、设置页、写操作、同步、权限、验收均有对应 Task。
- Placeholder scan: 无 TBD/TODO；所有接口名称与文件路径一致。
- Type consistency: `SkillInventoryEntry`、`SkillInventory`、`syncClaudeSkills` 和 `requiresSessionRestart` 在各 Task 中保持一致。
