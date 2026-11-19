import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PluginId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._@:/+-]{0,199}$/),
);
export type PluginId = typeof PluginId.Type;

export const PluginScope = Schema.Literals(["user", "project", "local", "managed"]);
export type PluginScope = typeof PluginScope.Type;

export const PluginInventoryEntry = Schema.Struct({
  instanceId: Schema.String,
  cwd: Schema.String,
  configHome: Schema.String,
  pluginId: Schema.String,
  name: Schema.String,
  version: Schema.optionalKey(Schema.String),
  marketplace: Schema.optionalKey(Schema.String),
  scope: PluginScope,
  state: Schema.Literals(["enabled", "disabled", "unavailable"]),
  components: Schema.optionalKey(
    Schema.Struct({
      skills: Schema.optionalKey(Schema.Number),
      hooks: Schema.optionalKey(Schema.Boolean),
      mcpServers: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  notes: Schema.Array(Schema.String),
  actions: Schema.Struct({
    canSetEnabled: Schema.Boolean,
    canUninstall: Schema.Boolean,
    reason: Schema.optionalKey(Schema.String),
  }),
});
export type PluginInventoryEntry = typeof PluginInventoryEntry.Type;

export const PluginInstanceInventory = Schema.Struct({
  instanceId: Schema.String,
  supported: Schema.Boolean,
  configHome: Schema.optionalKey(Schema.String),
  revision: Schema.String,
  entries: Schema.Array(PluginInventoryEntry),
});
export type PluginInstanceInventory = typeof PluginInstanceInventory.Type;

export const PluginInventory = Schema.Struct({
  checkedAt: Schema.String,
  instances: Schema.Array(PluginInstanceInventory),
  diagnostics: Schema.Array(Schema.String),
});
export type PluginInventory = typeof PluginInventory.Type;

export const PluginListInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export type PluginListInput = typeof PluginListInput.Type;

const pluginMutationFields = {
  instanceId: ProviderInstanceId,
  cwd: TrimmedNonEmptyString,
  pluginId: PluginId,
  scope: PluginScope,
  expectedRevision: TrimmedNonEmptyString,
};

export const PluginSetEnabledInput = Schema.Struct({
  ...pluginMutationFields,
  enabled: Schema.Boolean,
});
export type PluginSetEnabledInput = typeof PluginSetEnabledInput.Type;

export const PluginUninstallInput = Schema.Struct(pluginMutationFields);
export type PluginUninstallInput = typeof PluginUninstallInput.Type;

export const PluginMutationResult = Schema.Struct({
  requiresSessionRestart: Schema.Literal(true),
});
export type PluginMutationResult = typeof PluginMutationResult.Type;

export class PluginInventoryListError extends Schema.TaggedError<PluginInventoryListError>()(
  "PluginInventoryListError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list plugins for '${this.cwd}'.`;
  }
}

export const PluginMutationReason = Schema.Literals([
  "unknown-workspace",
  "management-unavailable",
  "unknown-plugin",
  "action-not-allowed",
  "provider-failed",
]);
export type PluginMutationReason = typeof PluginMutationReason.Type;

export class PluginMutationError extends Schema.TaggedError<PluginMutationError>()(
  "PluginMutationError",
  {
    operation: Schema.Literals(["setEnabled", "uninstall"]),
    instanceId: ProviderInstanceId,
    cwd: Schema.String,
    pluginId: Schema.String,
    reason: PluginMutationReason,
  },
) {
  override get message(): string {
    return `Plugin ${this.operation} failed for '${this.pluginId}': ${this.reason}.`;
  }
}

export class PluginInventoryConflictError extends Schema.TaggedError<PluginInventoryConflictError>()(
  "PluginInventoryConflictError",
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
