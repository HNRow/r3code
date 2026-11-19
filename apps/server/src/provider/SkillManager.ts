import { ProviderInstanceId, type SkillInventoryEntry } from "@t3tools/contracts";
import type {
  ProviderInstance,
  ProviderSkillManagementTarget,
  ProviderSkillSyncRoots,
} from "@t3tools/provider-core/server/driver";
import type { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as SkillInventoryService from "./SkillInventoryService.ts";

const MAX_SKILL_FILES = 256;
const MAX_SKILL_BYTES = 8 * 1024 * 1024;
const MAX_SKILL_DEPTH = 8;
const INSTALL_MARKER = ".t3-skill-install.json";
const SKILL_NAME = /^[a-zA-Z0-9_-]+$/;

const InstallMarker = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    instanceId: ProviderInstanceId,
    nativeId: Schema.String,
    installedBy: Schema.Literal("r3-code"),
  }),
);
const decodeInstallMarker = Schema.decodeUnknownEffect(InstallMarker);
const encodeInstallMarker = Schema.encodeUnknownSync(InstallMarker);

type SkillOperation = "install" | "setEnabled" | "uninstall" | "sync";
type MutationInput = {
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly nativeId: string;
  readonly expectedRevision: string;
};
type MutationResult = { readonly requiresSessionRestart: true };
type SyncInput = {
  readonly sourceInstanceId: ProviderInstanceId;
  readonly targetInstanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly mode: "copy" | "link";
  readonly nativeIds: ReadonlyArray<string>;
  readonly expectedRevision: string;
  readonly onConflict?: "cancel" | "backup";
};
type SyncResult = MutationResult & {
  readonly backups: ReadonlyArray<{ readonly nativeId: string; readonly path: string }>;
};
type MutationError = SkillManagerError | SkillInventoryService.SkillInventoryConflictError;
type TransactionError =
  | MutationError
  | ProviderDriverError
  | PlatformError.PlatformError
  | KnownWorkspaces.UnknownWorkspaceError;

export class SkillManagerError extends Schema.TaggedError<SkillManagerError>()(
  "SkillManagerError",
  {
    operation: Schema.Literals(["install", "setEnabled", "uninstall", "sync"]),
    instanceId: ProviderInstanceId,
    cwd: Schema.String,
    nativeId: Schema.String,
    reason: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Skill ${this.operation} failed for '${this.nativeId}': ${this.reason}.`;
  }
}

export class SkillManager extends Context.Service<
  SkillManager,
  {
    readonly installSkill: (
      input: MutationInput & { readonly sourceFolder: string },
    ) => Effect.Effect<MutationResult, MutationError>;
    readonly setSkillEnabled: (
      input: MutationInput & { readonly enabled: boolean },
    ) => Effect.Effect<MutationResult, MutationError>;
    readonly uninstallSkill: (input: MutationInput) => Effect.Effect<MutationResult, MutationError>;
    readonly syncClaudeSkills: (input: SyncInput) => Effect.Effect<SyncResult, MutationError>;
  }
>()("t3/provider/SkillManager") {}

const isInside = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
};

const encodeSyncFingerprintEntries = (
  entries: ReadonlyArray<{
    readonly path: string;
    readonly type: string;
    readonly mode: number;
    readonly digest?: string;
    readonly link?: string;
  }>,
) => new TextEncoder().encode(JSON.stringify(entries));

const parseNativeId = (nativeId: string) => {
  const match = /^(user|project):([^:]+)$/.exec(nativeId);
  const scope = match?.[1];
  const name = match?.[2];
  if ((scope !== "user" && scope !== "project") || !name || !SKILL_NAME.test(name)) {
    return undefined;
  }
  return { scope, name } as const;
};

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const inventoryService = yield* SkillInventoryService.SkillInventoryService;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const digester = yield* Digest.Digest;
  const writes = yield* Semaphore.make(1);

  const failure = (
    operation: SkillOperation,
    input: MutationInput,
    reason: string,
    targetPath?: string,
    cause?: unknown,
  ) =>
    new SkillManagerError({
      operation,
      instanceId: input.instanceId,
      cwd: input.cwd,
      nativeId: input.nativeId,
      reason,
      ...(targetPath === undefined ? {} : { path: targetPath }),
      ...(cause === undefined ? {} : { cause }),
    });

  const normalizeErrors = <A, E>(
    operation: SkillOperation,
    input: MutationInput,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, MutationError> =>
    effect.pipe(
      Effect.mapError((cause) => {
        if (typeof cause === "object" && cause !== null && "_tag" in cause) {
          if (cause._tag === "SkillManagerError") {
            return cause as unknown as SkillManagerError;
          }
          if (cause._tag === "SkillInventoryConflictError") {
            return cause as unknown as SkillInventoryService.SkillInventoryConflictError;
          }
          if (cause._tag === "UnknownWorkspaceError") {
            return failure(operation, input, "unknown-workspace", undefined, cause);
          }
        }
        return failure(operation, input, "operation-failed", undefined, cause);
      }),
    );

  const lstatOptional = (target: string) =>
    fileSystem.lstat(target).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
    );

  const prepare = Effect.fnUntraced(function* (operation: SkillOperation, input: MutationInput) {
    yield* knownWorkspaces
      .assertContains(input.cwd)
      .pipe(
        Effect.mapError((cause) =>
          failure(operation, input, "unknown-workspace", undefined, cause),
        ),
      );
    const instance = yield* instanceRegistry.getInstance(input.instanceId);
    if (instance?.skillManagement === undefined) {
      return yield* failure(operation, input, "management-unavailable");
    }
    const inventory = yield* inventoryService.list({
      cwd: input.cwd,
      expectedRevision: input.expectedRevision,
    });
    return { instance, inventory, management: instance.skillManagement };
  });

  const resolveTarget = Effect.fnUntraced(function* (
    operation: SkillOperation,
    input: MutationInput,
    management: NonNullable<ProviderInstance["skillManagement"]>,
  ) {
    const parsed = parseNativeId(input.nativeId);
    if (parsed === undefined) return yield* failure(operation, input, "invalid-native-id");
    const target = yield* management.resolveTarget({ cwd: input.cwd, nativeId: input.nativeId });
    if (
      target.name !== parsed.name ||
      !path.isAbsolute(target.root) ||
      !path.isAbsolute(target.directory) ||
      !path.isAbsolute(target.quarantineRoot) ||
      path.resolve(target.directory) !== path.join(path.resolve(target.root), parsed.name) ||
      path.resolve(target.quarantineRoot) === path.resolve(target.root) ||
      isInside(path, path.resolve(target.root), path.resolve(target.quarantineRoot))
    ) {
      return yield* failure(operation, input, "invalid-resolved-target", target.directory);
    }
    return target;
  });

  const refresh = (input: MutationInput) =>
    providerRegistry
      .refreshWorkspaceSnapshot({ instanceId: input.instanceId, cwd: input.cwd })
      .pipe(
        Effect.map((): MutationResult => ({ requiresSessionRestart: true })),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            Effect.logWarning("Skill mutation succeeded but provider workspace refresh failed", {
              instanceId: input.instanceId,
              cwd: input.cwd,
              cause,
            }).pipe(Effect.as<MutationResult>({ requiresSessionRestart: true })),
        ),
      );

  const mutableEntry = (
    operation: SkillOperation,
    input: MutationInput,
    entries: ReadonlyArray<SkillInventoryEntry>,
  ): Effect.Effect<SkillInventoryEntry, SkillManagerError> => {
    const parsed = parseNativeId(input.nativeId);
    const entry = entries.find(
      (candidate) =>
        candidate.instanceId === input.instanceId && candidate.nativeId === input.nativeId,
    );
    const allowed =
      parsed !== undefined &&
      entry !== undefined &&
      (entry.state === "enabled" || entry.state === "disabled") &&
      entry.source.kind === "file" &&
      entry.source.scope === parsed.scope &&
      entry.source.path !== undefined &&
      (operation === "setEnabled" ? entry.actions.canSetEnabled : true);
    return allowed
      ? Effect.succeed(entry)
      : Effect.fail(failure(operation, input, "entry-not-mutable"));
  };

  const canonicalTarget = Effect.fnUntraced(function* (target: ProviderSkillManagementTarget) {
    yield* fileSystem.makeDirectory(target.root, { recursive: true });
    const root = yield* fileSystem.realPath(target.root);
    return { root, directory: path.join(root, target.name) };
  });

  const validateSkill = Effect.fnUntraced(function* (
    operation: SkillOperation,
    input: MutationInput,
    management: NonNullable<ProviderInstance["skillManagement"]>,
    directory: string,
  ) {
    yield* management
      .validate({ directory })
      .pipe(
        Effect.mapError((cause) =>
          failure(operation, input, "invalid-skill-md", path.join(directory, "SKILL.md"), cause),
        ),
      );
  });

  const copySource = Effect.fnUntraced(function* (
    operation: SkillOperation,
    input: MutationInput,
    source: string,
    destination: string,
    sourceRoot: string,
    depth: number,
    budget: { files: number; bytes: number; readBytes: number },
  ): Effect.fn.Return<void, SkillManagerError | PlatformError.PlatformError> {
    if (depth > MAX_SKILL_DEPTH) {
      return yield* failure(operation, input, "too-deep", source);
    }
    const info = yield* fileSystem.lstat(source);
    if (info.type === "SymbolicLink") {
      return yield* failure(operation, input, "symlink-not-allowed", source);
    }
    const realSource = yield* fileSystem.realPath(source);
    if (realSource !== source && !isInside(path, sourceRoot, realSource)) {
      return yield* failure(operation, input, "source-outside-root", source);
    }
    if (info.type === "Directory") {
      yield* fileSystem.makeDirectory(destination);
      const children = yield* fileSystem.readDirectory(source);
      for (const child of children.sort()) {
        yield* copySource(
          operation,
          input,
          path.join(source, child),
          path.join(destination, child),
          sourceRoot,
          depth + 1,
          budget,
        );
      }
      return;
    }
    if (info.type !== "File") {
      return yield* failure(operation, input, "unsupported-source-entry", source);
    }
    budget.files++;
    budget.bytes += Number(info.size);
    if (budget.files > MAX_SKILL_FILES) {
      return yield* failure(operation, input, "too-many-files", source);
    }
    if (budget.bytes > MAX_SKILL_BYTES) {
      return yield* failure(operation, input, "too-many-bytes", source);
    }
    const contents = yield* fileSystem.readFile(source);
    budget.readBytes += contents.byteLength;
    if (budget.readBytes > MAX_SKILL_BYTES) {
      return yield* failure(operation, input, "too-many-bytes", source);
    }
    yield* fileSystem.writeFile(destination, contents, { mode: info.mode });
  });

  const install = Effect.fn("SkillManager.installSkill")(function* (
    input: MutationInput & { readonly sourceFolder: string },
  ): Effect.fn.Return<MutationResult, TransactionError> {
    const prepared = yield* prepare("install", input);
    const target = yield* resolveTarget("install", input, prepared.management);
    if (
      prepared.inventory.entries.some(
        (entry) => entry.instanceId === input.instanceId && entry.nativeId === input.nativeId,
      )
    ) {
      return yield* failure("install", input, "destination-exists", target.directory);
    }
    const sourceFolder = path.resolve(input.sourceFolder);
    const sourceInfo = yield* lstatOptional(sourceFolder);
    if (sourceInfo?.type !== "Directory") {
      return yield* failure("install", input, "invalid-source", sourceFolder);
    }
    const sourceRoot = yield* fileSystem.realPath(sourceFolder);
    const skillFile = path.join(sourceRoot, "SKILL.md");
    const skillInfo = yield* lstatOptional(skillFile);
    if (skillInfo?.type !== "File" || (yield* fileSystem.readFileString(skillFile)).trim() === "") {
      return yield* failure("install", input, "invalid-skill-md", skillFile);
    }
    yield* validateSkill("install", input, prepared.management, sourceRoot);
    const canonical = yield* canonicalTarget(target);
    if (
      sourceRoot === canonical.directory ||
      isInside(path, sourceRoot, canonical.directory) ||
      isInside(path, canonical.directory, sourceRoot)
    ) {
      return yield* failure("install", input, "source-overlaps-target", sourceRoot);
    }
    if ((yield* lstatOptional(canonical.directory)) !== undefined) {
      return yield* failure("install", input, "destination-exists", canonical.directory);
    }
    const staging = path.join(canonical.root, `.${target.name}.${yield* randomUuidV4}.t3-staging`);
    yield* copySource("install", input, sourceRoot, staging, sourceRoot, 0, {
      files: 0,
      bytes: 0,
      readBytes: 0,
    }).pipe(
      Effect.andThen(validateSkill("install", input, prepared.management, staging)),
      Effect.andThen(
        fileSystem.writeFileString(
          path.join(staging, INSTALL_MARKER),
          encodeInstallMarker({
            version: 1,
            instanceId: input.instanceId,
            nativeId: target.name,
            installedBy: "r3-code",
          }),
        ),
      ),
      Effect.andThen(
        Effect.gen(function* () {
          if ((yield* lstatOptional(canonical.directory)) !== undefined) {
            return yield* failure("install", input, "destination-exists", canonical.directory);
          }
          yield* fileSystem.rename(staging, canonical.directory);
        }),
      ),
      Effect.ensuring(
        fileSystem.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    return yield* refresh(input);
  });

  const setEnabled = Effect.fn("SkillManager.setSkillEnabled")(function* (
    input: MutationInput & { readonly enabled: boolean },
  ): Effect.fn.Return<MutationResult, TransactionError> {
    const prepared = yield* prepare("setEnabled", input);
    const entry = yield* mutableEntry("setEnabled", input, prepared.inventory.entries);
    const target = yield* resolveTarget("setEnabled", input, prepared.management);
    const targetInfo = yield* lstatOptional(target.directory);
    if (targetInfo?.type !== "Directory") {
      return yield* failure("setEnabled", input, "invalid-resolved-target", target.directory);
    }
    const [targetRealPath, entryRealPath] = yield* Effect.all([
      fileSystem.realPath(target.directory),
      fileSystem.realPath(entry.source.path!),
    ]);
    if (targetRealPath !== entryRealPath) {
      return yield* failure("setEnabled", input, "entry-target-mismatch", target.directory);
    }
    yield* prepared.management.setEnabled({
      cwd: input.cwd,
      nativeId: input.nativeId,
      enabled: input.enabled,
    });
    return yield* refresh(input);
  });

  const verifyUninstallTree = Effect.fnUntraced(function* (
    input: MutationInput,
    targetRoot: string,
    current: string,
  ): Effect.fn.Return<void, SkillManagerError | PlatformError.PlatformError> {
    const info = yield* fileSystem.lstat(current);
    if (info.type === "SymbolicLink") {
      return yield* failure("uninstall", input, "symlink-not-allowed", current);
    }
    const realCurrent = yield* fileSystem.realPath(current);
    if (realCurrent !== targetRoot && !isInside(path, targetRoot, realCurrent)) {
      return yield* failure("uninstall", input, "target-outside-root", current);
    }
    if (info.type === "Directory") {
      for (const child of (yield* fileSystem.readDirectory(current)).sort()) {
        yield* verifyUninstallTree(input, targetRoot, path.join(current, child));
      }
    } else if (info.type !== "File") {
      return yield* failure("uninstall", input, "unsupported-target-entry", current);
    }
  });

  const validateUninstallDirectory = Effect.fnUntraced(function* (
    input: MutationInput,
    name: string,
    directory: string,
  ) {
    const info = yield* lstatOptional(directory);
    if (info?.type !== "Directory") {
      return yield* failure("uninstall", input, "invalid-resolved-target", directory);
    }
    const realDirectory = yield* fileSystem.realPath(directory);
    if (realDirectory !== directory) {
      return yield* failure("uninstall", input, "target-outside-root", directory);
    }
    const marker = yield* fileSystem
      .readFileString(path.join(directory, INSTALL_MARKER))
      .pipe(Effect.flatMap(decodeInstallMarker), Effect.option);
    if (
      marker._tag === "None" ||
      marker.value.instanceId !== input.instanceId ||
      marker.value.nativeId !== name
    ) {
      return yield* failure("uninstall", input, "invalid-install-marker", directory);
    }
    yield* verifyUninstallTree(input, directory, directory);
  });

  const uninstall = Effect.fn("SkillManager.uninstallSkill")(function* (
    input: MutationInput,
  ): Effect.fn.Return<MutationResult, TransactionError> {
    const prepared = yield* prepare("uninstall", input);
    const entry = yield* mutableEntry("uninstall", input, prepared.inventory.entries);
    const target = yield* resolveTarget("uninstall", input, prepared.management);
    const rootInfo = yield* lstatOptional(target.root);
    const targetInfo = yield* lstatOptional(target.directory);
    if (rootInfo?.type !== "Directory" || targetInfo?.type !== "Directory") {
      return yield* failure("uninstall", input, "invalid-resolved-target", target.directory);
    }
    const [rootRealPath, targetRealPath, entryRealPath] = yield* Effect.all([
      fileSystem.realPath(target.root),
      fileSystem.realPath(target.directory),
      fileSystem.realPath(entry.source.path!),
    ]);
    if (
      targetRealPath !== entryRealPath ||
      targetRealPath !== path.join(rootRealPath, target.name)
    ) {
      return yield* failure("uninstall", input, "entry-target-mismatch", target.directory);
    }
    yield* validateUninstallDirectory(input, target.name, targetRealPath);
    yield* fileSystem.makeDirectory(target.quarantineRoot, { recursive: true });
    const quarantineRootRealPath = yield* fileSystem.realPath(target.quarantineRoot);
    const configDomainRealPath = path.dirname(rootRealPath);
    if (
      !isInside(path, configDomainRealPath, quarantineRootRealPath) ||
      quarantineRootRealPath === rootRealPath ||
      isInside(path, rootRealPath, quarantineRootRealPath) ||
      isInside(path, quarantineRootRealPath, rootRealPath)
    ) {
      return yield* failure("uninstall", input, "invalid-quarantine-root", quarantineRootRealPath);
    }
    const discoveryRoots = yield* prepared.management.listDiscoveryRoots(input.cwd);
    for (const discoveryRoot of discoveryRoots) {
      const discoveryRootRealPath = yield* fileSystem.realPath(discoveryRoot).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.undefined,
        ),
      );
      if (
        discoveryRootRealPath !== undefined &&
        (quarantineRootRealPath === discoveryRootRealPath ||
          isInside(path, discoveryRootRealPath, quarantineRootRealPath) ||
          isInside(path, quarantineRootRealPath, discoveryRootRealPath))
      ) {
        return yield* failure(
          "uninstall",
          input,
          "invalid-quarantine-root",
          quarantineRootRealPath,
        );
      }
    }
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        let container: string | undefined;
        for (let attempt = 0; attempt < 8 && container === undefined; attempt++) {
          const candidate = path.join(
            quarantineRootRealPath,
            `.${target.name}.${yield* randomUuidV4}.t3-quarantine`,
          );
          const reservation = yield* fileSystem.makeDirectory(candidate).pipe(Effect.result);
          if (reservation._tag === "Success") {
            container = candidate;
          } else if (reservation.failure.reason._tag !== "AlreadyExists") {
            return yield* reservation.failure;
          }
        }
        if (container === undefined) {
          return yield* failure("uninstall", input, "quarantine-conflict", quarantineRootRealPath);
        }
        const quarantine = path.join(container, "skill");
        const moved = yield* fileSystem.rename(targetRealPath, quarantine).pipe(Effect.result);
        if (moved._tag === "Failure") {
          yield* fileSystem.remove(container).pipe(Effect.ignore);
          return yield* moved.failure;
        }
        const validation = yield* Effect.gen(function* () {
          const quarantineRealPath = yield* fileSystem.realPath(quarantine);
          if (
            quarantineRealPath !== quarantine ||
            path.dirname(quarantineRealPath) !== container ||
            path.dirname(container) !== quarantineRootRealPath
          ) {
            return yield* failure("uninstall", input, "target-outside-root", quarantine);
          }
          yield* validateUninstallDirectory(input, target.name, quarantine);
        }).pipe(Effect.result);
        if (validation._tag === "Failure") {
          yield* refresh(input).pipe(Effect.ignore);
          return yield* validation.failure;
        }
      }),
    );
    return yield* refresh(input);
  });

  const syncMutationInput = (input: SyncInput, nativeId = "batch"): MutationInput => ({
    instanceId: input.targetInstanceId,
    cwd: input.cwd,
    nativeId,
    expectedRevision: input.expectedRevision,
  });

  const syncFailure = (
    input: SyncInput,
    nativeId: string,
    reason: string,
    targetPath?: string,
    cause?: unknown,
  ) => failure("sync", syncMutationInput(input, nativeId), reason, targetPath, cause);

  const validateSyncRoots = Effect.fnUntraced(function* (
    input: SyncInput,
    roots: ProviderSkillSyncRoots,
  ) {
    const resolved = {
      configRoot: path.resolve(roots.configRoot),
      skillsRoot: path.resolve(roots.skillsRoot),
      backupRoot: path.resolve(roots.backupRoot),
      rollbackRoot: path.resolve(roots.rollbackRoot),
    };
    if (
      !path.isAbsolute(roots.configRoot) ||
      !path.isAbsolute(roots.skillsRoot) ||
      !path.isAbsolute(roots.backupRoot) ||
      !path.isAbsolute(roots.rollbackRoot) ||
      resolved.skillsRoot !== path.join(resolved.configRoot, "skills") ||
      resolved.backupRoot !== path.join(resolved.configRoot, ".t3-code", "skill-sync-backups") ||
      resolved.rollbackRoot !== path.join(resolved.configRoot, ".t3-code", "skill-sync-rollbacks")
    ) {
      return yield* syncFailure(input, "batch", "invalid-sync-roots", roots.configRoot);
    }
    return resolved;
  });

  type SyncSafetyContext = {
    readonly configDomain: string;
    readonly targetRoot: string;
    readonly discoveryRoots: ReadonlyArray<string>;
  };

  const overlaps = (left: string, right: string) =>
    left === right || isInside(path, left, right) || isInside(path, right, left);

  const canonicalPath = Effect.fnUntraced(function* (candidate: string) {
    const suffix: string[] = [];
    let current = path.resolve(candidate);
    while (true) {
      const resolved = yield* fileSystem.realPath(current).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.undefined,
        ),
      );
      if (resolved !== undefined) return path.join(resolved, ...suffix);
      const parent = path.dirname(current);
      if (parent === current) return current;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  });

  const validateSafetyRoot = Effect.fnUntraced(function* (
    input: SyncInput,
    canonicalRoot: string,
    safety: SyncSafetyContext,
  ) {
    if (
      !isInside(path, safety.configDomain, canonicalRoot) ||
      overlaps(safety.targetRoot, canonicalRoot) ||
      safety.discoveryRoots.some((discoveryRoot) => overlaps(discoveryRoot, canonicalRoot))
    ) {
      return yield* syncFailure(input, "batch", "invalid-sync-roots", canonicalRoot);
    }
    return canonicalRoot;
  });

  const reserveSyncContainer = Effect.fnUntraced(function* (
    input: SyncInput,
    nativeId: string,
    root: string,
    kind: "staging" | "backup" | "rollback",
    safety: SyncSafetyContext,
    timestamp?: string,
  ) {
    yield* fileSystem.makeDirectory(root, { recursive: true });
    const canonicalRoot = yield* validateSafetyRoot(
      input,
      yield* fileSystem.realPath(root),
      safety,
    );
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = path.join(
        canonicalRoot,
        `.${nativeId}.${timestamp === undefined ? "" : `${timestamp}.`}${yield* randomUuidV4}.t3-${kind}`,
      );
      const reservation = yield* fileSystem.makeDirectory(candidate).pipe(Effect.result);
      if (reservation._tag === "Success") {
        return {
          root: canonicalRoot,
          container: candidate,
          directory: path.join(candidate, "skill"),
        };
      }
      if (reservation.failure.reason._tag !== "AlreadyExists") {
        return yield* reservation.failure;
      }
    }
    return yield* syncFailure(input, nativeId, `${kind}-conflict`, canonicalRoot);
  });

  const renameSyncTarget = Effect.fnUntraced(function* (
    input: SyncInput,
    nativeId: string,
    source: string,
    destination: string,
  ) {
    if ((yield* lstatOptional(destination)) !== undefined) {
      return yield* syncFailure(input, nativeId, "destination-exists", destination);
    }
    yield* fileSystem.rename(source, destination);
  });

  type CopyFingerprint = {
    readonly digest: string;
    readonly dev: bigint;
    readonly ino: bigint | undefined;
  };

  const fingerprintSyncDirectory = Effect.fnUntraced(function* (
    input: SyncInput,
    nativeId: string,
    directory: string,
  ): Effect.fn.Return<CopyFingerprint, SkillManagerError | PlatformError.PlatformError> {
    const entries: Array<{
      readonly path: string;
      readonly type: string;
      readonly mode: number;
      readonly digest?: string;
      readonly link?: string;
    }> = [];
    const budget = { files: 0, bytes: 0, readBytes: 0 };
    const visit = Effect.fnUntraced(function* (
      current: string,
      relative: string,
      depth: number,
    ): Effect.fn.Return<void, SkillManagerError | PlatformError.PlatformError> {
      if (depth > MAX_SKILL_DEPTH) {
        return yield* syncFailure(input, nativeId, "fingerprint-limit", current);
      }
      const info = yield* fileSystem.lstat(current);
      const entry: {
        path: string;
        type: string;
        mode: number;
        digest?: string;
        link?: string;
      } = { path: relative, type: info.type, mode: info.mode };
      entries.push(entry);
      if (info.type === "File") {
        budget.files++;
        budget.bytes += Number(info.size);
        if (budget.files > MAX_SKILL_FILES || budget.bytes > MAX_SKILL_BYTES) {
          return yield* syncFailure(input, nativeId, "fingerprint-limit", current);
        }
        const contents = yield* fileSystem.readFile(current);
        budget.readBytes += contents.byteLength;
        if (budget.readBytes > MAX_SKILL_BYTES) {
          return yield* syncFailure(input, nativeId, "fingerprint-limit", current);
        }
        entry.digest = Hex.encode(yield* digester.digest(Digest.sha256, contents));
        return;
      }
      if (info.type === "SymbolicLink") {
        entry.link = yield* fileSystem.readLink(current);
        return;
      }
      if (info.type !== "Directory") return;
      for (const child of (yield* fileSystem.readDirectory(current)).sort()) {
        yield* visit(
          path.join(current, child),
          relative === "." ? child : `${relative}/${child}`,
          depth + 1,
        );
      }
    });
    yield* visit(directory, ".", 0);
    const rootInfo = yield* fileSystem.lstat(directory);
    return {
      digest: Hex.encode(
        yield* digester.digest(Digest.sha256, encodeSyncFingerprintEntries(entries)),
      ),
      dev: rootInfo.dev,
      ino: rootInfo.ino._tag === "Some" ? rootInfo.ino.value : undefined,
    };
  });

  const committedSyncTargetIntact = Effect.fnUntraced(function* (
    input: SyncInput,
    target: {
      readonly nativeId: string;
      readonly directory: string;
      readonly mode: "copy" | "link";
      readonly sourceDirectory: string;
      readonly fingerprint?: CopyFingerprint;
    },
  ) {
    const info = yield* lstatOptional(target.directory);
    if (target.mode === "link") {
      return (
        info?.type === "SymbolicLink" &&
        (yield* fileSystem.readLink(target.directory)) === target.sourceDirectory
      );
    }
    if (info?.type !== "Directory" || target.fingerprint === undefined) return false;
    const realDirectory = yield* fileSystem.realPath(target.directory);
    if (
      realDirectory !== target.directory ||
      info.dev !== target.fingerprint.dev ||
      (target.fingerprint.ino !== undefined &&
        (info.ino._tag === "None" || info.ino.value !== target.fingerprint.ino))
    ) {
      return false;
    }
    const marker = yield* fileSystem
      .readFileString(path.join(target.directory, INSTALL_MARKER))
      .pipe(Effect.flatMap(decodeInstallMarker), Effect.option);
    if (
      marker._tag === "None" ||
      marker.value.instanceId !== input.targetInstanceId ||
      marker.value.nativeId !== target.nativeId
    ) {
      return false;
    }
    const current = yield* fingerprintSyncDirectory(input, target.nativeId, target.directory).pipe(
      Effect.result,
    );
    return current._tag === "Success" && current.success.digest === target.fingerprint.digest;
  });

  const sync = Effect.fn("SkillManager.syncClaudeSkills")(function* (
    input: SyncInput,
  ): Effect.fn.Return<SyncResult, TransactionError> {
    const nativeIdSet = new Set(input.nativeIds);
    if (
      input.nativeIds.length === 0 ||
      nativeIdSet.size !== input.nativeIds.length ||
      input.nativeIds.some((nativeId) => !SKILL_NAME.test(nativeId))
    ) {
      return yield* syncFailure(input, "batch", "invalid-native-id");
    }
    if (input.sourceInstanceId === input.targetInstanceId) {
      return yield* syncFailure(input, "batch", "same-instance");
    }
    if (input.mode !== "copy" && input.mode !== "link") {
      return yield* syncFailure(input, "batch", "invalid-mode");
    }
    const onConflict = input.onConflict ?? "cancel";
    if (onConflict !== "cancel" && onConflict !== "backup") {
      return yield* syncFailure(input, "batch", "invalid-conflict-mode");
    }
    yield* knownWorkspaces
      .assertContains(input.cwd)
      .pipe(
        Effect.mapError((cause) =>
          syncFailure(input, "batch", "unknown-workspace", undefined, cause),
        ),
      );

    const [sourceInstance, targetInstance] = yield* Effect.all([
      instanceRegistry.getInstance(input.sourceInstanceId),
      instanceRegistry.getInstance(input.targetInstanceId),
    ]);
    const fullAdapter = (instance: ProviderInstance | undefined) =>
      instance?.enabled === true &&
      instance.driverKind === "claudeAgent" &&
      instance.skillInventory !== undefined &&
      instance.skillManagement?.resolveSyncRoots !== undefined;
    if (!fullAdapter(sourceInstance) || !fullAdapter(targetInstance)) {
      return yield* syncFailure(input, "batch", "management-unavailable");
    }
    const sourceManagement = sourceInstance!.skillManagement!;
    const targetManagement = targetInstance!.skillManagement!;
    const [sourceRoots, targetRoots] = yield* Effect.all([
      sourceManagement
        .resolveSyncRoots(input.cwd)
        .pipe(Effect.flatMap((roots) => validateSyncRoots(input, roots))),
      targetManagement
        .resolveSyncRoots(input.cwd)
        .pipe(Effect.flatMap((roots) => validateSyncRoots(input, roots))),
    ]);
    yield* inventoryService.list({
      cwd: input.cwd,
      expectedRevision: input.expectedRevision,
    });

    const sourceRootInfo = yield* lstatOptional(sourceRoots.skillsRoot);
    if (sourceRootInfo?.type !== "Directory") {
      return yield* syncFailure(input, "batch", "invalid-source", sourceRoots.skillsRoot);
    }
    const sourceSkillsRoot = yield* fileSystem.realPath(sourceRoots.skillsRoot);
    const targetRootInfo = yield* lstatOptional(targetRoots.skillsRoot);
    if (targetRootInfo !== undefined && targetRootInfo.type !== "Directory") {
      return yield* syncFailure(input, "batch", "invalid-resolved-target", targetRoots.skillsRoot);
    }
    const targetSkillsRoot =
      targetRootInfo === undefined
        ? targetRoots.skillsRoot
        : yield* fileSystem.realPath(targetRoots.skillsRoot);
    if (sourceSkillsRoot === targetSkillsRoot) {
      return yield* syncFailure(input, "batch", "source-overlaps-target", sourceSkillsRoot);
    }

    const prepared: Array<{
      readonly nativeId: string;
      readonly sourceRoot: string;
      readonly sourceDirectory: string;
      targetDirectory: string;
      stagingDirectory?: string;
      fingerprint?: CopyFingerprint;
    }> = [];
    for (const nativeId of input.nativeIds) {
      const sourceDirectory = path.join(sourceSkillsRoot, nativeId);
      const targetDirectory = path.join(targetSkillsRoot, nativeId);
      const sourceInfo = yield* lstatOptional(sourceDirectory);
      if (sourceInfo?.type !== "Directory") {
        return yield* syncFailure(input, nativeId, "invalid-source", sourceDirectory);
      }
      const realSourceDirectory = yield* fileSystem.realPath(sourceDirectory);
      if (realSourceDirectory !== sourceDirectory) {
        return yield* syncFailure(input, nativeId, "source-outside-root", sourceDirectory);
      }
      const skillFile = path.join(sourceDirectory, "SKILL.md");
      const skillInfo = yield* lstatOptional(skillFile);
      if (
        skillInfo?.type !== "File" ||
        (yield* fileSystem.readFileString(skillFile)).trim() === ""
      ) {
        return yield* syncFailure(input, nativeId, "invalid-skill-md", skillFile);
      }
      yield* validateSkill(
        "sync",
        syncMutationInput(input, nativeId),
        sourceManagement,
        sourceDirectory,
      );
      if ((yield* lstatOptional(targetDirectory)) !== undefined && onConflict === "cancel") {
        return yield* syncFailure(input, nativeId, "destination-exists", targetDirectory);
      }
      prepared.push({
        nativeId,
        sourceRoot: sourceSkillsRoot,
        sourceDirectory,
        targetDirectory,
      });
    }

    yield* fileSystem.makeDirectory(targetRoots.skillsRoot, { recursive: true });
    const canonicalTargetRoot = yield* fileSystem.realPath(targetRoots.skillsRoot);
    if (canonicalTargetRoot === sourceSkillsRoot) {
      return yield* syncFailure(input, "batch", "source-overlaps-target", canonicalTargetRoot);
    }
    const configDomain = path.dirname(canonicalTargetRoot);
    const safetyRoots = {
      staging: path.join(configDomain, ".t3-code", "skill-sync-staging"),
      backup: path.join(configDomain, ".t3-code", "skill-sync-backups"),
      rollback: path.join(configDomain, ".t3-code", "skill-sync-rollbacks"),
    };
    const discoveryRoots = yield* targetManagement.listDiscoveryRoots(input.cwd);
    const canonicalDiscoveryRoots = yield* Effect.forEach(discoveryRoots, canonicalPath);
    const canonicalSafetyRoots = yield* Effect.all({
      staging: canonicalPath(safetyRoots.staging),
      backup: canonicalPath(safetyRoots.backup),
      rollback: canonicalPath(safetyRoots.rollback),
    });
    const safety = {
      configDomain,
      targetRoot: canonicalTargetRoot,
      discoveryRoots: canonicalDiscoveryRoots,
    };
    for (const safetyRoot of Object.values(canonicalSafetyRoots)) {
      yield* validateSafetyRoot(input, safetyRoot, safety);
    }

    const canonicalTargets = yield* Effect.forEach(prepared, (item) =>
      Effect.gen(function* () {
        item.targetDirectory = path.join(canonicalTargetRoot, item.nativeId);
        return yield* canonicalPath(item.targetDirectory);
      }),
    );
    const overlapTargets = [
      ...canonicalTargets,
      ...(input.mode === "copy" ? [canonicalSafetyRoots.staging] : []),
      canonicalSafetyRoots.backup,
      canonicalSafetyRoots.rollback,
    ];
    for (const source of [sourceSkillsRoot, ...prepared.map((item) => item.sourceDirectory)]) {
      for (const target of overlapTargets) {
        if (overlaps(source, target)) {
          return yield* syncFailure(input, "batch", "source-overlaps-target", target);
        }
      }
    }

    const staging =
      input.mode === "copy"
        ? yield* reserveSyncContainer(input, "batch", safetyRoots.staging, "staging", safety)
        : undefined;
    const committedTargets: Array<{
      readonly nativeId: string;
      readonly directory: string;
      readonly mode: "copy" | "link";
      readonly sourceDirectory: string;
      readonly fingerprint?: CopyFingerprint;
    }> = [];
    const committedBackups: Array<{
      readonly nativeId: string;
      readonly directory: string;
      readonly backupPath: string;
      readonly container: string;
    }> = [];

    const rollback = Effect.fnUntraced(function* () {
      for (const target of [...committedTargets].reverse()) {
        const intact = yield* committedSyncTargetIntact(input, target).pipe(Effect.result);
        if (intact._tag === "Failure" || !intact.success) {
          return yield* syncFailure(
            input,
            target.nativeId,
            "rollback-incomplete",
            target.directory,
          );
        }
        const quarantine = yield* reserveSyncContainer(
          input,
          target.nativeId,
          safetyRoots.rollback,
          "rollback",
          safety,
        ).pipe(Effect.result);
        if (quarantine._tag === "Failure") {
          return yield* syncFailure(
            input,
            target.nativeId,
            "rollback-incomplete",
            target.directory,
            quarantine.failure,
          );
        }
        const moved = yield* fileSystem
          .rename(target.directory, quarantine.success.directory)
          .pipe(Effect.result);
        if (moved._tag === "Failure") {
          return yield* syncFailure(
            input,
            target.nativeId,
            "rollback-incomplete",
            quarantine.success.directory,
            moved.failure,
          );
        }
      }
      for (const backup of [...committedBackups].reverse()) {
        if ((yield* lstatOptional(backup.directory)) !== undefined) {
          return yield* syncFailure(
            input,
            backup.nativeId,
            "rollback-incomplete",
            backup.backupPath,
          );
        }
        const restored = yield* fileSystem
          .rename(backup.backupPath, backup.directory)
          .pipe(Effect.result);
        if (restored._tag === "Failure") {
          return yield* syncFailure(
            input,
            backup.nativeId,
            "rollback-incomplete",
            backup.backupPath,
            restored.failure,
          );
        }
        yield* fileSystem.remove(backup.container).pipe(Effect.ignore);
      }
    });

    const result = yield* Effect.gen(function* () {
      for (const item of prepared) {
        item.targetDirectory = path.join(canonicalTargetRoot, item.nativeId);
        if (input.mode === "copy") {
          item.stagingDirectory = path.join(staging!.container, item.nativeId);
          yield* copySource(
            "sync",
            syncMutationInput(input, item.nativeId),
            item.sourceDirectory,
            item.stagingDirectory,
            item.sourceRoot,
            0,
            { files: 0, bytes: 0, readBytes: 0 },
          );
          yield* validateSkill(
            "sync",
            syncMutationInput(input, item.nativeId),
            targetManagement,
            item.stagingDirectory,
          );
          yield* fileSystem.writeFileString(
            path.join(item.stagingDirectory, INSTALL_MARKER),
            encodeInstallMarker({
              version: 1,
              instanceId: input.targetInstanceId,
              nativeId: item.nativeId,
              installedBy: "r3-code",
            }),
          );
          item.fingerprint = yield* fingerprintSyncDirectory(
            input,
            item.nativeId,
            item.stagingDirectory,
          );
        }
      }

      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const outcome = yield* Effect.gen(function* () {
            for (const item of prepared) {
              const existing = yield* lstatOptional(item.targetDirectory);
              if (existing !== undefined && onConflict === "cancel") {
                return yield* syncFailure(
                  input,
                  item.nativeId,
                  "destination-exists",
                  item.targetDirectory,
                );
              }
              if (existing !== undefined) {
                const timestamp = DateTime.formatIso(yield* DateTime.now).replace(
                  /[^a-zA-Z0-9]/g,
                  "-",
                );
                const backup = yield* reserveSyncContainer(
                  input,
                  item.nativeId,
                  safetyRoots.backup,
                  "backup",
                  safety,
                  timestamp,
                );
                yield* fileSystem.rename(item.targetDirectory, backup.directory);
                committedBackups.push({
                  nativeId: item.nativeId,
                  directory: item.targetDirectory,
                  backupPath: backup.directory,
                  container: backup.container,
                });
              }
              if (input.mode === "copy") {
                yield* renameSyncTarget(
                  input,
                  item.nativeId,
                  item.stagingDirectory!,
                  item.targetDirectory,
                );
              } else {
                if ((yield* lstatOptional(item.targetDirectory)) !== undefined) {
                  return yield* syncFailure(
                    input,
                    item.nativeId,
                    "destination-exists",
                    item.targetDirectory,
                  );
                }
                yield* fileSystem.symlink(item.sourceDirectory, item.targetDirectory);
              }
              committedTargets.push({
                nativeId: item.nativeId,
                directory: item.targetDirectory,
                mode: input.mode,
                sourceDirectory: item.sourceDirectory,
                ...(item.fingerprint === undefined ? {} : { fingerprint: item.fingerprint }),
              });
            }
            return committedBackups.map(({ nativeId, backupPath }) => ({
              nativeId,
              path: backupPath,
            }));
          }).pipe(Effect.result);
          if (outcome._tag === "Success") return outcome.success;
          const rolledBack = yield* rollback().pipe(Effect.result);
          if (rolledBack._tag === "Failure") return yield* rolledBack.failure;
          return yield* outcome.failure;
        }),
      );
    }).pipe(
      Effect.ensuring(
        staging === undefined
          ? Effect.void
          : fileSystem
              .remove(staging.container, { recursive: true, force: true })
              .pipe(
                Effect.andThen(fileSystem.remove(staging.root).pipe(Effect.ignore)),
                Effect.ignore,
              ),
      ),
    );

    yield* refresh(syncMutationInput(input));
    return { requiresSessionRestart: true, backups: result };
  });

  const serialized = <A, E>(
    operation: SkillOperation,
    input: MutationInput,
    effect: Effect.Effect<A, E>,
  ) => writes.withPermits(1)(normalizeErrors(operation, input, effect));

  // Untraced: these wrappers only serialize operations that already have spans.
  return SkillManager.of({
    installSkill: Effect.fnUntraced(function* (input) {
      return yield* serialized("install", input, install(input));
    }),
    setSkillEnabled: Effect.fnUntraced(function* (input) {
      return yield* serialized("setEnabled", input, setEnabled(input));
    }),
    uninstallSkill: Effect.fnUntraced(function* (input) {
      return yield* serialized("uninstall", input, uninstall(input));
    }),
    syncClaudeSkills: Effect.fnUntraced(function* (input) {
      return yield* serialized("sync", syncMutationInput(input), sync(input));
    }),
  });
});

export const layer = Layer.effect(SkillManager, make);
