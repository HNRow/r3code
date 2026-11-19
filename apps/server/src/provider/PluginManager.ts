import { ProviderInstanceId } from "@t3tools/contracts";
import type {
  PluginInventory,
  PluginInventoryEntry,
  PluginInstanceInventory,
  PluginMutationResult,
  PluginSetEnabledInput,
  PluginUninstallInput,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

type PluginMutationOperation = "setEnabled" | "uninstall";

export type PluginManagerErrorReason =
  | "unknown-workspace"
  | "management-unavailable"
  | "unknown-plugin"
  | "action-not-allowed"
  | "provider-failed";

export class PluginManagerError extends Schema.TaggedError<PluginManagerError>()(
  "PluginManagerError",
  {
    operation: Schema.Literals(["setEnabled", "uninstall"]),
    instanceId: ProviderInstanceId,
    cwd: Schema.String,
    pluginId: Schema.String,
    reason: Schema.Literals([
      "unknown-workspace",
      "management-unavailable",
      "unknown-plugin",
      "action-not-allowed",
      "provider-failed",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Plugin ${this.operation} failed for '${this.pluginId}': ${this.reason}.`;
  }
}

export class PluginManagerConflictError extends Schema.TaggedError<PluginManagerConflictError>()(
  "PluginManagerConflictError",
  {
    instanceId: ProviderInstanceId,
    cwd: Schema.String,
    expectedRevision: Schema.String,
    actualRevision: Schema.String,
  },
) {
  override get message(): string {
    return `Plugin inventory for '${this.cwd}' changed after revision '${this.expectedRevision}'.`;
  }
}

const NO_REVISION = "empty";
/** 条目摘要按固定顺序序列化，revision 只随内容变化。 */
const EntryPairsJson = Schema.toCodecJson(Schema.Array(Schema.String));
const encodeEntryPairs = Schema.encodeEffect(EntryPairsJson);

const revisionOf = Effect.fn("PluginManager.revision")(function* (
  digester: {
    readonly digest: (
      algorithm: typeof Digest.sha256,
      data: Uint8Array,
    ) => Effect.Effect<Uint8Array>;
  },
  entries: ReadonlyArray<PluginInventoryEntry>,
) {
  const payload = entries
    .map((entry) =>
      JSON.stringify({
        pluginId: entry.pluginId,
        scope: entry.scope,
        state: entry.state,
        actions: entry.actions,
      }),
    )
    .sort();
  const encoded = yield* encodeEntryPairs(payload).pipe(Effect.orDie);
  return Hex.encode(
    yield* digester.digest(Digest.sha256, new TextEncoder().encode(String(encoded))),
  );
});

const scanInstance = (
  instance: ProviderInstance,
  cwd: string,
): Effect.Effect<
  {
    readonly entries: ReadonlyArray<PluginInventoryEntry>;
    readonly diagnostics: ReadonlyArray<string>;
  },
  never
> => {
  const adapter = instance.pluginManagement;
  if (adapter === undefined) {
    return Effect.succeed({ entries: [], diagnostics: [] });
  }
  return adapter.list(cwd).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({
        entries: [],
        diagnostics: [
          `Plugin scan failed for provider instance '${instance.instanceId}': ${String(cause)}`,
        ],
      }),
    ),
  );
};

const make = Effect.gen(function* () {
  const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;

  const digester = yield* Digest.Digest;
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (configHome: string) => {
    const existing = locks.get(configHome);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    locks.set(configHome, created);
    return created;
  };

  const scan = Effect.fn("PluginManager.scan")(function* (instance: ProviderInstance, cwd: string) {
    const scanned = yield* scanInstance(instance, cwd);
    const runtime = instance.pluginManagement;
    const inventory: PluginInstanceInventory = {
      instanceId: instance.instanceId,
      supported: runtime !== undefined,
      ...(runtime === undefined ? {} : { configHome: runtime.configHome }),
      revision:
        scanned.entries.length === 0 ? NO_REVISION : yield* revisionOf(digester, scanned.entries),
      entries: scanned.entries,
    };
    return { inventory, diagnostics: scanned.diagnostics };
  });

  const list = Effect.fn("PluginManager.list")(function* (input: { readonly cwd: string }) {
    const instances = yield* instanceRegistry.listInstances;
    const scanned = yield* Effect.forEach(instances, (instance) => scan(instance, input.cwd), {
      concurrency: 4,
    });
    return {
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      instances: scanned.map((result) => result.inventory),
      diagnostics: scanned.flatMap((result) => [...result.diagnostics]),
    } satisfies PluginInventory;
  });

  const mutate = Effect.fn("PluginManager.mutate")(function* (input: {
    readonly operation: PluginMutationOperation;
    readonly instanceId: ProviderInstanceId;
    readonly cwd: string;
    readonly pluginId: string;
    readonly scope: PluginSetEnabledInput["scope"];
    readonly expectedRevision: string;
    readonly enabled?: boolean;
  }) {
    // assertContains 失败后借 project 范围写到任意目录。
    const workspaceError = (cause: unknown) =>
      new PluginManagerError({
        operation: input.operation,
        instanceId: input.instanceId,
        cwd: input.cwd,
        pluginId: input.pluginId,
        reason: "unknown-workspace",
        detail: String(cause),
      });
    yield* knownWorkspaces.assertContains(input.cwd).pipe(Effect.mapError(workspaceError));
    const instance = yield* instanceRegistry.getInstance(input.instanceId);
    const adapter = instance?.pluginManagement;
    if (instance === undefined || adapter === undefined) {
      return yield* new PluginManagerError({
        operation: input.operation,
        instanceId: input.instanceId,
        cwd: input.cwd,
        pluginId: input.pluginId,
        reason: "management-unavailable",
      });
    }
    yield* lockFor(adapter.configHome).withPermits(1)(
      Effect.gen(function* () {
        // 重扫必须在锁内：两台设备带着同一个旧 revision 同时排队时，第二个要看到新的 revision。
        const rescanned = yield* scan(instance, input.cwd);
        if (rescanned.diagnostics.length > 0) {
          return yield* new PluginManagerError({
            operation: input.operation,
            instanceId: input.instanceId,
            cwd: input.cwd,
            pluginId: input.pluginId,
            reason: "provider-failed",
            detail: rescanned.diagnostics.join(" "),
          });
        }
        if (rescanned.inventory.revision !== input.expectedRevision) {
          return yield* new PluginManagerConflictError({
            instanceId: input.instanceId,
            cwd: input.cwd,
            expectedRevision: input.expectedRevision,
            actualRevision: rescanned.inventory.revision,
          });
        }
        const target = rescanned.inventory.entries.find(
          (entry) => entry.pluginId === input.pluginId && entry.scope === input.scope,
        );
        if (target === undefined) {
          return yield* new PluginManagerError({
            operation: input.operation,
            instanceId: input.instanceId,
            cwd: input.cwd,
            pluginId: input.pluginId,
            reason: "unknown-plugin",
          });
        }
        const allowed =
          input.operation === "setEnabled"
            ? target.actions.canSetEnabled
            : target.actions.canUninstall;
        if (!allowed) {
          return yield* new PluginManagerError({
            operation: input.operation,
            instanceId: input.instanceId,
            cwd: input.cwd,
            pluginId: input.pluginId,
            reason: "action-not-allowed",
            ...(target.actions.reason === undefined ? {} : { detail: target.actions.reason }),
          });
        }
        yield* (
          input.operation === "setEnabled"
            ? adapter.setEnabled({
                cwd: input.cwd,
                pluginId: input.pluginId,
                scope: input.scope,
                enabled: input.enabled ?? true,
              })
            : adapter.uninstall({
                cwd: input.cwd,
                pluginId: input.pluginId,
                scope: input.scope,
              })
        ).pipe(
          Effect.mapError(
            (cause) =>
              new PluginManagerError({
                operation: input.operation,
                instanceId: input.instanceId,
                cwd: input.cwd,
                pluginId: input.pluginId,
                reason: "provider-failed",
                detail: String(cause),
              }),
          ),
        );
        // 共用同一配置目录的实例都会看到这次改动。
        const instances = yield* instanceRegistry.listInstances;
        const shared = instances.filter(
          (candidate) =>
            candidate.enabled && candidate.pluginManagement?.configHome === adapter.configHome,
        );
        yield* Effect.forEach(
          shared,
          (candidate) =>
            providerRegistry
              .refreshWorkspaceSnapshot({ instanceId: candidate.instanceId, cwd: input.cwd })
              .pipe(Effect.ignoreCause({ log: true })),
          { concurrency: 1 },
        );
      }),
    );

    return { requiresSessionRestart: true } satisfies PluginMutationResult;
  });

  return {
    list,
    setEnabled: (input: PluginSetEnabledInput) =>
      mutate({
        operation: "setEnabled",
        instanceId: input.instanceId,
        cwd: input.cwd,
        pluginId: input.pluginId,
        scope: input.scope,
        expectedRevision: input.expectedRevision,
        enabled: input.enabled,
      }),
    uninstall: (input: PluginUninstallInput) =>
      mutate({
        operation: "uninstall",
        instanceId: input.instanceId,
        cwd: input.cwd,
        pluginId: input.pluginId,
        scope: input.scope,
        expectedRevision: input.expectedRevision,
      }),
  };
});

export class PluginManager extends Context.Service<
  PluginManager,
  {
    readonly list: (input: { readonly cwd: string }) => Effect.Effect<PluginInventory>;
    readonly setEnabled: (
      input: PluginSetEnabledInput,
    ) => Effect.Effect<PluginMutationResult, PluginManagerError | PluginManagerConflictError>;
    readonly uninstall: (
      input: PluginUninstallInput,
    ) => Effect.Effect<PluginMutationResult, PluginManagerError | PluginManagerConflictError>;
  }
>()("t3/provider/PluginManager") {}

export const layer = Layer.effect(PluginManager, make);
