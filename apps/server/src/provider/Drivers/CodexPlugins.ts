import { Effect, Option } from "effect";
import type { PluginInventoryEntry, ProviderInstanceId } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderPluginManagement } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

const CODEX_PLUGIN_TIMEOUT = "20 seconds";

const CODEX_DRIVER = ProviderDriverKind.make("codex");

type CodexPluginParams = {
  readonly "plugin/installed": CodexSchema.V2PluginInstalledParams;
  readonly "plugin/uninstall": CodexSchema.V2PluginUninstallParams;
  readonly "config/value/write": CodexSchema.V2ConfigValueWriteParams;
};

type CodexPluginResults = {
  readonly "plugin/installed": CodexSchema.V2PluginInstalledResponse;
  readonly "plugin/uninstall": CodexSchema.V2PluginUninstallResponse;
  readonly "config/value/write": CodexSchema.V2ConfigWriteResponse;
};

export type CodexPluginRequest = <M extends keyof CodexPluginParams>(
  method: M,
  params: CodexPluginParams[M],
) => Effect.Effect<CodexPluginResults[M], ProviderDriverError>;

const INSTALLED_BY_DEFAULT_REASON =
  "Installed by default; disabling it sticks but uninstalling reinstalls it.";
const WORKSPACE_SETTING_REASON = "Managed by this workspace's settings.";

export function codexPluginEntries(
  response: CodexSchema.V2PluginInstalledResponse,
  context: {
    readonly instanceId: ProviderInstanceId;
    readonly cwd: string;
    readonly configHome: string;
  },
): ReadonlyArray<PluginInventoryEntry> {
  const entries: PluginInventoryEntry[] = [];
  for (const marketplace of response.marketplaces) {
    for (const plugin of marketplace.plugins) {
      if (!plugin.installed) continue;
      const workspaceManaged = plugin.installPolicySource === "WORKSPACE_SETTING";
      const installedByDefault = plugin.installPolicy === "INSTALLED_BY_DEFAULT";
      entries.push({
        instanceId: context.instanceId,
        cwd: context.cwd,
        configHome: context.configHome,
        pluginId: plugin.id,
        name: plugin.name,
        ...(plugin.version === undefined || plugin.version === null
          ? {}
          : { version: plugin.version }),
        marketplace: marketplace.name,
        scope: "user",
        state: plugin.enabled ? "enabled" : "disabled",
        notes: [],
        actions: {
          canSetEnabled: !workspaceManaged,
          canUninstall: !workspaceManaged && !installedByDefault,
          ...(workspaceManaged
            ? { reason: WORKSPACE_SETTING_REASON }
            : installedByDefault
              ? { reason: INSTALLED_BY_DEFAULT_REASON }
              : {}),
        },
      });
    }
  }
  return entries;
}

export function makeCodexPluginManagement(input: {
  readonly configHome: string;
  readonly request: CodexPluginRequest;
  readonly instanceId: ProviderInstanceId;
}): ProviderPluginManagement {
  const request = <M extends keyof CodexPluginParams>(
    method: M,
    params: CodexPluginParams[M],
  ): Effect.Effect<CodexPluginResults[M], ProviderDriverError> =>
    input.request(method, params).pipe(
      Effect.timeoutOption(CODEX_PLUGIN_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new ProviderDriverError({
                driver: CODEX_DRIVER,
                instanceId: input.instanceId,
                detail: `Codex app-server ${method} timed out.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  return {
    configHome: input.configHome,
    list: (cwd) =>
      request("plugin/installed", { cwds: [cwd] }).pipe(
        Effect.map((response) => ({
          entries: codexPluginEntries(response, {
            instanceId: input.instanceId,
            cwd,
            configHome: input.configHome,
          }),
          diagnostics: [],
        })),
      ),
    setEnabled: (mutation) =>
      request("config/value/write", {
        keyPath: "plugins",
        mergeStrategy: "upsert",
        // 插件 id 放在 value 的 key 里，避开 keyPath 对 `.` 和 `@` 的转义。
        value: { [mutation.pluginId]: { enabled: mutation.enabled } },
      }).pipe(Effect.asVoid),
    uninstall: (mutation) =>
      request("plugin/uninstall", { pluginId: mutation.pluginId }).pipe(Effect.asVoid),
  };
}
