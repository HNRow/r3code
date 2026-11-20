# Unified Skills Management Design

## Context

R3 Code 当前能够从多个 provider 发现 skills，并在 composer 的 `$` 菜单中展示，但没有统一的列表、安装、启用/禁用、卸载或同步管理界面。用户希望在不引入第二套插件平台的前提下，一步到位地统一管理普通 AI skills。

已确认采用方案 A：统一管理 Skills，不做通用插件运行时。

## Goals

- 在 Settings → Skills 提供统一库存视图。
- 支持用户级和项目级普通 skills 的查看、安装、启用/禁用和受约束卸载。
- 支持在不同 Claude config directories 之间复制或链接 skills。
- 与现有 `$` 菜单、provider 刷新和 agent session 重启流程保持一致。
- Web、Desktop、Mobile 复用相同的库存和过滤逻辑。

## Non-Goals

- 不做插件市场、依赖解析、通用 UI/Node 插件运行时或 hooks 执行。
- 不同步登录凭据、会话记录、`.claude.json` 或 provider 原生 transcript。
- 首版不允许修改 ACP agent、系统托管 skills、Claude 同步插件和 package cache。
- 首版不提供任意绝对路径安装、任意目录删除或任意 JSONC 重写。

## Approach

Provider 原生文件和配置仍是唯一事实来源。R3 通过 provider adapter 派生统一库存，不复制到中央仓库，也不新增 SQLite 表。

## Components

### 1. Settings → Skills

新增 Web 路由和设置页，并接入 Mobile 设置导航：

- 按 environment、provider、project、用户级/项目级筛选。
- 搜索名称、描述和来源路径。
- 展示 enabled、disabled、shadowed、unavailable 状态。
- 展示来源、路径、所属 provider 和允许操作。
- 支持刷新，并在需要时提示 Restart agent session。

ACP、系统托管和同步插件显示为只读，并说明不能操作的原因。

### 2. Skill Inventory

新增独立库存模型，而不是复用 `$` 菜单列表：

```ts
interface SkillInventoryEntry {
  instanceId: string;
  cwd: string;
  nativeId: string;
  name: string;
  description?: string;
  source: {
    kind: "file" | "plugin" | "package" | "agent" | "managed";
    scope: "user" | "project" | "local" | "managed" | "agent";
    path?: string;
    containerId?: string;
  };
  state: "enabled" | "disabled" | "shadowed" | "unavailable";
  actions: {
    canSetEnabled: boolean;
    canUninstall: boolean;
    reason?: string;
  };
}

interface SkillInventory {
  checkedAt: string;
  revision: string;
  entries: SkillInventoryEntry[];
  diagnostics: string[];
}
```

`revision` 是整个库存的 digest。Mutation 必须带 `expectedRevision`，服务端重新解析目标后校验，避免旧列表覆盖用户刚修改的内容。

### 3. Provider Skill Management Adapter

在 provider 域增加可选 `skillManagement` adapter。`ProviderRegistry` 负责 instance 路由、调用 adapter 和操作后的 refresh/rescan。复杂文件事务由服务端 `SkillManager` 处理，WebSocket/HTTP/MCP handler 只做解码、调用和错误映射。

新 RPC、授权、客户端 command 和 `permissionAtom` 按现有 `providers:manage` / `filesystem:write` 规则实现。

### 4. Constrained Writes

首版仅允许普通 skills：

- 用户级：`<configDir>/skills/<name>`。
- 项目级：`<known-workspace>/.claude/skills/<name>`。
- Pi 对应目录仅在该 provider 明确支持时开放。

RPC 只接受 `instanceId / cwd / nativeId`，不接受任意目标绝对路径。Adapter 重新计算允许的根目录，并校验名称、realpath、symlink、文件数、总大小和递归深度。

安装流程：

1. 在同一父目录创建 staging 目录。
2. 写入并校验 `SKILL.md` 及允许的文件。
3. 原子 rename 到目标目录。
4. 失败时清理 staging，保留原目录。
5. 写入 R3 安装标记，供受约束卸载识别。
6. 刷新 provider 库存并返回 `requiresSessionRestart`。

卸载仅允许带 R3 安装标记的目录。为关闭校验后递归删除被外部进程替换目录的竞态，首版卸载是原子移动到 provider 配置域内、所有 skills 扫描根之外的 R3 quarantine，不递归物理删除，也不自动覆盖恢复。不得执行 skill scripts、package lifecycle scripts 或 hooks。

### 5. Claude Config Directory Sync

支持两种同步：

- **复制**：目录互不影响，适合不同账号或 API；复制项带目标 instance 的 R3 安装标记，可受约束卸载。
- **链接**：共享同一 skills 目录，适合需要默认 Claude 与 DP41FS 始终一致的场景；不在源目录写目标 instance 标记，首版链接项不能由 R3 卸载。

不同步登录凭据、会话、插件 manifest 或 `.claude.json`。复制和链接只接受服务端解析的 user-level skill 名称，并校验目标库存 `expectedRevision`。目标冲突时必须显式选择备份或取消；备份原子移动到扫描根外，不能静默覆盖。

### 6. Shared Client Logic

库存聚合、筛选、分组和权限派生放在 `packages/client-runtime`。Web 和 Mobile 只实现各自 UI，不复制业务逻辑。现有 `resolveProviderSkillsForCwd` 继续服务 `$` 菜单；新的库存服务负责管理视图。

## Error Handling

- 部分来源扫描失败时返回 diagnostics，不能假装库存为空。
- revision 不匹配时返回冲突并要求刷新重试。
- 目标不存在、路径逃逸、符号链接越界、目标已有同名目录、不可写来源分别返回明确错误。
- 写失败不得留下半安装目录；卸载失败不得删除标记之外的内容。
- 修改完成后返回 `requiresSessionRestart`，复用现有重启流程，不静默停止正在运行的 thread。

## Validation

- 默认 Claude 与 DP41FS 的 skills 均能显示。
- 可以把默认目录中的 skill 复制或链接到 DP41FS，并在 `$` 菜单中使用。
- 禁用后 `$` 菜单隐藏，重新启用后恢复。
- 用户级操作不会误删项目级 skills。
- 远程 environment 上执行的是远程文件操作。
- ACP、同步插件、系统托管项不能卸载。
- 路径逃逸、符号链接越界、revision 冲突和部分扫描失败均有测试。
- Web/Desktop 完成一次真实设置页操作验证；Mobile 验证共享库存和导航。

## Assumptions

- 首版不包含通用插件平台、市场或 hooks。
- 同步插件和 ACP 仅只读。
- 不修改现有 `$` 菜单语义，只增加管理库存。
- 现有 provider 原生目录结构继续有效。
