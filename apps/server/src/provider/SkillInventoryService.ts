import {
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
  type SkillInventory,
  type SkillInventoryEntry,
  type SkillSource,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const READ_ONLY_REASON = "This source is read-only in the first version.";
const READ_ONLY_ACTIONS: SkillInventoryEntry["actions"] = {
  canSetEnabled: false,
  canUninstall: false,
  reason: READ_ONLY_REASON,
};

export class SkillInventoryConflictError extends Schema.TaggedError<SkillInventoryConflictError>()(
  "SkillInventoryConflictError",
  {
    instanceId: Schema.optionalKey(ProviderInstanceId),
    cwd: Schema.String,
    expectedRevision: Schema.String,
    actualRevision: Schema.String,
  },
) {
  override get message(): string {
    return `Skill inventory for '${this.cwd}' changed after revision '${this.expectedRevision}'.`;
  }
}

export class SkillInventoryService extends Context.Service<
  SkillInventoryService,
  {
    readonly list: (input: {
      readonly instanceId?: ProviderInstanceId;
      readonly cwd: string;
      readonly expectedRevision?: string;
    }) => Effect.Effect<
      SkillInventory,
      SkillInventoryConflictError | KnownWorkspaces.UnknownWorkspaceError
    >;
  }
>()("t3/provider/SkillInventoryService") {}

interface InstanceInventory {
  readonly entries: ReadonlyArray<SkillInventoryEntry>;
  readonly diagnostics: ReadonlyArray<string>;
}

const isReadOnlySource = (source: SkillSource): boolean =>
  source.kind !== "file" ||
  source.scope === "managed" ||
  source.scope === "agent" ||
  source.path?.startsWith("acp://") === true;

const normalizeEntry = (
  entry: SkillInventoryEntry,
  instanceId: ProviderInstanceId,
  cwd: string,
  forceReadOnly = false,
): SkillInventoryEntry => ({
  instanceId,
  cwd,
  nativeId: entry.nativeId,
  name: entry.name,
  ...(entry.description === undefined ? {} : { description: entry.description }),
  source: {
    kind: entry.source.kind,
    scope: entry.source.scope,
    ...(entry.source.path === undefined ? {} : { path: entry.source.path }),
    ...(entry.source.containerId === undefined ? {} : { containerId: entry.source.containerId }),
  },
  state: entry.state,
  actions:
    forceReadOnly || isReadOnlySource(entry.source)
      ? READ_ONLY_ACTIONS
      : {
          canSetEnabled: entry.actions.canSetEnabled,
          canUninstall: entry.actions.canUninstall,
          ...(entry.actions.reason === undefined ? {} : { reason: entry.actions.reason }),
        },
});

const snapshotSource = (skill: ServerProviderSkill): SkillSource => {
  if (skill.path.startsWith("acp://") || skill.scope === "agent") {
    return { kind: "agent", scope: "agent", path: skill.path };
  }
  if (skill.scope === "plugin" || skill.scope === "package") {
    return { kind: skill.scope, scope: "managed", path: skill.path };
  }
  if (skill.scope === "managed" || skill.scope === "system") {
    return { kind: "managed", scope: "managed", path: skill.path };
  }
  const scope =
    skill.scope === "user" || skill.scope === "project" || skill.scope === "local"
      ? skill.scope
      : "local";
  return { kind: "file", scope, path: skill.path };
};

const snapshotEntry = (
  skill: ServerProviderSkill,
  instanceId: ProviderInstanceId,
  cwd: string,
): SkillInventoryEntry =>
  normalizeEntry(
    {
      instanceId,
      cwd,
      nativeId: skill.path,
      name: skill.name,
      ...(skill.description === undefined ? {} : { description: skill.description }),
      source: snapshotSource(skill),
      state: skill.enabled ? "enabled" : "disabled",
      actions: READ_ONLY_ACTIONS,
    },
    instanceId,
    cwd,
    true,
  );

const snapshotInventory = (
  instance: ProviderInstance,
  provider: ServerProvider | undefined,
  cwd: string,
): InstanceInventory => {
  if (provider === undefined) {
    return {
      entries: [],
      diagnostics: [`Skill scan failed for provider instance '${instance.instanceId}'.`],
    };
  }
  const workspace = provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
  const mergedSkills = new Map<string, ServerProviderSkill>();
  for (const skill of provider.skills) mergedSkills.set(skill.path, skill);
  for (const skill of workspace?.skills ?? []) mergedSkills.set(skill.path, skill);
  const diagnostics =
    instance.snapshotForCwd !== undefined && provider.enabled && workspace === undefined
      ? [`Skill scan failed for provider instance '${instance.instanceId}'.`]
      : [];
  return {
    entries: [...mergedSkills.values()].map((skill) =>
      snapshotEntry(skill, instance.instanceId, cwd),
    ),
    diagnostics,
  };
};

const revisionPayload = (inventory: InstanceInventory): Uint8Array => {
  const entries = inventory.entries.map((entry) => JSON.stringify(entry)).sort();
  const diagnostics = [...inventory.diagnostics].sort();
  return new TextEncoder().encode(JSON.stringify({ entries, diagnostics }));
};

const make = Effect.gen(function* () {
  const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digester = yield* Digest.Digest;

  const assertWorkspace = Effect.fn("SkillInventoryService.assertWorkspace")(function* (
    cwd: string,
  ) {
    yield* knownWorkspaces.assertContains(cwd);
    const realCwd = yield* fileSystem
      .realPath(path.resolve(cwd))
      .pipe(Effect.mapError((cause) => new KnownWorkspaces.UnknownWorkspaceError({ cwd, cause })));
    const projectClaude = path.join(realCwd, ".claude");
    const realProjectClaude = yield* fileSystem.realPath(projectClaude).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
      Effect.mapError((cause) => new KnownWorkspaces.UnknownWorkspaceError({ cwd, cause })),
    );
    if (
      realProjectClaude !== undefined &&
      !KnownWorkspaces.isWithinRoot(path, realProjectClaude, realCwd)
    ) {
      return yield* new KnownWorkspaces.UnknownWorkspaceError({ cwd });
    }
  });

  const scanInstance = Effect.fn("SkillInventoryService.scanInstance")(function* (
    instance: ProviderInstance,
    cwd: string,
  ): Effect.fn.Return<InstanceInventory> {
    const recover = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      return Effect.succeed<InstanceInventory>({
        entries: [],
        diagnostics: [`Skill scan failed for provider instance '${instance.instanceId}'.`],
      });
    };
    if (instance.skillInventory !== undefined) {
      return yield* instance.skillInventory.list(cwd).pipe(
        Effect.map((inventory) => ({
          entries: inventory.entries.map((entry) =>
            normalizeEntry(entry, instance.instanceId, cwd),
          ),
          diagnostics: [...inventory.diagnostics],
        })),
        Effect.catchCause(recover),
      );
    }
    return yield* providerRegistry
      .refreshWorkspaceSnapshotStrict({ instanceId: instance.instanceId, cwd })
      .pipe(
        Effect.map((providers) =>
          snapshotInventory(
            instance,
            providers.find((provider) => provider.instanceId === instance.instanceId),
            cwd,
          ),
        ),
        Effect.catchCause(recover),
      );
  });

  const list = Effect.fn("SkillInventoryService.list")(function* (input: {
    readonly instanceId?: ProviderInstanceId;
    readonly cwd: string;
    readonly expectedRevision?: string;
  }) {
    yield* assertWorkspace(input.cwd);
    const selectedInstance =
      input.instanceId === undefined
        ? undefined
        : yield* instanceRegistry.getInstance(input.instanceId);
    const instances = yield* instanceRegistry.listInstances;
    const scanned = yield* Effect.forEach(
      instances,
      (instance) => scanInstance(instance, input.cwd),
      {
        concurrency: 4,
      },
    );
    // 同一 plugin 可能经 manifest 的 skills 列表和默认目录各报一次，nativeId 相同。
    const entriesByKey = new Map<string, (typeof scanned)[number]["entries"][number]>();
    for (const entry of scanned.flatMap((result) => [...result.entries])) {
      const key = `${entry.instanceId}:${entry.cwd}:${entry.nativeId}`;
      if (!entriesByKey.has(key)) entriesByKey.set(key, entry);
    }
    const inventory: InstanceInventory = {
      entries: [...entriesByKey.values()],
      diagnostics: [
        ...(input.instanceId !== undefined && selectedInstance === undefined
          ? [`Provider instance '${input.instanceId}' is unavailable.`]
          : []),
        ...scanned.flatMap((result) => [...result.diagnostics]),
      ],
    };
    const revision = Hex.encode(yield* digester.digest(Digest.sha256, revisionPayload(inventory)));
    if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
      return yield* new SkillInventoryConflictError({
        ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
        cwd: input.cwd,
        expectedRevision: input.expectedRevision,
        actualRevision: revision,
      });
    }
    return {
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      revision,
      entries:
        input.instanceId === undefined
          ? inventory.entries
          : inventory.entries.filter((entry) => entry.instanceId === input.instanceId),
      diagnostics: inventory.diagnostics,
    } satisfies SkillInventory;
  });

  return SkillInventoryService.of({ list });
});

export const layer = Layer.effect(SkillInventoryService, make);
