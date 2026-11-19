import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import { discoverClaudeSkillInventory, makeClaudeSkillManagement } from "./Drivers/ClaudeSkills.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as SkillInventoryService from "./SkillInventoryService.ts";
import * as SkillManager from "./SkillManager.ts";

const instanceId = ProviderInstanceId.make("claude_dp41sf");

const writeSkill = Effect.fn(function* (directory: string, contents = "# Skill\n") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(path.join(directory, "SKILL.md"), contents);
});

interface HarnessOptions {
  readonly fileSystem?: FileSystem.FileSystem;
  readonly refreshDies?: boolean;
  readonly refreshCause?: Cause.Cause<never>;
  readonly launchArgs?: string;
  readonly additionalInstances?: ReadonlyArray<ProviderInstance>;
  readonly assertContains?: KnownWorkspaces.KnownWorkspaces["Service"]["assertContains"];
}

const makeHarness = Effect.fn(function* (
  configDir: string,
  cwd: string,
  options: HarnessOptions = {},
) {
  const hostFileSystem = yield* FileSystem.FileSystem;
  const fs = options.fileSystem ?? hostFileSystem;
  const path = yield* Path.Path;
  const driverKind = ProviderDriverKind.make("claudeAgent");
  const config = {
    homePath: configDir,
    ...(options.launchArgs === undefined ? {} : { launchArgs: options.launchArgs }),
  };
  const management = yield* makeClaudeSkillManagement({
    instanceId,
    config,
    environment: {},
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
  const refreshes: Array<{ instanceId: string; cwd: string }> = [];
  const instance: ProviderInstance = {
    instanceId,
    driverKind,
    continuationIdentity: { driverKind, continuationKey: instanceId },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
    skillInventory: {
      list: (scanCwd) =>
        discoverClaudeSkillInventory(config, scanCwd, {}, instanceId).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.Platform, "win32"),
        ),
    },
    skillManagement: management,
  };
  const instances = [...(options.additionalInstances ?? []), instance];
  const instanceRegistry = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (id) => Effect.succeed(instances.find((candidate) => candidate.instanceId === id)),
    listInstances: Effect.succeed(instances),
  });
  const refresh = (input: { instanceId: ProviderInstanceId; cwd: string }) =>
    Effect.sync(() => {
      refreshes.push(input);
    }).pipe(
      Effect.andThen(
        options.refreshCause !== undefined
          ? Effect.failCause(options.refreshCause)
          : options.refreshDies
            ? Effect.die("injected refresh failure")
            : Effect.void,
      ),
      Effect.as([]),
    );
  const providerRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
    refreshWorkspaceSnapshot: refresh,
    refreshWorkspaceSnapshotStrict: refresh,
  });
  const dependencies = Layer.mergeAll(
    instanceRegistry,
    providerRegistry,
    Layer.mock(KnownWorkspaces.KnownWorkspaces)({
      assertContains: options.assertContains ?? (() => Effect.void),
    }),
    NodeCrypto.layer,
    Layer.succeed(FileSystem.FileSystem, fs),
  );
  const layer = SkillManager.layer.pipe(
    Layer.provideMerge(SkillInventoryService.layer),
    Layer.provide(dependencies),
  );
  const manager = SkillManager.SkillManager.pipe(Effect.provide(layer));
  const inventory = (expectedRevision?: string, filteredInstanceId?: ProviderInstanceId) =>
    SkillInventoryService.SkillInventoryService.pipe(
      Effect.flatMap((service) =>
        service.list({
          cwd,
          ...(expectedRevision ? { expectedRevision } : {}),
          ...(filteredInstanceId ? { instanceId: filteredInstanceId } : {}),
        }),
      ),
      Effect.provide(layer),
    );
  return { manager, inventory, refreshes };
});

const makeFixture = Effect.fn(function* (options?: HarnessOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-manager-" });
  const configDir = path.join(root, "claude-config");
  const cwd = path.join(root, "workspace");
  const sourceFolder = path.join(root, "source");
  yield* fs.makeDirectory(cwd, { recursive: true });
  yield* writeSkill(sourceFolder);
  const harness = yield* makeHarness(configDir, cwd, options);
  return { root, configDir, cwd, sourceFolder, ...harness };
});

const makeAdditionalInventoryInstance = (
  cwd: string,
  nativeId = "user:other",
): ProviderInstance => {
  const otherInstanceId = ProviderInstanceId.make("claude_other");
  const driverKind = ProviderDriverKind.make("claudeAgent");
  return {
    instanceId: otherInstanceId,
    driverKind,
    continuationIdentity: { driverKind, continuationKey: otherInstanceId },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
    skillInventory: {
      list: () =>
        Effect.succeed({
          entries: [
            {
              instanceId: otherInstanceId,
              cwd,
              nativeId,
              name: nativeId,
              source: { kind: "file", scope: "user", path: "/other/SKILL.md" },
              state: "enabled",
              actions: { canSetEnabled: false, canUninstall: false },
            },
          ],
          diagnostics: [],
        }),
    },
  };
};

const makeSameNameFixture = () =>
  makeFixture({
    additionalInstances: [makeAdditionalInventoryInstance("/other", "user:review")],
  });

it.layer(NodeServices.layer)("SkillManager", (it) => {
  it.effect("accepts an aggregate inventory revision across provider instances", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture({
        additionalInstances: [makeAdditionalInventoryInstance("/other")],
      });
      yield* writeSkill(path.join(fixture.configDir, "skills", "existing"));
      const initial = yield* fixture.inventory();
      assert.deepStrictEqual(
        [...new Set(initial.entries.map((entry) => entry.instanceId))].sort(),
        [instanceId, "claude_other"].sort(),
      );

      const result = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:review",
            sourceFolder: fixture.sourceFolder,
            expectedRevision: initial.revision,
          }),
        ),
      );

      assert.deepStrictEqual(result, { requiresSessionRestart: true });
      assert.isTrue(yield* fs.exists(path.join(fixture.configDir, "skills", "review", "SKILL.md")));
    }),
  );

  it.effect(
    "installs into the target instance when another instance has the same nativeId first",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeSameNameFixture();
        const initial = yield* fixture.inventory();
        assert.strictEqual(initial.entries[0]?.instanceId, "claude_other");
        assert.strictEqual(initial.entries[0]?.nativeId, "user:review");

        const result = yield* fixture.manager.pipe(
          Effect.flatMap((manager) =>
            manager.installSkill({
              instanceId,
              cwd: fixture.cwd,
              nativeId: "user:review",
              sourceFolder: fixture.sourceFolder,
              expectedRevision: initial.revision,
            }),
          ),
        );

        assert.deepStrictEqual(result, { requiresSessionRestart: true });
        assert.isTrue(
          yield* fs.exists(path.join(fixture.configDir, "skills", "review", "SKILL.md")),
        );
        const next = yield* fixture.inventory();
        assert.isTrue(
          next.entries.some(
            (entry) => entry.instanceId === instanceId && entry.nativeId === "user:review",
          ),
        );
        assert.isTrue(
          next.entries.some(
            (entry) => entry.instanceId === "claude_other" && entry.nativeId === "user:review",
          ),
        );
      }),
  );

  it.effect("toggles the target instance when another instance has the same nativeId first", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = yield* makeSameNameFixture();
      yield* writeSkill(path.join(fixture.configDir, "skills", "review"));
      const initial = yield* fixture.inventory();
      assert.strictEqual(initial.entries[0]?.instanceId, "claude_other");

      const result = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.setSkillEnabled({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:review",
            enabled: false,
            expectedRevision: initial.revision,
          }),
        ),
      );

      assert.deepStrictEqual(result, { requiresSessionRestart: true });
      const next = yield* fixture.inventory();
      const target = next.entries.find(
        (entry) => entry.instanceId === instanceId && entry.nativeId === "user:review",
      );
      const other = next.entries.find(
        (entry) => entry.instanceId === "claude_other" && entry.nativeId === "user:review",
      );
      assert.strictEqual(target?.state, "disabled");
      assert.strictEqual(other?.state, "enabled");
    }),
  );

  it.effect(
    "uninstalls the target instance when another instance has the same nativeId first",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeSameNameFixture();
        const destination = path.join(fixture.configDir, "skills", "review");
        yield* writeSkill(destination);
        yield* fs.writeFileString(
          path.join(destination, ".t3-skill-install.json"),
          JSON.stringify({
            version: 1,
            instanceId,
            nativeId: "review",
            installedBy: "r3-code",
          }),
        );
        const initial = yield* fixture.inventory();
        assert.strictEqual(initial.entries[0]?.instanceId, "claude_other");

        const result = yield* fixture.manager.pipe(
          Effect.flatMap((manager) =>
            manager.uninstallSkill({
              instanceId,
              cwd: fixture.cwd,
              nativeId: "user:review",
              expectedRevision: initial.revision,
            }),
          ),
        );

        assert.deepStrictEqual(result, { requiresSessionRestart: true });
        assert.isFalse(yield* fs.exists(destination));
        const next = yield* fixture.inventory();
        assert.isFalse(
          next.entries.some(
            (entry) => entry.instanceId === instanceId && entry.nativeId === "user:review",
          ),
        );
        const other = next.entries.find(
          (entry) => entry.instanceId === "claude_other" && entry.nativeId === "user:review",
        );
        assert.strictEqual(other?.state, "enabled");
      }),
  );

  it.effect("rejects traversal and absolute skill names before writing", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const initial = yield* fixture.inventory();
      for (const nativeId of ["user:../escape", "user:/tmp/escape", "user:a/b", "project:.."]) {
        const error = yield* fixture.manager.pipe(
          Effect.flatMap((manager) =>
            manager.installSkill({
              instanceId,
              cwd: fixture.cwd,
              nativeId,
              sourceFolder: fixture.sourceFolder,
              expectedRevision: initial.revision,
            }),
          ),
          Effect.flip,
        );
        assert.strictEqual(error._tag, "SkillManagerError");
        assert.strictEqual(
          error._tag === "SkillManagerError" ? error.reason : undefined,
          "invalid-native-id",
        );
      }
      assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(fixture.configDir));
      assert.strictEqual(fixture.refreshes.length, 0);
    }),
  );

  it.effect("rejects a source symlink escaping the source directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      const outside = path.join(fixture.root, "outside.txt");
      yield* fs.writeFileString(outside, "outside");
      yield* fs.symlink(outside, path.join(fixture.sourceFolder, "escape.txt"));
      const initial = yield* fixture.inventory();

      const error = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:review",
            sourceFolder: fixture.sourceFolder,
            expectedRevision: initial.revision,
          }),
        ),
        Effect.flip,
      );

      assert.strictEqual(error._tag, "SkillManagerError");
      assert.strictEqual(
        error._tag === "SkillManagerError" ? error.reason : undefined,
        "symlink-not-allowed",
      );
      assert.isFalse(yield* fs.exists(path.join(fixture.configDir, "skills", "review")));
    }),
  );

  it.effect("rejects an existing destination without replacing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      const destination = path.join(fixture.configDir, "skills", "review");
      yield* writeSkill(destination, "# Existing\n");
      const initial = yield* fixture.inventory();

      const error = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:review",
            sourceFolder: fixture.sourceFolder,
            expectedRevision: initial.revision,
          }),
        ),
        Effect.flip,
      );

      assert.strictEqual(error._tag, "SkillManagerError");
      assert.strictEqual(
        error._tag === "SkillManagerError" ? error.reason : undefined,
        "destination-exists",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(destination, "SKILL.md")),
        "# Existing\n",
      );
    }),
  );

  it.effect.each(["install", "setEnabled", "uninstall"] as const)(
    "rejects a stale revision before %s writes",
    (operation) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeFixture();
        const destination = path.join(fixture.configDir, "skills", "review");
        if (operation !== "install") {
          yield* writeSkill(destination);
          yield* fs.writeFileString(
            path.join(destination, ".t3-skill-install.json"),
            JSON.stringify({
              version: 1,
              instanceId,
              nativeId: "review",
              installedBy: "r3-code",
            }),
          );
        }

        const error = yield* fixture.manager.pipe(
          Effect.flatMap((manager) => {
            const input = {
              instanceId,
              cwd: fixture.cwd,
              nativeId: "user:review",
              expectedRevision: "stale",
            } as const;
            if (operation === "install") {
              return manager.installSkill({ ...input, sourceFolder: fixture.sourceFolder });
            }
            if (operation === "setEnabled") {
              return manager.setSkillEnabled({ ...input, enabled: false });
            }
            return manager.uninstallSkill(input);
          }),
          Effect.flip,
        );

        assert.strictEqual(error._tag, "SkillInventoryConflictError");
        assert.strictEqual(yield* fs.exists(destination), operation !== "install");
        assert.strictEqual(fixture.refreshes.length, 0);
      }),
  );

  it.effect("cleans staging after a copy failure and leaves no destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      yield* fs.makeDirectory(path.join(fixture.sourceFolder, "nested"));
      yield* fs.symlink(
        path.join(fixture.root, "missing"),
        path.join(fixture.sourceFolder, "nested", "dangling"),
      );
      const initial = yield* fixture.inventory();

      const error = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "project:review",
            sourceFolder: fixture.sourceFolder,
            expectedRevision: initial.revision,
          }),
        ),
        Effect.flip,
      );

      assert.strictEqual(error._tag, "SkillManagerError");
      const root = path.join(fixture.cwd, ".claude", "skills");
      assert.isFalse(yield* fs.exists(path.join(root, "review")));
      const remaining = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
      assert.deepStrictEqual(remaining, []);
    }),
  );

  it.effect.each([
    { kind: "files", expected: "too-many-files" },
    { kind: "bytes", expected: "too-many-bytes" },
    { kind: "depth", expected: "too-deep" },
  ] as const)("enforces the $kind source limit", ({ kind, expected }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      if (kind === "files") {
        yield* Effect.forEach(
          Array.from({ length: 256 }, (_, index) => index),
          (index) => fs.writeFileString(path.join(fixture.sourceFolder, `file-${index}`), "x"),
          { concurrency: 8, discard: true },
        );
      } else if (kind === "bytes") {
        yield* fs.writeFileString(
          path.join(fixture.sourceFolder, "large"),
          "x".repeat(8 * 1024 * 1024),
        );
      } else {
        const deep = path.join(
          fixture.sourceFolder,
          ...Array.from({ length: 9 }, (_, i) => `d${i}`),
        );
        yield* fs.makeDirectory(deep, { recursive: true });
        yield* fs.writeFileString(path.join(deep, "file"), "x");
      }
      const initial = yield* fixture.inventory();

      const error = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:limited",
            sourceFolder: fixture.sourceFolder,
            expectedRevision: initial.revision,
          }),
        ),
        Effect.flip,
      );

      assert.strictEqual(error._tag, "SkillManagerError");
      assert.strictEqual(error._tag === "SkillManagerError" ? error.reason : undefined, expected);
    }),
  );

  it.effect("installs atomically with a pure-name ownership marker and refreshes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      const initial = yield* fixture.inventory();

      const result = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "project:review",
            sourceFolder: fixture.sourceFolder,
            expectedRevision: initial.revision,
          }),
        ),
      );

      assert.deepStrictEqual(result, { requiresSessionRestart: true });
      const destination = path.join(fixture.cwd, ".claude", "skills", "review");
      assert.strictEqual(yield* fs.readFileString(path.join(destination, "SKILL.md")), "# Skill\n");
      assert.deepStrictEqual(
        JSON.parse(yield* fs.readFileString(path.join(destination, ".t3-skill-install.json"))),
        {
          version: 1,
          instanceId,
          nativeId: "review",
          installedBy: "r3-code",
        },
      );
      assert.deepStrictEqual(fixture.refreshes, [{ instanceId, cwd: fixture.cwd }]);
      const next = yield* fixture.inventory();
      assert.isTrue(next.entries.some((entry) => entry.nativeId === "project:review"));
    }),
  );

  it.effect("writes only the targeted JSONC override and preserves comments and keys", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      yield* writeSkill(path.join(fixture.configDir, "skills", "review"));
      yield* fs.makeDirectory(fixture.configDir, { recursive: true });
      const settingsPath = path.join(fixture.configDir, "settings.json");
      yield* fs.writeFileString(
        settingsPath,
        '{\n  // keep this comment\n  "otherKey": { "kept": true },\n  "skillOverrides": { "other": "on" },\n}\n',
      );
      yield* fs.chmod(settingsPath, 0o600);
      const initial = yield* fixture.inventory();

      const result = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.setSkillEnabled({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:review",
            enabled: false,
            expectedRevision: initial.revision,
          }),
        ),
      );

      assert.deepStrictEqual(result, { requiresSessionRestart: true });
      const settings = yield* fs.readFileString(path.join(fixture.configDir, "settings.json"));
      assert.include(settings, "// keep this comment");
      assert.include(settings, '"otherKey": { "kept": true }');
      assert.include(settings, '"other": "on"');
      assert.include(settings, '"review": "off"');
      assert.strictEqual((yield* fs.stat(settingsPath)).mode & 0o777, 0o600);
      assert.isFalse(yield* fs.exists(path.join(fixture.configDir, ".claude.json")));
      const next = yield* fixture.inventory();
      assert.strictEqual(
        next.entries.find((entry) => entry.nativeId === "user:review")?.state,
        "disabled",
      );
    }),
  );

  it.effect("uses project local settings for project native ids", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      yield* writeSkill(path.join(fixture.cwd, ".claude", "skills", "deploy"));
      const initial = yield* fixture.inventory();

      yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.setSkillEnabled({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "project:deploy",
            enabled: false,
            expectedRevision: initial.revision,
          }),
        ),
      );

      const localPath = path.join(fixture.cwd, ".claude", "settings.local.json");
      const local = yield* fs.readFileString(localPath);
      assert.include(local, '"deploy": "off"');
      assert.strictEqual((yield* fs.stat(localPath)).mode & 0o777, 0o600);
      assert.isFalse(yield* fs.exists(path.join(fixture.configDir, "settings.json")));
    }),
  );

  it.effect("refuses to toggle a shadowed file entry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      yield* writeSkill(path.join(fixture.configDir, "skills", "review"));
      yield* writeSkill(path.join(fixture.cwd, ".claude", "skills", "review"));
      const initial = yield* fixture.inventory();
      assert.strictEqual(
        initial.entries.find((entry) => entry.nativeId === "project:review")?.state,
        "shadowed",
      );

      const error = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.setSkillEnabled({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "project:review",
            enabled: false,
            expectedRevision: initial.revision,
          }),
        ),
        Effect.flip,
      );

      assert.strictEqual(error._tag, "SkillManagerError");
      assert.strictEqual(
        error._tag === "SkillManagerError" ? error.reason : undefined,
        "entry-not-mutable",
      );
      assert.isFalse(yield* fs.exists(path.join(fixture.cwd, ".claude", "settings.local.json")));
    }),
  );

  it.effect("refuses to uninstall without a valid ownership marker", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      const destination = path.join(fixture.configDir, "skills", "review");
      yield* writeSkill(destination);
      const initial = yield* fixture.inventory();

      const error = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.uninstallSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:review",
            expectedRevision: initial.revision,
          }),
        ),
        Effect.flip,
      );

      assert.strictEqual(error._tag, "SkillManagerError");
      assert.strictEqual(
        error._tag === "SkillManagerError" ? error.reason : undefined,
        "invalid-install-marker",
      );
      assert.isTrue(yield* fs.exists(destination));
    }),
  );

  it.effect.each([
    { field: "version", override: { version: 2 } },
    { field: "installedBy", override: { installedBy: "other" } },
    { field: "instanceId", override: { instanceId: "other" } },
    { field: "nativeId", override: { nativeId: "other" } },
  ] as const)("refuses a marker with the wrong $field", ({ override }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      const destination = path.join(fixture.configDir, "skills", "review");
      yield* writeSkill(destination);
      yield* fs.writeFileString(
        path.join(destination, ".t3-skill-install.json"),
        JSON.stringify({
          version: 1,
          instanceId,
          nativeId: "review",
          installedBy: "r3-code",
          ...override,
        }),
      );
      const initial = yield* fixture.inventory();

      const error = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.uninstallSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:review",
            expectedRevision: initial.revision,
          }),
        ),
        Effect.flip,
      );

      assert.strictEqual(error._tag, "SkillManagerError");
      assert.strictEqual(
        error._tag === "SkillManagerError" ? error.reason : undefined,
        "invalid-install-marker",
      );
      assert.isTrue(yield* fs.exists(destination));
    }),
  );

  it.effect("reserves a unique quarantine container and retains it without removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* makeFixture();
      let current = yield* base.inventory();
      yield* base.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: base.cwd,
            nativeId: "user:review",
            sourceFolder: base.sourceFolder,
            expectedRevision: current.revision,
          }),
        ),
      );
      let recursiveRemoves = 0;
      const reservations: string[] = [];
      const fileSystem: FileSystem.FileSystem = {
        ...fs,
        makeDirectory: (target, options) => {
          if (!target.includes(".t3-quarantine")) return fs.makeDirectory(target, options);
          reservations.push(target);
          if (reservations.length > 1) return fs.makeDirectory(target, options);
          return Effect.gen(function* () {
            yield* fs.makeDirectory(target, options);
            yield* fs.writeFileString(path.join(target, "sentinel"), "keep");
            return yield* fs.makeDirectory(target, options);
          });
        },
        remove: (target, options) => {
          if (options?.recursive === true) recursiveRemoves++;
          return fs.remove(target, options);
        },
      };
      const fixture = {
        ...base,
        ...(yield* makeHarness(base.configDir, base.cwd, { fileSystem })),
      };
      current = yield* fixture.inventory();

      const result = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.uninstallSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:review",
            expectedRevision: current.revision,
          }),
        ),
      );

      assert.deepStrictEqual(result, { requiresSessionRestart: true });
      assert.strictEqual(recursiveRemoves, 0);
      assert.strictEqual(reservations.length, 2);
      assert.notStrictEqual(reservations[0], reservations[1]);
      assert.strictEqual(yield* fs.readFileString(path.join(reservations[0]!, "sentinel")), "keep");
      assert.isFalse(yield* fs.exists(path.join(fixture.configDir, "skills", "review")));
      const quarantine = path.join(reservations[1]!, "skill");
      assert.strictEqual(yield* fs.readFileString(path.join(quarantine, "SKILL.md")), "# Skill\n");
      assert.strictEqual(
        JSON.parse(yield* fs.readFileString(path.join(quarantine, ".t3-skill-install.json")))
          .instanceId,
        instanceId,
      );
      assert.isFalse((yield* fixture.inventory()).entries.some((entry) => entry.name === "review"));
      assert.isTrue(yield* fs.exists(fixture.sourceFolder));
      assert.strictEqual(base.refreshes.length, 1);
      assert.strictEqual(fixture.refreshes.length, 1);
    }),
  );

  it.effect("checks actual bytes read when a source file grows after lstat", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* makeFixture();
      const growing = path.join(base.sourceFolder, "growing.txt");
      yield* fs.writeFileString(growing, "x");
      const growingRealPath = path.join(yield* fs.realPath(base.sourceFolder), "growing.txt");
      const fileSystem: FileSystem.FileSystem = {
        ...fs,
        readFile: (target) =>
          target === growingRealPath
            ? Effect.succeed(new Uint8Array(8 * 1024 * 1024))
            : fs.readFile(target),
      };
      const fixture = {
        ...base,
        ...(yield* makeHarness(base.configDir, base.cwd, { fileSystem })),
      };
      const initial = yield* fixture.inventory();

      const error = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:growing",
            sourceFolder: fixture.sourceFolder,
            expectedRevision: initial.revision,
          }),
        ),
        Effect.flip,
      );

      assert.strictEqual(error._tag, "SkillManagerError");
      assert.strictEqual(
        error._tag === "SkillManagerError" ? error.reason : undefined,
        "too-many-bytes",
      );
      assert.isFalse(yield* fs.exists(path.join(fixture.configDir, "skills", "growing")));
    }),
  );

  it.effect("preserves executable and ordinary file modes during install", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      yield* fs.writeFileString(path.join(fixture.sourceFolder, "run.sh"), "#!/bin/sh\n", {
        mode: 0o755,
      });
      const initial = yield* fixture.inventory();

      yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:executable",
            sourceFolder: fixture.sourceFolder,
            expectedRevision: initial.revision,
          }),
        ),
      );

      const installed = path.join(fixture.configDir, "skills", "executable", "run.sh");
      assert.strictEqual((yield* fs.stat(installed)).mode & 0o777, 0o755);
    }),
  );

  it.effect("returns mutation success when the provider refresh defects", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture({ refreshDies: true });
      const initial = yield* fixture.inventory();

      const exit = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:review",
            sourceFolder: fixture.sourceFolder,
            expectedRevision: initial.revision,
          }),
        ),
        Effect.exit,
      );

      assert.isTrue(Exit.isSuccess(exit));
      if (Exit.isSuccess(exit)) {
        assert.deepStrictEqual(exit.value, { requiresSessionRestart: true });
      }
      assert.isTrue(yield* fs.exists(path.join(fixture.configDir, "skills", "review")));
      assert.strictEqual(fixture.refreshes.length, 1);
    }),
  );

  it.effect("preserves interrupt and defect causes from provider refresh", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const refreshCause = Cause.fromReasons([
        ...Cause.interrupt().reasons,
        ...Cause.die("injected refresh defect").reasons,
      ]);
      const fixture = yield* makeFixture({ refreshCause });
      const initial = yield* fixture.inventory();

      const exit = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:review",
            sourceFolder: fixture.sourceFolder,
            expectedRevision: initial.revision,
          }),
        ),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.isTrue(Cause.hasInterrupts(exit.cause));
        assert.isTrue(Cause.hasDies(exit.cause));
      }
      assert.isTrue(yield* fs.exists(path.join(fixture.configDir, "skills", "review")));
      assert.strictEqual(fixture.refreshes.length, 1);
    }),
  );

  it.effect("rejects quarantine overlapping an add-dir discovery root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* makeFixture();
      const quarantineRoot = path.join(base.configDir, ".t3-code", "uninstalled-skills");
      yield* fs.makeDirectory(path.join(quarantineRoot, ".claude", "skills"), {
        recursive: true,
      });
      const fixture = {
        ...base,
        ...(yield* makeHarness(base.configDir, base.cwd, {
          launchArgs: `--add-dir "${quarantineRoot}"`,
        })),
      };
      let current = yield* fixture.inventory();
      yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:review",
            sourceFolder: fixture.sourceFolder,
            expectedRevision: current.revision,
          }),
        ),
      );
      current = yield* fixture.inventory();

      const error = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.uninstallSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:review",
            expectedRevision: current.revision,
          }),
        ),
        Effect.flip,
      );

      assert.strictEqual(error._tag, "SkillManagerError");
      assert.strictEqual(
        error._tag === "SkillManagerError" ? error.reason : undefined,
        "invalid-quarantine-root",
      );
      assert.isTrue(yield* fs.exists(path.join(fixture.configDir, "skills", "review")));
      const quarantineEntries = yield* fs.readDirectory(quarantineRoot);
      assert.isFalse(quarantineEntries.some((entry) => entry.includes(".t3-quarantine")));
    }),
  );

  it.effect("retains an unmarked replacement in quarantine without restore or removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* makeFixture();
      const destination = path.join(base.configDir, "skills", "review");
      let current = yield* base.inventory();
      yield* base.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: base.cwd,
            nativeId: "user:review",
            sourceFolder: base.sourceFolder,
            expectedRevision: current.revision,
          }),
        ),
      );
      const destinationRealPath = yield* fs.realPath(destination);
      const externalOriginal = path.join(base.root, "external-original");
      let replacements = 0;
      let recursiveRemoves = 0;
      const fileSystem: FileSystem.FileSystem = {
        ...fs,
        rename: (source, target) =>
          Effect.gen(function* () {
            if (source === destinationRealPath && target.includes(".t3-quarantine")) {
              replacements++;
              yield* fs.rename(destination, externalOriginal);
              yield* writeSkill(destination, "# Replacement\n").pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              );
            }
            return yield* fs.rename(source, target);
          }),
        remove: (target, options) => {
          if (options?.recursive === true) recursiveRemoves++;
          return fs.remove(target, options);
        },
      };
      const fixture = {
        ...base,
        ...(yield* makeHarness(base.configDir, base.cwd, { fileSystem })),
      };
      current = yield* fixture.inventory();

      const outcome = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.uninstallSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:review",
            expectedRevision: current.revision,
          }),
        ),
        Effect.result,
      );

      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.failure._tag, "SkillManagerError");
        if (outcome.failure._tag === "SkillManagerError") {
          assert.strictEqual(outcome.failure.reason, "invalid-install-marker");
        }
      }
      assert.deepStrictEqual(fixture.refreshes, [{ instanceId, cwd: fixture.cwd }]);
      assert.strictEqual(replacements, 1);
      assert.strictEqual(recursiveRemoves, 0);
      assert.isFalse(yield* fs.exists(destination));
      const quarantineRoot = path.join(fixture.configDir, ".t3-code", "uninstalled-skills");
      const quarantines = yield* fs.readDirectory(quarantineRoot);
      assert.strictEqual(quarantines.length, 1);
      assert.strictEqual(
        yield* fs.readFileString(path.join(quarantineRoot, quarantines[0]!, "skill", "SKILL.md")),
        "# Replacement\n",
      );
      assert.strictEqual(
        JSON.parse(yield* fs.readFileString(path.join(externalOriginal, ".t3-skill-install.json")))
          .nativeId,
        "review",
      );
    }),
  );
});

const sourceInstanceId = ProviderInstanceId.make("claude_source");
const targetInstanceId = ProviderInstanceId.make("claude_target");

interface SyncHarnessOptions extends HarnessOptions {
  readonly sourceEnabled?: boolean;
  readonly targetEnabled?: boolean;
  readonly targetDriverKind?: string;
}

const makeSyncHarness = Effect.fn(function* (
  sourceConfigDir: string,
  targetConfigDir: string,
  cwd: string,
  options: SyncHarnessOptions = {},
) {
  const hostFileSystem = yield* FileSystem.FileSystem;
  const fs = options.fileSystem ?? hostFileSystem;
  const path = yield* Path.Path;
  const makeInstance = (
    id: ProviderInstanceId,
    configDir: string,
    enabled: boolean,
    driver = "claudeAgent",
  ): Effect.Effect<ProviderInstance, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const driverKind = ProviderDriverKind.make(driver);
      const config = {
        homePath: configDir,
        ...(options.launchArgs === undefined ? {} : { launchArgs: options.launchArgs }),
      };
      const management = yield* makeClaudeSkillManagement({
        instanceId: id,
        config,
        environment: {},
      });
      return {
        instanceId: id,
        driverKind,
        continuationIdentity: { driverKind, continuationKey: id },
        displayName: undefined,
        enabled,
        snapshot: {} as ProviderInstance["snapshot"],
        orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
        textGeneration: {} as ProviderInstance["textGeneration"],
        skillInventory: {
          list: (scanCwd) =>
            discoverClaudeSkillInventory(config, scanCwd, {}, id).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(HostProcess.Platform, "win32"),
            ),
        },
        skillManagement: management,
      };
    });
  const source = yield* makeInstance(
    sourceInstanceId,
    sourceConfigDir,
    options.sourceEnabled ?? true,
  );
  const target = yield* makeInstance(
    targetInstanceId,
    targetConfigDir,
    options.targetEnabled ?? true,
    options.targetDriverKind,
  );
  const instances = [source, target, ...(options.additionalInstances ?? [])];
  const instanceRegistry = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (id) => Effect.succeed(instances.find((instance) => instance.instanceId === id)),
    listInstances: Effect.succeed(instances),
  });
  const refreshes: Array<{ instanceId: string; cwd: string }> = [];
  const refresh = (input: { instanceId: ProviderInstanceId; cwd: string }) =>
    Effect.sync(() => {
      refreshes.push(input);
    }).pipe(
      Effect.andThen(options.refreshDies ? Effect.die("injected refresh failure") : Effect.void),
      Effect.as([]),
    );
  const providerRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
    refreshWorkspaceSnapshot: refresh,
    refreshWorkspaceSnapshotStrict: refresh,
  });
  const layer = SkillManager.layer.pipe(
    Layer.provideMerge(SkillInventoryService.layer),
    Layer.provide(
      Layer.mergeAll(
        instanceRegistry,
        providerRegistry,
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({
          assertContains: options.assertContains ?? (() => Effect.void),
        }),
        NodeCrypto.layer,
        Layer.succeed(FileSystem.FileSystem, fs),
      ),
    ),
  );
  const manager = SkillManager.SkillManager.pipe(Effect.provide(layer));
  const inventory = (expectedRevision?: string) =>
    SkillInventoryService.SkillInventoryService.pipe(
      Effect.flatMap((service) =>
        service.list({
          cwd,
          ...(expectedRevision ? { expectedRevision } : {}),
        }),
      ),
      Effect.provide(layer),
    );
  return { manager, inventory, refreshes };
});

const makeSyncFixture = Effect.fn(function* (options?: SyncHarnessOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-sync-" });
  const sourceConfigDir = path.join(root, "source-config");
  const targetConfigDir = path.join(root, "target-config");
  const cwd = path.join(root, "workspace");
  yield* fs.makeDirectory(cwd, { recursive: true });
  const harness = yield* makeSyncHarness(sourceConfigDir, targetConfigDir, cwd, options);
  return { root, sourceConfigDir, targetConfigDir, cwd, ...harness };
});

it.layer(NodeServices.layer)("SkillManager Claude sync", (it) => {
  it.effect("accepts an aggregate inventory revision across provider instances", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeSyncFixture({
        additionalInstances: [makeAdditionalInventoryInstance("/other")],
      });
      const source = path.join(fixture.sourceConfigDir, "skills", "review");
      yield* writeSkill(source, "# Source\n");
      yield* writeSkill(path.join(fixture.targetConfigDir, "skills", "existing"));
      const initial = yield* fixture.inventory();
      assert.deepStrictEqual(
        [...new Set(initial.entries.map((entry) => entry.instanceId))].sort(),
        [sourceInstanceId, targetInstanceId, "claude_other"].sort(),
      );

      const result = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.syncClaudeSkills({
            sourceInstanceId,
            targetInstanceId,
            cwd: fixture.cwd,
            mode: "copy",
            nativeIds: ["review"],
            expectedRevision: initial.revision,
          }),
        ),
      );

      assert.deepStrictEqual(result, { requiresSessionRestart: true, backups: [] });
      assert.isTrue(
        yield* fs.exists(path.join(fixture.targetConfigDir, "skills", "review", "SKILL.md")),
      );
    }),
  );

  it.effect("copies only user skill directories and writes target ownership markers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeSyncFixture();
      const source = path.join(fixture.sourceConfigDir, "skills", "review");
      yield* writeSkill(source, "# Source\n");
      yield* fs.writeFileString(path.join(fixture.sourceConfigDir, "settings.json"), "secret");
      yield* fs.writeFileString(path.join(fixture.sourceConfigDir, "credentials.json"), "secret");
      yield* fs.writeFileString(path.join(fixture.sourceConfigDir, ".claude.json"), "secret");
      yield* writeSkill(path.join(fixture.sourceConfigDir, "plugins", "transcript"), "secret");
      const initial = yield* fixture.inventory();

      const result = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.syncClaudeSkills({
            sourceInstanceId,
            targetInstanceId,
            cwd: fixture.cwd,
            mode: "copy",
            nativeIds: ["review"],
            expectedRevision: initial.revision,
          }),
        ),
      );

      assert.deepStrictEqual(result, { requiresSessionRestart: true, backups: [] });
      const destination = path.join(fixture.targetConfigDir, "skills", "review");
      assert.strictEqual(
        yield* fs.readFileString(path.join(destination, "SKILL.md")),
        "# Source\n",
      );
      assert.deepStrictEqual(
        JSON.parse(yield* fs.readFileString(path.join(destination, ".t3-skill-install.json"))),
        {
          version: 1,
          instanceId: targetInstanceId,
          nativeId: "review",
          installedBy: "r3-code",
        },
      );
      for (const name of ["settings.json", "credentials.json", ".claude.json", "plugins"]) {
        assert.isFalse(yield* fs.exists(path.join(fixture.targetConfigDir, name)));
      }
      assert.isFalse(yield* fs.exists(path.join(source, ".t3-skill-install.json")));
      assert.deepStrictEqual(fixture.refreshes, [
        { instanceId: targetInstanceId, cwd: fixture.cwd },
      ]);
    }),
  );

  it.effect("links directories without modifying the source or enabling R3 uninstall", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeSyncFixture();
      const source = path.join(fixture.sourceConfigDir, "skills", "review");
      yield* writeSkill(source);
      const sourceMarker = JSON.stringify({
        version: 1,
        instanceId: targetInstanceId,
        nativeId: "review",
        installedBy: "r3-code",
      });
      yield* fs.writeFileString(path.join(source, ".t3-skill-install.json"), sourceMarker);
      const sourceRealPath = yield* fs.realPath(source);
      const initial = yield* fixture.inventory();

      const result = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.syncClaudeSkills({
            sourceInstanceId,
            targetInstanceId,
            cwd: fixture.cwd,
            mode: "link",
            nativeIds: ["review"],
            expectedRevision: initial.revision,
            onConflict: "cancel",
          }),
        ),
      );

      assert.deepStrictEqual(result, { requiresSessionRestart: true, backups: [] });
      const destination = path.join(fixture.targetConfigDir, "skills", "review");
      assert.strictEqual((yield* fs.lstat(destination)).type, "SymbolicLink");
      assert.strictEqual(yield* fs.readLink(destination), sourceRealPath);
      assert.strictEqual(
        yield* fs.readFileString(path.join(source, ".t3-skill-install.json")),
        sourceMarker,
      );
      const next = yield* fixture.inventory();
      const linked = next.entries.find(
        (entry) => entry.instanceId === targetInstanceId && entry.nativeId === "user:review",
      );
      assert.strictEqual(linked?.actions.canUninstall, false);
      assert.strictEqual(linked?.actions.canSetEnabled, false);
      assert.strictEqual(
        linked?.actions.reason,
        "Linked skills are read-only in the first version.",
      );
      assert.isFalse(yield* fs.exists(path.join(fixture.targetConfigDir, ".t3-code")));
    }),
  );

  it.effect.each([undefined, "cancel"] as const)(
    "cancels an existing destination with onConflict=%s without changes",
    (onConflict) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeSyncFixture();
        yield* writeSkill(path.join(fixture.sourceConfigDir, "skills", "review"), "# Source\n");
        const destination = path.join(fixture.targetConfigDir, "skills", "review");
        yield* writeSkill(destination, "# Existing\n");
        const initial = yield* fixture.inventory();

        const error = yield* fixture.manager.pipe(
          Effect.flatMap((manager) =>
            manager.syncClaudeSkills({
              sourceInstanceId,
              targetInstanceId,
              cwd: fixture.cwd,
              mode: "copy",
              nativeIds: ["review"],
              expectedRevision: initial.revision,
              ...(onConflict === undefined ? {} : { onConflict }),
            }),
          ),
          Effect.flip,
        );

        assert.strictEqual(error._tag, "SkillManagerError");
        assert.strictEqual(
          error._tag === "SkillManagerError" ? error.reason : undefined,
          "destination-exists",
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(destination, "SKILL.md")),
          "# Existing\n",
        );
        assert.isFalse(yield* fs.exists(path.join(fixture.targetConfigDir, ".t3-code")));
        assert.strictEqual(fixture.refreshes.length, 0);
      }),
  );

  it.effect("backs up an existing target outside discovery roots before copying", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeSyncFixture();
      yield* writeSkill(path.join(fixture.sourceConfigDir, "skills", "review"), "# Source\n");
      const destination = path.join(fixture.targetConfigDir, "skills", "review");
      yield* writeSkill(destination, "# Existing\n");
      const initial = yield* fixture.inventory();

      const result = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.syncClaudeSkills({
            sourceInstanceId,
            targetInstanceId,
            cwd: fixture.cwd,
            mode: "copy",
            nativeIds: ["review"],
            expectedRevision: initial.revision,
            onConflict: "backup",
          }),
        ),
      );

      assert.strictEqual(result.requiresSessionRestart, true);
      assert.strictEqual(result.backups.length, 1);
      const backup = result.backups[0]!;
      assert.strictEqual(backup.nativeId, "review");
      assert.strictEqual(
        yield* fs.readFileString(path.join(backup.path, "SKILL.md")),
        "# Existing\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(destination, "SKILL.md")),
        "# Source\n",
      );
      assert.isTrue(
        backup.path.includes(`${path.sep}.t3-code${path.sep}skill-sync-backups${path.sep}`),
      );
      assert.isFalse(
        backup.path.startsWith(path.join(fixture.targetConfigDir, "skills") + path.sep),
      );
    }),
  );

  it.effect("validates target revision and pure unique user-level native ids before writes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeSyncFixture();
      yield* writeSkill(path.join(fixture.sourceConfigDir, "skills", "review"));
      const initial = yield* fixture.inventory();

      const stale = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.syncClaudeSkills({
            sourceInstanceId,
            targetInstanceId,
            cwd: fixture.cwd,
            mode: "copy",
            nativeIds: ["review"],
            expectedRevision: "stale",
          }),
        ),
        Effect.flip,
      );
      assert.strictEqual(stale._tag, "SkillInventoryConflictError");

      for (const nativeIds of [
        ["user:review"],
        ["project:review"],
        ["../review"],
        ["/tmp/review"],
        ["a/b"],
        [],
        ["review", "review"],
      ]) {
        const error = yield* fixture.manager.pipe(
          Effect.flatMap((manager) =>
            manager.syncClaudeSkills({
              sourceInstanceId,
              targetInstanceId,
              cwd: fixture.cwd,
              mode: "copy",
              nativeIds,
              expectedRevision: initial.revision,
            }),
          ),
          Effect.flip,
        );
        assert.strictEqual(error._tag, "SkillManagerError");
        assert.strictEqual(
          error._tag === "SkillManagerError" ? error.reason : undefined,
          "invalid-native-id",
        );
      }
      assert.isFalse(yield* fs.exists(path.join(fixture.targetConfigDir, "skills")));
      assert.strictEqual(fixture.refreshes.length, 0);
    }),
  );

  it.effect("rejects identical, disabled, and non-Claude instances", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = yield* makeSyncFixture({ targetEnabled: false });
      yield* writeSkill(path.join(fixture.sourceConfigDir, "skills", "review"));
      const initial = yield* fixture.inventory();
      for (const [sourceId, targetId] of [
        [sourceInstanceId, sourceInstanceId],
        [sourceInstanceId, targetInstanceId],
      ] as const) {
        const error = yield* fixture.manager.pipe(
          Effect.flatMap((manager) =>
            manager.syncClaudeSkills({
              sourceInstanceId: sourceId,
              targetInstanceId: targetId,
              cwd: fixture.cwd,
              mode: "link",
              nativeIds: ["review"],
              expectedRevision: initial.revision,
            }),
          ),
          Effect.flip,
        );
        assert.strictEqual(error._tag, "SkillManagerError");
      }
      const nonClaude = yield* makeSyncHarness(
        fixture.sourceConfigDir,
        fixture.targetConfigDir,
        fixture.cwd,
        { targetDriverKind: "codex" },
      );
      const error = yield* nonClaude.manager.pipe(
        Effect.flatMap((manager) =>
          manager.syncClaudeSkills({
            sourceInstanceId,
            targetInstanceId,
            cwd: fixture.cwd,
            mode: "link",
            nativeIds: ["review"],
            expectedRevision: initial.revision,
          }),
        ),
        Effect.flip,
      );
      assert.strictEqual(error._tag, "SkillManagerError");
      assert.strictEqual(
        error._tag === "SkillManagerError" ? error.reason : undefined,
        "management-unavailable",
      );
    }),
  );

  it.effect.each(["copy", "link"] as const)(
    "rolls back committed targets and restores backups after a %s batch failure",
    (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* makeSyncFixture();
        for (const name of ["one", "two"]) {
          yield* writeSkill(path.join(base.sourceConfigDir, "skills", name), `# ${name} source\n`);
          yield* writeSkill(
            path.join(base.targetConfigDir, "skills", name),
            `# ${name} existing\n`,
          );
        }
        const targetRoot = yield* fs.realPath(path.join(base.targetConfigDir, "skills"));
        const secondTarget = path.join(targetRoot, "two");
        const recursiveRemoves: string[] = [];
        const fileSystem: FileSystem.FileSystem = {
          ...fs,
          rename: (source, target) => {
            if (source.includes(".t3-staging") && target === secondTarget) {
              return fs.rename(path.join(base.root, "missing-staging"), target);
            }
            return fs.rename(source, target);
          },
          symlink: (source, target) => {
            if (target === secondTarget) {
              return fs.readFile(path.join(base.root, "missing-source")).pipe(Effect.asVoid);
            }
            return fs.symlink(source, target);
          },
          remove: (target, options) => {
            if (options?.recursive === true) recursiveRemoves.push(target);
            return fs.remove(target, options);
          },
        };
        const fixture = {
          ...base,
          ...(yield* makeSyncHarness(base.sourceConfigDir, base.targetConfigDir, base.cwd, {
            fileSystem,
          })),
        };
        const initial = yield* fixture.inventory();

        const error = yield* fixture.manager.pipe(
          Effect.flatMap((manager) =>
            manager.syncClaudeSkills({
              sourceInstanceId,
              targetInstanceId,
              cwd: fixture.cwd,
              mode,
              nativeIds: ["one", "two"],
              expectedRevision: initial.revision,
              onConflict: "backup",
            }),
          ),
          Effect.flip,
        );

        assert.strictEqual(error._tag, "SkillManagerError");
        for (const name of ["one", "two"]) {
          assert.strictEqual(
            yield* fs.readFileString(path.join(base.targetConfigDir, "skills", name, "SKILL.md")),
            `# ${name} existing\n`,
          );
        }
        assert.isTrue(recursiveRemoves.every((target) => target.includes(".t3-staging")));
        const rollbackRoot = path.join(base.targetConfigDir, ".t3-code", "skill-sync-rollbacks");
        const rollbacks = yield* fs.readDirectory(rollbackRoot);
        assert.strictEqual(rollbacks.length, 1);
        assert.isTrue(yield* fs.exists(path.join(rollbackRoot, rollbacks[0]!, "skill")));
      }),
  );

  it.effect("reports incomplete rollback and preserves an external target replacement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* makeSyncFixture();
      for (const name of ["one", "two"]) {
        yield* writeSkill(path.join(base.sourceConfigDir, "skills", name), `# ${name} source\n`);
        yield* writeSkill(path.join(base.targetConfigDir, "skills", name), `# ${name} existing\n`);
      }
      const targetRoot = yield* fs.realPath(path.join(base.targetConfigDir, "skills"));
      const firstTarget = path.join(targetRoot, "one");
      const secondTarget = path.join(targetRoot, "two");
      const externalOriginal = path.join(base.root, "external-original");
      const fileSystem: FileSystem.FileSystem = {
        ...fs,
        rename: (source, target) =>
          source.includes(".t3-staging") && target === secondTarget
            ? Effect.gen(function* () {
                yield* fs.rename(firstTarget, externalOriginal);
                yield* writeSkill(firstTarget, "# External replacement\n").pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                );
                return yield* fs.rename(path.join(base.root, "missing-staging"), target);
              })
            : fs.rename(source, target),
      };
      const fixture = {
        ...base,
        ...(yield* makeSyncHarness(base.sourceConfigDir, base.targetConfigDir, base.cwd, {
          fileSystem,
        })),
      };
      const initial = yield* fixture.inventory();

      const error = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.syncClaudeSkills({
            sourceInstanceId,
            targetInstanceId,
            cwd: fixture.cwd,
            mode: "copy",
            nativeIds: ["one", "two"],
            expectedRevision: initial.revision,
            onConflict: "backup",
          }),
        ),
        Effect.flip,
      );

      assert.strictEqual(error._tag, "SkillManagerError");
      assert.strictEqual(
        error._tag === "SkillManagerError" ? error.reason : undefined,
        "rollback-incomplete",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(firstTarget, "SKILL.md")),
        "# External replacement\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(externalOriginal, "SKILL.md")),
        "# one source\n",
      );
      const backupRoot = path.join(base.targetConfigDir, ".t3-code", "skill-sync-backups");
      const backups = yield* fs.readDirectory(backupRoot);
      assert.isTrue(backups.length >= 1);
    }),
  );

  it.effect("returns sync success when the post-commit provider refresh defects", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeSyncFixture({ refreshDies: true });
      yield* writeSkill(path.join(fixture.sourceConfigDir, "skills", "review"));
      const initial = yield* fixture.inventory();

      const result = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.syncClaudeSkills({
            sourceInstanceId,
            targetInstanceId,
            cwd: fixture.cwd,
            mode: "copy",
            nativeIds: ["review"],
            expectedRevision: initial.revision,
          }),
        ),
      );

      assert.deepStrictEqual(result, { requiresSessionRestart: true, backups: [] });
      assert.isTrue(yield* fs.exists(path.join(fixture.targetConfigDir, "skills", "review")));
      assert.strictEqual(fixture.refreshes.length, 1);
    }),
  );
});

it.layer(NodeServices.layer)("SkillManager Claude sync review hardening", (it) => {
  it.effect.each(["copy", "link"] as const)(
    "rejects %s when the target config is nested inside the source skill",
    (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-sync-nested-" });
        const sourceConfigDir = path.join(root, "source-config");
        const source = path.join(sourceConfigDir, "skills", "review");
        yield* writeSkill(source, "# Source\n");
        const targetConfigDir = path.join(source, "nested-target-config");
        const cwd = path.join(root, "workspace");
        yield* fs.makeDirectory(cwd, { recursive: true });
        const fixture = yield* makeSyncHarness(sourceConfigDir, targetConfigDir, cwd);
        const initial = yield* fixture.inventory();

        const error = yield* fixture.manager.pipe(
          Effect.flatMap((manager) =>
            manager.syncClaudeSkills({
              sourceInstanceId,
              targetInstanceId,
              cwd,
              mode,
              nativeIds: ["review"],
              expectedRevision: initial.revision,
              onConflict: "backup",
            }),
          ),
          Effect.flip,
        );

        assert.strictEqual(error._tag, "SkillManagerError");
        assert.strictEqual(
          error._tag === "SkillManagerError" ? error.reason : undefined,
          "source-overlaps-target",
        );
        assert.strictEqual(yield* fs.readFileString(path.join(source, "SKILL.md")), "# Source\n");
        assert.isFalse(
          yield* fs.exists(path.join(targetConfigDir, "skills", "review", "SKILL.md")),
        );
      }),
  );

  it.effect.each(["copy", "link"] as const)(
    "rejects %s backup when the target directory contains the source config",
    (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-sync-nested-" });
        const targetConfigDir = path.join(root, "target-config");
        const destination = path.join(targetConfigDir, "skills", "review");
        yield* writeSkill(destination, "# Existing\n");
        const sourceConfigDir = path.join(destination, "nested-source-config");
        const source = path.join(sourceConfigDir, "skills", "review");
        yield* writeSkill(source, "# Source\n");
        const cwd = path.join(root, "workspace");
        yield* fs.makeDirectory(cwd, { recursive: true });
        const fixture = yield* makeSyncHarness(sourceConfigDir, targetConfigDir, cwd);
        const initial = yield* fixture.inventory();

        const error = yield* fixture.manager.pipe(
          Effect.flatMap((manager) =>
            manager.syncClaudeSkills({
              sourceInstanceId,
              targetInstanceId,
              cwd,
              mode,
              nativeIds: ["review"],
              expectedRevision: initial.revision,
              onConflict: "backup",
            }),
          ),
          Effect.flip,
        );

        assert.strictEqual(error._tag, "SkillManagerError");
        assert.strictEqual(
          error._tag === "SkillManagerError" ? error.reason : undefined,
          "source-overlaps-target",
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(destination, "SKILL.md")),
          "# Existing\n",
        );
        assert.strictEqual(yield* fs.readFileString(path.join(source, "SKILL.md")), "# Source\n");
      }),
  );

  it.effect.each(["skill-sync-staging", "skill-sync-backups", "skill-sync-rollbacks"] as const)(
    "rejects copy when the source config is nested in %s",
    (safetyRoot) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-sync-nested-" });
        const targetConfigDir = path.join(root, "target-config");
        const sourceConfigDir = path.join(
          targetConfigDir,
          ".t3-code",
          safetyRoot,
          "nested-source-config",
        );
        yield* writeSkill(path.join(sourceConfigDir, "skills", "review"), "# Source\n");
        const destination = path.join(targetConfigDir, "skills", "review");
        yield* writeSkill(destination, "# Existing\n");
        const cwd = path.join(root, "workspace");
        yield* fs.makeDirectory(cwd, { recursive: true });
        const fixture = yield* makeSyncHarness(sourceConfigDir, targetConfigDir, cwd);
        const initial = yield* fixture.inventory();

        const error = yield* fixture.manager.pipe(
          Effect.flatMap((manager) =>
            manager.syncClaudeSkills({
              sourceInstanceId,
              targetInstanceId,
              cwd,
              mode: "copy",
              nativeIds: ["review"],
              expectedRevision: initial.revision,
              onConflict: "backup",
            }),
          ),
          Effect.flip,
        );

        assert.strictEqual(error._tag, "SkillManagerError");
        assert.strictEqual(
          error._tag === "SkillManagerError" ? error.reason : undefined,
          "source-overlaps-target",
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(destination, "SKILL.md")),
          "# Existing\n",
        );
      }),
  );

  it.effect.each([
    { root: "skill-sync-staging", parent: false, destination: "discovery" },
    { root: "skill-sync-backups", parent: false, destination: "discovery" },
    { root: "skill-sync-rollbacks", parent: false, destination: "discovery" },
    { root: "skill-sync-staging", parent: false, destination: "outside" },
    { root: "skill-sync-backups", parent: false, destination: "outside" },
    { root: "skill-sync-rollbacks", parent: false, destination: "outside" },
    { root: ".t3-code", parent: true, destination: "discovery" },
    { root: ".t3-code", parent: true, destination: "outside" },
  ] as const)("rejects $destination safety symlink for $root", ({ root, parent, destination }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeSyncFixture();
      yield* writeSkill(path.join(fixture.sourceConfigDir, "skills", "review"), "# Source\n");
      const target = path.join(fixture.targetConfigDir, "skills", "review");
      yield* writeSkill(target, "# Existing\n");
      const outside = path.join(fixture.root, "outside-safety");
      yield* fs.makeDirectory(outside, { recursive: true });
      const link = parent
        ? path.join(fixture.targetConfigDir, ".t3-code")
        : path.join(fixture.targetConfigDir, ".t3-code", root);
      if (!parent) {
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      }
      yield* fs.symlink(
        destination === "discovery" ? path.join(fixture.targetConfigDir, "skills") : outside,
        link,
      );
      const initial = yield* fixture.inventory();

      const error = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.syncClaudeSkills({
            sourceInstanceId,
            targetInstanceId,
            cwd: fixture.cwd,
            mode: "copy",
            nativeIds: ["review"],
            expectedRevision: initial.revision,
            onConflict: "backup",
          }),
        ),
        Effect.flip,
      );

      assert.strictEqual(error._tag, "SkillManagerError");
      assert.strictEqual(
        error._tag === "SkillManagerError" ? error.reason : undefined,
        "invalid-sync-roots",
      );
      assert.strictEqual(yield* fs.readFileString(path.join(target, "SKILL.md")), "# Existing\n");
      assert.strictEqual(fixture.refreshes.length, 0);
    }),
  );

  it.effect("returns the canonical backup path through a safe config-internal symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeSyncFixture();
      yield* writeSkill(path.join(fixture.sourceConfigDir, "skills", "review"), "# Source\n");
      yield* writeSkill(path.join(fixture.targetConfigDir, "skills", "review"), "# Existing\n");
      const safeStorage = path.join(fixture.targetConfigDir, "safe-storage");
      yield* fs.makeDirectory(safeStorage, { recursive: true });
      yield* fs.symlink(safeStorage, path.join(fixture.targetConfigDir, ".t3-code"));
      const initial = yield* fixture.inventory();

      const result = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.syncClaudeSkills({
            sourceInstanceId,
            targetInstanceId,
            cwd: fixture.cwd,
            mode: "copy",
            nativeIds: ["review"],
            expectedRevision: initial.revision,
            onConflict: "backup",
          }),
        ),
      );

      const canonicalStorage = yield* fs.realPath(safeStorage);
      assert.strictEqual(result.backups.length, 1);
      assert.isTrue(result.backups[0]!.path.startsWith(canonicalStorage + path.sep));
      assert.strictEqual(
        yield* fs.readFileString(path.join(result.backups[0]!.path, "SKILL.md")),
        "# Existing\n",
      );
    }),
  );

  it.effect.each(["edit", "add", "replace"] as const)(
    "rejects rollback after an external %s that preserves the install marker",
    (change) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* makeSyncFixture();
        for (const name of ["one", "two"]) {
          yield* writeSkill(path.join(base.sourceConfigDir, "skills", name), `# ${name} source\n`);
          yield* writeSkill(
            path.join(base.targetConfigDir, "skills", name),
            `# ${name} existing\n`,
          );
        }
        const targetRoot = yield* fs.realPath(path.join(base.targetConfigDir, "skills"));
        const firstTarget = path.join(targetRoot, "one");
        const secondTarget = path.join(targetRoot, "two");
        const externalOriginal = path.join(base.root, "external-original");
        const fileSystem: FileSystem.FileSystem = {
          ...fs,
          rename: (source, target) =>
            source.includes(".t3-staging") && target === secondTarget
              ? Effect.gen(function* () {
                  if (change === "edit") {
                    yield* fs.writeFileString(
                      path.join(firstTarget, "SKILL.md"),
                      "# External edit\n",
                    );
                  } else if (change === "add") {
                    yield* fs.writeFileString(path.join(firstTarget, "external.txt"), "external");
                  } else {
                    yield* fs.rename(firstTarget, externalOriginal);
                    yield* writeSkill(firstTarget, "# one source\n").pipe(
                      Effect.provideService(FileSystem.FileSystem, fs),
                      Effect.provideService(Path.Path, path),
                    );
                    const marker = yield* fs.readFileString(
                      path.join(externalOriginal, ".t3-skill-install.json"),
                    );
                    yield* fs.writeFileString(
                      path.join(firstTarget, ".t3-skill-install.json"),
                      marker,
                    );
                  }
                  return yield* fs.rename(path.join(base.root, "missing-staging"), target);
                })
              : fs.rename(source, target),
        };
        const fixture = {
          ...base,
          ...(yield* makeSyncHarness(base.sourceConfigDir, base.targetConfigDir, base.cwd, {
            fileSystem,
          })),
        };
        const initial = yield* fixture.inventory();

        const error = yield* fixture.manager.pipe(
          Effect.flatMap((manager) =>
            manager.syncClaudeSkills({
              sourceInstanceId,
              targetInstanceId,
              cwd: fixture.cwd,
              mode: "copy",
              nativeIds: ["one", "two"],
              expectedRevision: initial.revision,
              onConflict: "backup",
            }),
          ),
          Effect.flip,
        );

        assert.strictEqual(error._tag, "SkillManagerError");
        assert.strictEqual(
          error._tag === "SkillManagerError" ? error.reason : undefined,
          "rollback-incomplete",
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(firstTarget, "SKILL.md")),
          change === "edit" ? "# External edit\n" : "# one source\n",
        );
        if (change === "add") {
          assert.strictEqual(
            yield* fs.readFileString(path.join(firstTarget, "external.txt")),
            "external",
          );
        }
        if (change === "replace") {
          assert.isTrue(yield* fs.exists(externalOriginal));
        }
        const backupRoot = path.join(base.targetConfigDir, ".t3-code", "skill-sync-backups");
        assert.isTrue((yield* fs.readDirectory(backupRoot)).length >= 1);
      }),
  );
});

it.layer(NodeServices.layer)("SkillManager workspace boundaries", (it) => {
  it.effect("accepts a filtered list revision backed by the aggregate inventory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture({
        additionalInstances: [makeAdditionalInventoryInstance("/other")],
      });
      const filtered = yield* fixture.inventory(undefined, instanceId);
      assert.isTrue(filtered.entries.every((entry) => entry.instanceId === instanceId));

      yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:filtered",
            sourceFolder: fixture.sourceFolder,
            expectedRevision: filtered.revision,
          }),
        ),
      );

      assert.isTrue(
        yield* fs.exists(path.join(fixture.configDir, "skills", "filtered", "SKILL.md")),
      );
    }),
  );

  it.effect.each(["install", "setEnabled", "uninstall"] as const)(
    "rejects an unknown cwd before %s",
    (operation) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const unknownCwd = path.join(path.sep, "unregistered-skill-workspace");
        const fixture = yield* makeFixture({
          assertContains: (candidate) =>
            candidate === unknownCwd
              ? Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd: candidate }))
              : Effect.void,
        });
        const destination = path.join(fixture.configDir, "skills", "review");
        yield* writeSkill(destination);
        yield* fs.writeFileString(
          path.join(destination, ".t3-skill-install.json"),
          JSON.stringify({
            version: 1,
            instanceId,
            nativeId: "review",
            installedBy: "r3-code",
          }),
        );
        const initial = yield* fixture.inventory();

        const error = yield* fixture.manager.pipe(
          Effect.flatMap((manager) => {
            const input = {
              instanceId,
              cwd: unknownCwd,
              nativeId: "user:review",
              expectedRevision: initial.revision,
            } as const;
            if (operation === "install") {
              return manager.installSkill({ ...input, sourceFolder: fixture.sourceFolder });
            }
            if (operation === "setEnabled") {
              return manager.setSkillEnabled({ ...input, enabled: false });
            }
            return manager.uninstallSkill(input);
          }),
          Effect.flip,
        );

        assert.strictEqual(error._tag, "SkillManagerError");
        assert.strictEqual(
          error._tag === "SkillManagerError" ? error.reason : undefined,
          "unknown-workspace",
        );
        assert.strictEqual(fixture.refreshes.length, 0);
      }),
  );

  it.effect.each(["install", "setEnabled", "uninstall"] as const)(
    "rejects a project .claude symlink outside the workspace before %s",
    (operation) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeFixture();
        const projectClaude = path.join(fixture.cwd, ".claude");
        yield* writeSkill(path.join(projectClaude, "skills", "review"));
        yield* fs.writeFileString(
          path.join(projectClaude, "skills", "review", ".t3-skill-install.json"),
          JSON.stringify({
            version: 1,
            instanceId,
            nativeId: "review",
            installedBy: "r3-code",
          }),
        );
        const initial = yield* fixture.inventory();
        const outside = path.join(fixture.root, "outside-claude");
        yield* fs.rename(projectClaude, outside);
        yield* fs.symlink(outside, projectClaude);
        const nativeId = operation === "install" ? "project:new-skill" : "project:review";

        const error = yield* fixture.manager.pipe(
          Effect.flatMap((manager) => {
            const input = {
              instanceId,
              cwd: fixture.cwd,
              nativeId,
              expectedRevision: initial.revision,
            } as const;
            if (operation === "install") {
              return manager.installSkill({ ...input, sourceFolder: fixture.sourceFolder });
            }
            if (operation === "setEnabled") {
              return manager.setSkillEnabled({ ...input, enabled: false });
            }
            return manager.uninstallSkill(input);
          }),
          Effect.flip,
        );

        assert.strictEqual(error._tag, "SkillManagerError");
        assert.strictEqual(
          error._tag === "SkillManagerError" ? error.reason : undefined,
          "unknown-workspace",
        );
        assert.strictEqual(fixture.refreshes.length, 0);
        assert.isTrue(yield* fs.exists(path.join(outside, "skills", "review", "SKILL.md")));
        assert.isFalse(yield* fs.exists(path.join(outside, "skills", "new-skill")));
      }),
  );
});

it.layer(NodeServices.layer)("SkillManager skill validation", (it) => {
  it.effect("rejects malformed install frontmatter without leaving a target or staging", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      yield* fs.writeFileString(
        path.join(fixture.sourceFolder, "SKILL.md"),
        "---\nname: [unclosed\n---\n",
      );
      const initial = yield* fixture.inventory();

      const error = yield* fixture.manager.pipe(
        Effect.flatMap((manager) =>
          manager.installSkill({
            instanceId,
            cwd: fixture.cwd,
            nativeId: "user:broken",
            sourceFolder: fixture.sourceFolder,
            expectedRevision: initial.revision,
          }),
        ),
        Effect.flip,
      );

      assert.strictEqual(error._tag, "SkillManagerError");
      assert.strictEqual(
        error._tag === "SkillManagerError" ? error.reason : undefined,
        "invalid-skill-md",
      );
      assert.isFalse(yield* fs.exists(path.join(fixture.configDir, "skills", "broken")));
      assert.isFalse(yield* fs.exists(path.join(fixture.configDir, "skills")));
      assert.isFalse(yield* fs.exists(path.join(fixture.configDir, ".t3-code")));
      assert.strictEqual(fixture.refreshes.length, 0);
    }),
  );

  it.effect.each(["copy", "link"] as const)(
    "rejects malformed %s frontmatter before creating a backup",
    (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeSyncFixture();
        yield* writeSkill(
          path.join(fixture.sourceConfigDir, "skills", "review"),
          "---\nname: [unclosed\n---\n",
        );
        const destination = path.join(fixture.targetConfigDir, "skills", "review");
        yield* writeSkill(destination, "# Existing\n");
        const initial = yield* fixture.inventory();

        const error = yield* fixture.manager.pipe(
          Effect.flatMap((manager) =>
            manager.syncClaudeSkills({
              sourceInstanceId,
              targetInstanceId,
              cwd: fixture.cwd,
              mode,
              nativeIds: ["review"],
              expectedRevision: initial.revision,
              onConflict: "backup",
            }),
          ),
          Effect.flip,
        );

        assert.strictEqual(error._tag, "SkillManagerError");
        assert.strictEqual(
          error._tag === "SkillManagerError" ? error.reason : undefined,
          "invalid-skill-md",
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(destination, "SKILL.md")),
          "# Existing\n",
        );
        assert.isFalse(yield* fs.exists(path.join(fixture.targetConfigDir, ".t3-code")));
        assert.strictEqual(fixture.refreshes.length, 0);
      }),
  );
});
