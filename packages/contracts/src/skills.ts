import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const SkillSource = Schema.Struct({
  kind: Schema.Literals(["file", "plugin", "package", "agent", "managed"]),
  scope: Schema.Literals(["user", "project", "local", "managed", "agent"]),
  path: Schema.optionalKey(Schema.String),
  containerId: Schema.optionalKey(Schema.String),
});
export type SkillSource = typeof SkillSource.Type;

export const SkillInventoryEntry = Schema.Struct({
  instanceId: Schema.String,
  cwd: Schema.String,
  nativeId: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  source: SkillSource,
  state: Schema.Literals(["enabled", "disabled", "shadowed", "unavailable"]),
  actions: Schema.Struct({
    canSetEnabled: Schema.Boolean,
    canUninstall: Schema.Boolean,
    reason: Schema.optionalKey(Schema.String),
  }),
});
export type SkillInventoryEntry = typeof SkillInventoryEntry.Type;

export const SkillInventory = Schema.Struct({
  checkedAt: Schema.String,
  revision: Schema.String,
  entries: Schema.Array(SkillInventoryEntry),
  diagnostics: Schema.Array(Schema.String),
});
export type SkillInventory = typeof SkillInventory.Type;

export class SkillInventoryListError extends Schema.TaggedError<SkillInventoryListError>()(
  "SkillInventoryListError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list skills for '${this.cwd}'.`;
  }
}

export const SkillName = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/));
export const SkillNativeId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(user|project):[a-zA-Z0-9_-]+$/),
);

const skillMutationFields = {
  instanceId: ProviderInstanceId,
  cwd: TrimmedNonEmptyString,
  nativeId: SkillNativeId,
  expectedRevision: TrimmedNonEmptyString,
};

export const SkillInstallInput = Schema.Struct({
  ...skillMutationFields,
  sourceFolder: TrimmedNonEmptyString,
});
export type SkillInstallInput = typeof SkillInstallInput.Type;

export const SkillSetEnabledInput = Schema.Struct({
  ...skillMutationFields,
  enabled: Schema.Boolean,
});
export type SkillSetEnabledInput = typeof SkillSetEnabledInput.Type;

export const SkillUninstallInput = Schema.Struct(skillMutationFields);
export type SkillUninstallInput = typeof SkillUninstallInput.Type;

export const SkillSyncInput = Schema.Struct({
  sourceInstanceId: ProviderInstanceId,
  targetInstanceId: ProviderInstanceId,
  cwd: TrimmedNonEmptyString,
  mode: Schema.Literals(["copy", "link"]),
  nativeIds: Schema.NonEmptyArray(SkillName),
  expectedRevision: TrimmedNonEmptyString,
  onConflict: Schema.optionalKey(Schema.Literals(["cancel", "backup"])),
});
export type SkillSyncInput = typeof SkillSyncInput.Type;

export const SkillMutationResult = Schema.Struct({
  requiresSessionRestart: Schema.Literal(true),
});
export type SkillMutationResult = typeof SkillMutationResult.Type;

export const SkillSyncResult = Schema.Struct({
  requiresSessionRestart: Schema.Literal(true),
  backups: Schema.Array(Schema.Struct({ nativeId: SkillName, path: Schema.String })),
});
export type SkillSyncResult = typeof SkillSyncResult.Type;

export class SkillMutationError extends Schema.TaggedError<SkillMutationError>()(
  "SkillMutationError",
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
