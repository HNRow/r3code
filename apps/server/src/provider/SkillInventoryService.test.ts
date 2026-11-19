import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
  type SkillInventory,
  type SkillInventoryEntry,
} from "@t3tools/contracts";
import type {
  ProviderInstance,
  ProviderWorkspaceSnapshot,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as SkillInventoryService from "./SkillInventoryService.ts";

const cwd = process.cwd();
const readOnlyActions = {
  canSetEnabled: false,
  canUninstall: false,
  reason: "This source is read-only in the first version.",
} as const;

type AdapterResult = Pick<SkillInventory, "entries" | "diagnostics">;

const makeInstance = (
  instanceId: string,
  options: {
    readonly skillInventory?: {
      readonly list: (cwd: string) => Effect.Effect<AdapterResult, ProviderDriverError>;
    };
    readonly snapshotForCwd?: ProviderInstance["snapshotForCwd"];
  } = {},
): ProviderInstance => {
  const id = ProviderInstanceId.make(instanceId);
  const driverKind = ProviderDriverKind.make("claudeAgent");
  return {
    instanceId: id,
    driverKind,
    continuationIdentity: { driverKind, continuationKey: `${driverKind}:${id}` },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
    ...(options.snapshotForCwd === undefined ? {} : { snapshotForCwd: options.snapshotForCwd }),
    ...(options.skillInventory === undefined ? {} : { skillInventory: options.skillInventory }),
  };
};

const makeProvider = (input: {
  readonly instanceId: string;
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
  readonly workspaceSkills?: ReadonlyArray<ServerProviderSkill>;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: "2026-11-17T00:00:00.000Z",
  version: "1.0.0",
  models: [],
  slashCommands: [],
  skills: input.skills ?? [],
  ...(input.workspaceSkills === undefined
    ? {}
    : {
        workspaceSnapshots: [
          {
            cwd,
            checkedAt: "2026-11-17T00:00:00.000Z",
            slashCommands: [],
            skills: input.workspaceSkills,
          },
        ],
      }),
});

interface Harness {
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly refreshWorkspaceSnapshot?: ProviderRegistry.ProviderRegistry["Service"]["refreshWorkspaceSnapshot"];
  readonly assertContains?: KnownWorkspaces.KnownWorkspaces["Service"]["assertContains"];
  readonly realPath?: FileSystem.FileSystem["realPath"];
}

const makeLayer = (input: Harness) =>
  SkillInventoryService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (instanceId) =>
            Effect.succeed(input.instances.find((instance) => instance.instanceId === instanceId)),
          listInstances: Effect.succeed(input.instances),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          refreshWorkspaceSnapshot:
            input.refreshWorkspaceSnapshot ?? (() => Effect.succeed(input.providers ?? [])),
          refreshWorkspaceSnapshotStrict:
            input.refreshWorkspaceSnapshot ?? (() => Effect.succeed(input.providers ?? [])),
        }),
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({
          assertContains: input.assertContains ?? (() => Effect.void),
        }),
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      ),
    ),
  );

const list = (
  input: Parameters<SkillInventoryService.SkillInventoryService["Service"]["list"]>[0],
  harness: Harness,
) =>
  SkillInventoryService.SkillInventoryService.pipe(
    Effect.flatMap((service) => service.list(input)),
    Effect.provide(makeLayer(harness)),
  );

const adapterEntry = (
  nativeId: string,
  fields: Partial<SkillInventoryEntry> = {},
): SkillInventoryEntry => ({
  instanceId: "adapter-supplied-id",
  cwd: "/adapter/supplied/cwd",
  nativeId,
  name: nativeId,
  source: { kind: "file", scope: "project", path: `${cwd}/${nativeId}` },
  state: "enabled",
  actions: { canSetEnabled: false, canUninstall: false },
  ...fields,
});

describe("SkillInventoryService", () => {
  it.effect(
    "merges machine and cwd snapshots across instances without inventing shadowed entries",
    () => {
      const first = makeInstance("first", {
        snapshotForCwd: () => Effect.die("registry owns snapshot scanning"),
      });
      const second = makeInstance("second", {
        snapshotForCwd: () => Effect.die("registry owns snapshot scanning"),
      });
      const providers = [
        makeProvider({
          instanceId: "first",
          skills: [{ name: "global", path: "/skills/global", enabled: true, scope: "user" }],
          workspaceSkills: [
            { name: "global", path: "/skills/global", enabled: false, scope: "user" },
            { name: "project", path: "/skills/project", enabled: true, scope: "project" },
          ],
        }),
        makeProvider({
          instanceId: "second",
          skills: [{ name: "other", path: "/skills/other", enabled: false }],
          workspaceSkills: [],
        }),
      ];
      return Effect.gen(function* () {
        const inventory = yield* list({ cwd }, { instances: [first, second], providers });

        assert.deepStrictEqual(
          inventory.entries.map((entry) => [entry.instanceId, entry.nativeId, entry.state]),
          [
            ["first", "/skills/global", "disabled"],
            ["first", "/skills/project", "enabled"],
            ["second", "/skills/other", "disabled"],
          ],
        );
        assert.isTrue(inventory.entries.every((entry) => entry.state !== "shadowed"));
        assert.isTrue(
          inventory.entries.every(
            (entry) =>
              entry.actions.canSetEnabled === false &&
              entry.actions.canUninstall === false &&
              entry.actions.reason === readOnlyActions.reason,
          ),
        );
        assert.deepStrictEqual(inventory.diagnostics, []);
      });
    },
  );

  it.effect(
    "preserves adapter states and explicit file writes while forcing managed sources read-only",
    () => {
      const entries = [
        adapterEntry("disabled", { state: "disabled" }),
        adapterEntry("shadowed", { state: "shadowed" }),
        adapterEntry("acp", {
          source: { kind: "agent", scope: "agent", path: "acp://skill/acp" },
          actions: { canSetEnabled: true, canUninstall: true },
        }),
        adapterEntry("plugin", {
          source: { kind: "plugin", scope: "managed", containerId: "plugin-1" },
          actions: { canSetEnabled: true, canUninstall: true },
        }),
        adapterEntry("writable", {
          actions: { canSetEnabled: true, canUninstall: false },
        }),
        // 同一个 plugin 经 manifest 与默认目录各报一次：nativeId 相同，只保留第一条。
        adapterEntry("writable", { state: "disabled" }),
      ];
      const instance = makeInstance("claude", {
        skillInventory: { list: () => Effect.succeed({ entries, diagnostics: [] }) },
      });
      return Effect.gen(function* () {
        const inventory = yield* list(
          { instanceId: instance.instanceId, cwd },
          { instances: [instance] },
        );

        assert.deepStrictEqual(
          inventory.entries.map((entry) => entry.state),
          ["disabled", "shadowed", "enabled", "enabled", "enabled"],
        );
        assert.deepStrictEqual(inventory.entries[2]?.actions, readOnlyActions);
        assert.deepStrictEqual(inventory.entries[3]?.actions, readOnlyActions);
        assert.deepStrictEqual(inventory.entries[4]?.actions, {
          canSetEnabled: true,
          canUninstall: false,
        });
        assert.isTrue(inventory.entries.every((entry) => entry.instanceId === "claude"));
        assert.isTrue(inventory.entries.every((entry) => entry.cwd === cwd));
        assert.equal(inventory.entries.filter((entry) => entry.nativeId === "writable").length, 1);
      });
    },
  );

  it.effect("returns partial inventory and diagnostics when one instance scan fails", () => {
    const driverKind = ProviderDriverKind.make("claudeAgent");
    const broken = makeInstance("broken", {
      skillInventory: {
        list: () =>
          Effect.fail(
            new ProviderDriverError({
              driver: driverKind,
              instanceId: ProviderInstanceId.make("broken"),
              detail: "scan failed",
            }),
          ),
      },
    });
    const working = makeInstance("working", {
      snapshotForCwd: () => Effect.die("registry owns snapshot scanning"),
    });
    const providers = [
      makeProvider({
        instanceId: "working",
        workspaceSkills: [{ name: "working", path: "/skills/working", enabled: true }],
      }),
    ];
    return Effect.gen(function* () {
      const inventory = yield* list({ cwd }, { instances: [broken, working], providers });

      assert.deepStrictEqual(
        inventory.entries.map((entry) => entry.nativeId),
        ["/skills/working"],
      );
      assert.deepStrictEqual(inventory.diagnostics, [
        "Skill scan failed for provider instance 'broken'.",
      ]);
    });
  });

  it.effect("hashes sorted copies and changes revision for diagnostics-only updates", () => {
    let reversed = false;
    let diagnostics = ["a-diagnostic", "z-diagnostic"];
    const first = adapterEntry("first", { state: "shadowed" });
    const second = adapterEntry("second", { state: "disabled" });
    const instance = makeInstance("claude", {
      skillInventory: {
        list: () =>
          Effect.sync(() => ({
            entries: reversed ? [second, first] : [first, second],
            diagnostics: reversed ? [...diagnostics].reverse() : diagnostics,
          })),
      },
    });
    return Effect.gen(function* () {
      const initial = yield* list({ cwd }, { instances: [instance] });
      reversed = true;
      const next = yield* list(
        { cwd, expectedRevision: initial.revision },
        { instances: [instance] },
      );

      assert.strictEqual(next.revision, initial.revision);
      assert.match(next.revision, /^[a-f0-9]{64}$/);
      assert.deepStrictEqual(
        next.entries.map((entry) => entry.nativeId),
        ["second", "first"],
      );
      assert.deepStrictEqual(next.diagnostics, ["z-diagnostic", "a-diagnostic"]);

      diagnostics = ["a-diagnostic", "changed-diagnostic"];
      const conflict = yield* list(
        { cwd, expectedRevision: initial.revision },
        { instances: [instance] },
      ).pipe(Effect.flip);
      assert.strictEqual(conflict._tag, "SkillInventoryConflictError");
      if (conflict._tag === "SkillInventoryConflictError") {
        assert.strictEqual(conflict.expectedRevision, initial.revision);
        assert.notStrictEqual(conflict.actualRevision, initial.revision);
      }
    });
  });

  it.effect("changes the revision and rejects a stale expectedRevision", () => {
    let skills = [{ name: "one", path: "/skills/one", enabled: true }];
    const instance = makeInstance("claude", {
      snapshotForCwd: () => Effect.die("registry owns snapshot scanning"),
    });
    const harness: Harness = {
      instances: [instance],
      refreshWorkspaceSnapshot: () =>
        Effect.sync(() => [makeProvider({ instanceId: "claude", workspaceSkills: skills })]),
    };
    return Effect.gen(function* () {
      const initial = yield* list({ cwd }, harness);
      skills = [...skills, { name: "two", path: "/skills/two", enabled: false }];

      const conflict = yield* list({ cwd, expectedRevision: initial.revision }, harness).pipe(
        Effect.flip,
      );

      assert.strictEqual(conflict._tag, "SkillInventoryConflictError");
      if (conflict._tag === "SkillInventoryConflictError") {
        assert.strictEqual(conflict.expectedRevision, initial.revision);
        assert.notStrictEqual(conflict.actualRevision, initial.revision);
        assert.strictEqual(conflict.cwd, cwd);
      }
    });
  });

  it.effect("reports a strict registry scan failure without dropping other instances", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scans = yield* Queue.unbounded<{
          readonly instanceId: ProviderInstanceId;
          readonly result: Deferred.Deferred<ProviderWorkspaceSnapshot, ProviderDriverError>;
        }>();
        const makeLiveInstance = (instanceId: string): ProviderInstance => {
          const provider = makeProvider({ instanceId });
          const instance = makeInstance(instanceId, {
            snapshotForCwd: () =>
              Effect.gen(function* () {
                const result = yield* Deferred.make<
                  ProviderWorkspaceSnapshot,
                  ProviderDriverError
                >();
                yield* Queue.offer(scans, { instanceId: instance.instanceId, result });
                return yield* Deferred.await(result);
              }),
          });
          return {
            ...instance,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: instance.driverKind,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.succeed(provider),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
          };
        };
        const broken = makeLiveInstance("broken");
        const working = makeLiveInstance("working");
        const instances = [broken, working];
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
            listInstances: Effect.succeed(instances),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          },
        );
        const registryServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provide(
              Layer.mock(ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator)({}),
            ),
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(ModelManifest.layerTest),
            Layer.provideMerge(ProviderLatestVersions.layer),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "skill-inventory-strict-" }),
            ),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        );
        const registry = yield* ProviderRegistry.ProviderRegistry.pipe(
          Effect.provide(registryServices),
        );
        const seed = (instance: ProviderInstance, name: string) =>
          Effect.gen(function* () {
            const pending = yield* registry
              .refreshWorkspaceSnapshot({ instanceId: instance.instanceId, cwd })
              .pipe(Effect.forkChild);
            const scan = yield* Queue.take(scans);
            yield* Deferred.succeed(scan.result, {
              ...makeProvider({ instanceId: instance.instanceId }),
              skills: [{ name, path: `/skills/${name}`, enabled: true }],
            });
            yield* Fiber.join(pending);
          });
        yield* seed(broken, "broken-initial");
        yield* seed(working, "working-initial");
        yield* TestClock.adjust(PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS);
        const inventoryLayer = SkillInventoryService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
              layerInstanceRegistry,
              Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
              Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
            ),
          ),
        );
        const pending = yield* SkillInventoryService.SkillInventoryService.pipe(
          Effect.flatMap((service) => service.list({ cwd })),
          Effect.provide(inventoryLayer),
          Effect.forkChild,
        );
        const firstScan = yield* Queue.take(scans);
        const secondScan = yield* Queue.take(scans);
        for (const scan of [firstScan, secondScan]) {
          if (scan.instanceId === broken.instanceId) {
            yield* Deferred.fail(
              scan.result,
              new ProviderDriverError({
                driver: broken.driverKind,
                instanceId: broken.instanceId,
                detail: "strict workspace scan failed",
              }),
            );
          } else {
            yield* Deferred.succeed(scan.result, {
              ...makeProvider({ instanceId: working.instanceId }),
              skills: [{ name: "working-updated", path: "/skills/working-updated", enabled: true }],
            });
          }
        }

        const inventory = yield* Fiber.join(pending);

        assert.deepStrictEqual(inventory.diagnostics, [
          "Skill scan failed for provider instance 'broken'.",
        ]);
        assert.deepStrictEqual(
          inventory.entries.map((entry) => [entry.instanceId, entry.name]),
          [["working", "working-updated"]],
        );
        const cachedProviders = yield* registry.getProviders;
        assert.deepStrictEqual(
          cachedProviders
            .find((provider) => provider.instanceId === broken.instanceId)
            ?.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)
            ?.skills.map((skill) => skill.name),
          ["broken-initial"],
        );
      }),
    ),
  );
});

it.effect("rejects an unknown client-supplied cwd before scanning", () => {
  const unknownCwd = "/work/unregistered";
  const instance = makeInstance("claude", {
    skillInventory: { list: () => Effect.die("must not scan an unknown cwd") },
  });
  return Effect.gen(function* () {
    const error = yield* list(
      { cwd: unknownCwd },
      {
        instances: [instance],
        assertContains: (candidate) =>
          Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd: candidate })),
      },
    ).pipe(Effect.flip);

    assert.strictEqual(error._tag, "UnknownWorkspaceError");
    assert.strictEqual(error.cwd, unknownCwd);
  });
});

it.effect("hashes and diagnoses the aggregate inventory before filtering entries", () => {
  let secondEntries = [adapterEntry("second")];
  const first = makeInstance("first", {
    skillInventory: {
      list: () =>
        Effect.succeed({ entries: [adapterEntry("first")], diagnostics: ["first-diagnostic"] }),
    },
  });
  const second = makeInstance("second", {
    skillInventory: {
      list: () => Effect.sync(() => ({ entries: secondEntries, diagnostics: [] })),
    },
  });
  const harness = { instances: [first, second] };
  return Effect.gen(function* () {
    const aggregate = yield* list({ cwd }, harness);
    const filtered = yield* list({ instanceId: first.instanceId, cwd }, harness);

    assert.strictEqual(filtered.revision, aggregate.revision);
    assert.deepStrictEqual(
      filtered.entries.map((entry) => entry.instanceId),
      ["first"],
    );
    assert.deepStrictEqual(filtered.diagnostics, aggregate.diagnostics);

    secondEntries = [...secondEntries, adapterEntry("second-new")];
    const conflict = yield* list(
      { instanceId: first.instanceId, cwd, expectedRevision: filtered.revision },
      harness,
    ).pipe(Effect.flip);
    assert.strictEqual(conflict._tag, "SkillInventoryConflictError");
  });
});

it.layer(NodeServices.layer)("SkillInventoryService project path boundaries", (it) => {
  it.effect("rejects a project .claude symlink outside the real workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-inventory-boundary-" }),
      );
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "outside");
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* fs.makeDirectory(outside, { recursive: true });
      yield* fs.symlink(outside, path.join(workspace, ".claude"));

      const error = yield* list(
        { cwd: workspace },
        { instances: [], realPath: (candidate) => fs.realPath(candidate) },
      ).pipe(Effect.flip);

      assert.strictEqual(error._tag, "UnknownWorkspaceError");
      assert.strictEqual(error.cwd, workspace);
    }),
  );
});

it.effect("limits aggregate inventory scans to four concurrent instances", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<string>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let maximumActive = 0;
      const instances = Array.from({ length: 5 }, (_, index) =>
        makeInstance(`instance-${index}`, {
          skillInventory: {
            list: () =>
              Effect.gen(function* () {
                active++;
                maximumActive = Math.max(maximumActive, active);
                yield* Queue.offer(started, `instance-${index}`);
                yield* Deferred.await(release);
                active--;
                return { entries: [], diagnostics: [] };
              }),
          },
        }),
      );
      const pending = yield* list({ cwd }, { instances }).pipe(Effect.forkChild);
      for (let index = 0; index < 4; index++) yield* Queue.take(started);

      assert.strictEqual((yield* Queue.poll(started))._tag, "None");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pending);
      assert.strictEqual(maximumActive, 4);
    }),
  ),
);
