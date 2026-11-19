import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { PluginInventoryEntry } from "@t3tools/contracts";
import type {
  ProviderInstance,
  ProviderPluginManagement,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as PluginManager from "./PluginManager.ts";

const cwd = "/repo";
const driverKind = ProviderDriverKind.make("claudeAgent");

const entry = (overrides: Partial<PluginInventoryEntry> = {}): PluginInventoryEntry => {
  const instanceId = overrides.instanceId ?? ProviderInstanceId.make("claude");
  return {
    instanceId,
    cwd,
    configHome: "/home/user/.claude",
    pluginId: "superpowers@official",
    name: "superpowers",
    scope: "user",
    state: "enabled",
    notes: [],
    actions: { canSetEnabled: true, canUninstall: true },
    ...overrides,
  };
};

const makeInstance = (
  id: string,
  pluginManagement: ProviderPluginManagement | undefined,
): ProviderInstance => {
  const instanceId = ProviderInstanceId.make(id);
  return {
    instanceId,
    driverKind,
    continuationIdentity: { driverKind, continuationKey: instanceId },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
    ...(pluginManagement === undefined ? {} : { pluginManagement }),
  };
};

const management = (options: {
  readonly configHome?: string;
  readonly entries?: ReadonlyArray<PluginInventoryEntry>;
  readonly setEnabled?: () => Effect.Effect<void, ProviderDriverError>;
  readonly uninstall?: () => Effect.Effect<void, ProviderDriverError>;
  readonly listFails?: boolean;
}): ProviderPluginManagement => ({
  configHome: options.configHome ?? "/home/user/.claude",
  list: () =>
    options.listFails
      ? Effect.fail(
          new ProviderDriverError({
            driver: driverKind,
            instanceId: ProviderInstanceId.make("claude"),
            detail: "boom",
          }),
        )
      : Effect.succeed({ entries: options.entries ?? [entry()], diagnostics: [] }),
  setEnabled: options.setEnabled ?? (() => Effect.void),
  uninstall: options.uninstall ?? (() => Effect.void),
});

const makeHarness = (input: {
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly assertContains?: KnownWorkspaces.KnownWorkspaces["Service"]["assertContains"];
}) => {
  const refreshes: Array<{ instanceId: string; cwd: string }> = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (id) =>
        Effect.succeed(input.instances.find((candidate) => candidate.instanceId === id)),
      listInstances: Effect.succeed(input.instances),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      refreshWorkspaceSnapshot: (refreshInput) =>
        Effect.sync(() => {
          refreshes.push(refreshInput);
        }).pipe(Effect.as([])),
      refreshWorkspaceSnapshotStrict: (refreshInput) =>
        Effect.sync(() => {
          refreshes.push(refreshInput);
        }).pipe(Effect.as([])),
    }),
    Layer.mock(KnownWorkspaces.KnownWorkspaces)({
      assertContains: input.assertContains ?? (() => Effect.void),
    }),
    NodeCrypto.layer,
    NodeServices.layer,
    Digest.layerWebCrypto,
  );
  const layer = PluginManager.layer.pipe(Layer.provideMerge(dependencies));
  return {
    manager: PluginManager.PluginManager.pipe(Effect.provide(layer)),
    refreshes,
  };
};

it.effect("marks instances without an adapter unsupported", () =>
  Effect.gen(function* () {
    const { manager: managerEffect } = makeHarness({
      instances: [makeInstance("codex", undefined), makeInstance("claude", management({}))],
    });

    const manager = yield* managerEffect;
    const inventory = yield* manager.list({ cwd });

    const unsupported = inventory.instances.find((item) => item.instanceId === "codex");
    assert.isFalse(unsupported?.supported);
    assert.deepEqual(unsupported?.entries, []);
    assert.isTrue(inventory.instances.find((item) => item.instanceId === "claude")?.supported);
  }),
);

it.effect("turns a list failure into a diagnostic", () =>
  Effect.gen(function* () {
    const { manager: managerEffect } = makeHarness({
      instances: [makeInstance("broken", management({ listFails: true }))],
    });

    const manager = yield* managerEffect;
    const inventory = yield* manager.list({ cwd });

    assert.deepEqual(inventory.instances[0]?.entries, []);
    assert.isTrue(inventory.diagnostics.some((line) => line.includes("broken")));
  }),
);

it.effect("rejects a stale revision before touching the provider", () =>
  Effect.gen(function* () {
    let calls = 0;
    const { manager: managerEffect } = makeHarness({
      instances: [
        makeInstance(
          "claude",
          management({
            setEnabled: () => {
              calls += 1;
              return Effect.void;
            },
          }),
        ),
      ],
    });

    const manager = yield* managerEffect;
    const error = yield* manager
      .setEnabled({
        instanceId: ProviderInstanceId.make("claude"),
        cwd,
        pluginId: "superpowers@official",
        scope: "user",
        expectedRevision: "old",
        enabled: false,
      })
      .pipe(Effect.flip);

    assert.equal(error._tag, "PluginManagerConflictError");
    assert.equal(calls, 0);
  }),
);

it.effect("rejects a second device holding an old revision", () =>
  Effect.gen(function* () {
    const { manager: managerEffect } = makeHarness({
      instances: [makeInstance("claude", management({}))],
    });
    const manager = yield* managerEffect;
    const before = yield* manager.list({ cwd });
    const revision = before.instances[0]!.revision;

    yield* manager.setEnabled({
      instanceId: ProviderInstanceId.make("claude"),
      cwd,
      pluginId: "superpowers@official",
      scope: "user",
      expectedRevision: revision,
      enabled: false,
    });

    const error = yield* manager
      .uninstall({
        instanceId: ProviderInstanceId.make("claude"),
        cwd,
        pluginId: "superpowers@official",
        scope: "user",
        expectedRevision: "stale",
      })
      .pipe(Effect.flip);

    assert.equal(error._tag, "PluginManagerConflictError");
  }),
);

it.effect("rejects a plugin that is not in the inventory", () =>
  Effect.gen(function* () {
    const { manager: managerEffect } = makeHarness({
      instances: [makeInstance("claude", management({}))],
    });
    const manager = yield* managerEffect;
    const inventory = yield* manager.list({ cwd });
    const error = yield* manager
      .setEnabled({
        instanceId: ProviderInstanceId.make("claude"),
        cwd,
        pluginId: "ghost@official",
        scope: "user",
        expectedRevision: inventory.instances[0]!.revision,
        enabled: false,
      })
      .pipe(Effect.flip);

    if (error._tag !== "PluginManagerError") throw error;
    assert.equal(error.reason, "unknown-plugin");
  }),
);

it.effect("rejects an action the inventory forbids", () =>
  Effect.gen(function* () {
    const readOnly = entry({ actions: { canSetEnabled: false, canUninstall: false } });
    const { manager: managerEffect } = makeHarness({
      instances: [makeInstance("claude", management({ entries: [readOnly] }))],
    });
    const manager = yield* managerEffect;
    const inventory = yield* manager.list({ cwd });
    const error = yield* manager
      .uninstall({
        instanceId: ProviderInstanceId.make("claude"),
        cwd,
        pluginId: "superpowers@official",
        scope: "user",
        expectedRevision: inventory.instances[0]!.revision,
      })
      .pipe(Effect.flip);

    if (error._tag !== "PluginManagerError") throw error;
    assert.equal(error.reason, "action-not-allowed");
  }),
);

it.effect("rejects an unknown workspace", () =>
  Effect.gen(function* () {
    const { manager: managerEffect } = makeHarness({
      instances: [makeInstance("claude", management({}))],
      assertContains: () => Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd })),
    });

    const manager = yield* managerEffect;
    const error = yield* manager
      .uninstall({
        instanceId: ProviderInstanceId.make("claude"),
        cwd,
        pluginId: "superpowers@official",
        scope: "user",
        expectedRevision: "revision",
      })
      .pipe(Effect.flip);

    if (error._tag !== "PluginManagerError") throw error;
    assert.equal(error.reason, "unknown-workspace");
  }),
);

it.effect("serializes mutations sharing a configHome", () =>
  Effect.gen(function* () {
    const blocker = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    let calls = 0;
    const slow = management({
      setEnabled: () => {
        calls += 1;
        return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(blocker)));
      },
    });
    const fast = management({
      setEnabled: () => {
        calls += 1;
        return Effect.void;
      },
    });
    const instances = [makeInstance("claude-a", slow), makeInstance("claude-b", fast)];
    const { manager: managerEffect } = makeHarness({ instances });

    const manager = yield* managerEffect;
    const inventory = yield* manager.list({ cwd });
    const firstRevision = inventory.instances[0]!.revision;
    const first = yield* Effect.forkChild(
      manager.setEnabled({
        instanceId: ProviderInstanceId.make("claude-a"),
        cwd,
        pluginId: "superpowers@official",
        scope: "user",
        expectedRevision: firstRevision,
        enabled: false,
      }),
    );
    yield* Effect.yieldNow;
    const second = yield* Effect.forkChild(
      manager.setEnabled({
        instanceId: ProviderInstanceId.make("claude-b"),
        cwd,
        pluginId: "superpowers@official",
        scope: "user",
        expectedRevision: inventory.instances[1]!.revision,
        enabled: false,
      }),
    );
    yield* Deferred.await(entered);
    yield* Effect.yieldNow;
    assert.equal(calls, 1);

    yield* Deferred.succeed(blocker, undefined);
    yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
    assert.equal(calls, 2);
  }),
);

it.effect("reports a failed rescans as a provider failure, not a conflict", () =>
  Effect.gen(function* () {
    let failScan = false;
    const adapter: ProviderPluginManagement = {
      configHome: "/home/user/.claude",
      list: () =>
        failScan
          ? Effect.succeed({
              entries: [],
              diagnostics: ["Plugin scan failed for provider instance 'claude': boom"],
            })
          : Effect.succeed({ entries: [entry()], diagnostics: [] }),
      setEnabled: () => Effect.void,
      uninstall: () => Effect.void,
    };
    const { manager: managerEffect } = makeHarness({
      instances: [makeInstance("claude", adapter)],
    });
    const manager = yield* managerEffect;
    const before = yield* manager.list({ cwd });
    const revision = before.instances[0]!.revision;
    failScan = true;

    const error = yield* manager
      .setEnabled({
        instanceId: ProviderInstanceId.make("claude"),
        cwd,
        pluginId: "superpowers@official",
        scope: "user",
        expectedRevision: revision,
        enabled: false,
      })
      .pipe(Effect.flip);

    assert.equal(error._tag, "PluginManagerError");
    if (error._tag === "PluginManagerError") {
      assert.equal(error.reason, "provider-failed");
      assert.include(error.detail ?? "", "boom");
    }
  }),
);

it.effect("rejects a second mutation queued behind one that changed the inventory", () =>
  Effect.gen(function* () {
    const blocker = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    let mutated = false;
    const adapter: ProviderPluginManagement = {
      configHome: "/home/user/.claude",
      list: () =>
        Effect.succeed({
          entries: [entry({ state: mutated ? "disabled" : "enabled" })],
          diagnostics: [],
        }),
      setEnabled: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(blocker)),
          Effect.tap(() =>
            Effect.sync(() => {
              mutated = true;
            }),
          ),
        ),
      uninstall: () => Effect.void,
    };
    const { manager: managerEffect } = makeHarness({
      instances: [makeInstance("claude", adapter)],
    });
    const manager = yield* managerEffect;
    const before = yield* manager.list({ cwd });
    const revision = before.instances[0]!.revision;

    const first = yield* manager
      .setEnabled({
        instanceId: ProviderInstanceId.make("claude"),
        cwd,
        pluginId: "superpowers@official",
        scope: "user",
        expectedRevision: revision,
        enabled: false,
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const second = yield* manager
      .setEnabled({
        instanceId: ProviderInstanceId.make("claude"),
        cwd,
        pluginId: "superpowers@official",
        scope: "user",
        expectedRevision: revision,
        enabled: true,
      })
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* Deferred.succeed(blocker, undefined);
    yield* Fiber.join(first);
    const secondResult = yield* Fiber.join(second);

    assert.equal(secondResult._tag, "Failure");
    if (secondResult._tag === "Failure") {
      assert.equal(secondResult.failure._tag, "PluginManagerConflictError");
    }
  }),
);

it.effect("refreshes every enabled instance sharing the configHome", () =>
  Effect.gen(function* () {
    const instances = [
      makeInstance("claude-a", management({})),
      makeInstance("claude-b", management({})),
      makeInstance("codex", management({ configHome: "/home/user/.codex" })),
    ];
    const { manager: managerEffect, refreshes } = makeHarness({ instances });
    const manager = yield* managerEffect;
    const inventory = yield* manager.list({ cwd });

    yield* manager.setEnabled({
      instanceId: ProviderInstanceId.make("claude-a"),
      cwd,
      pluginId: "superpowers@official",
      scope: "user",
      expectedRevision: inventory.instances[0]!.revision,
      enabled: false,
    });

    assert.deepEqual(refreshes.map((refresh) => refresh.instanceId).sort(), [
      "claude-a",
      "claude-b",
    ]);
  }),
);
