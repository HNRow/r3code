import { Effect, Schema } from "effect";
import type {
  PluginInventoryEntry,
  PluginScope,
  ProviderInstanceId,
  SkillInventoryEntry,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderPluginManagement } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";

export type ClaudePluginRun = (
  args: ReadonlyArray<string>,
  cwd: string,
) => Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, ProviderDriverError>;

export interface ClaudeListedPlugin {
  readonly id: string;
  readonly version?: string;
  readonly scope: PluginScope;
  readonly enabled: boolean;
  readonly installPath?: string;
  readonly projectPath?: string;
  readonly mcpServers?: ReadonlyArray<string>;
  readonly notes?: ReadonlyArray<string>;
}

const ClaudeListedPluginSchema = Schema.Struct({
  id: Schema.String,
  version: Schema.optionalKey(Schema.String),
  scope: Schema.Literals(["user", "project", "local", "managed"]),
  enabled: Schema.Boolean,
  installPath: Schema.optionalKey(Schema.String),
  projectPath: Schema.optionalKey(Schema.String),
  // 实际输出是 {serverName: config} 的对象，早期版本是名字数组。
  mcpServers: Schema.optionalKey(
    Schema.Union([Schema.Array(Schema.String), Schema.Record(Schema.String, Schema.Unknown)]),
  ),
  notes: Schema.optionalKey(Schema.Array(Schema.String)),
});
const ClaudeListedPluginsSchema = Schema.Array(ClaudeListedPluginSchema);

type RawListedPlugin = Schema.Schema.Type<typeof ClaudeListedPluginSchema>;

const parseListed = Schema.decodeUnknownSync(ClaudeListedPluginsSchema);

const mcpServerNames = (value: RawListedPlugin["mcpServers"]): ReadonlyArray<string> | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value : Object.keys(value);

export function parseClaudePluginList(stdout: string): ReadonlyArray<ClaudeListedPlugin> {
  return parseListed(JSON.parse(stdout)).map((plugin) => {
    const names = mcpServerNames(plugin.mcpServers);
    const { mcpServers: _raw, ...rest } = plugin;
    return names === undefined ? rest : { ...rest, mcpServers: names };
  });
}

const PLUGIN_NAME_SEPARATOR = "@";

function pluginNameOf(pluginId: string): string {
  const separator = pluginId.lastIndexOf(PLUGIN_NAME_SEPARATOR);
  return separator <= 0 ? pluginId : pluginId.slice(0, separator);
}

function marketplaceOf(pluginId: string): string | undefined {
  const separator = pluginId.lastIndexOf(PLUGIN_NAME_SEPARATOR);
  return separator <= 0 ? undefined : pluginId.slice(separator + 1);
}

function sameWorkspace(left: string, right: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalize(left) === normalize(right);
}

function isReadOnlyScope(scope: PluginScope): boolean {
  return scope === "managed";
}

const UNLISTED_PLUGIN_REASON = "Not managed by claude plugin; manage it at its source.";

export function claudePluginEntries(input: {
  readonly listed: ReadonlyArray<ClaudeListedPlugin>;
  readonly pluginSkills: ReadonlyArray<SkillInventoryEntry>;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly configHome: string;
}): ReadonlyArray<PluginInventoryEntry> {
  const skillsByContainer = new Map<string, number>();
  for (const skill of input.pluginSkills) {
    const container = skill.source.containerId;
    if (container === undefined) continue;
    skillsByContainer.set(container, (skillsByContainer.get(container) ?? 0) + 1);
  }

  const entries: PluginInventoryEntry[] = [];
  const listedNames = new Set<string>();
  for (const plugin of input.listed) {
    // CLI lists every project install, whichever workspace it was made for.
    if (
      (plugin.scope === "project" || plugin.scope === "local") &&
      plugin.projectPath !== undefined &&
      !sameWorkspace(plugin.projectPath, input.cwd)
    ) {
      continue;
    }
    const name = pluginNameOf(plugin.id);
    listedNames.add(name);
    const readOnly = isReadOnlyScope(plugin.scope);
    const skills = skillsByContainer.get(name);
    entries.push({
      instanceId: input.instanceId,
      cwd: input.cwd,
      configHome: input.configHome,
      pluginId: plugin.id,
      name,
      ...(plugin.version === undefined ? {} : { version: plugin.version }),
      ...(marketplaceOf(plugin.id) === undefined ? {} : { marketplace: marketplaceOf(plugin.id)! }),
      scope: plugin.scope,
      state: plugin.enabled ? "enabled" : "disabled",
      ...(skills === undefined && plugin.mcpServers === undefined
        ? {}
        : {
            components: {
              ...(skills === undefined ? {} : { skills }),
              ...(plugin.mcpServers === undefined ? {} : { mcpServers: plugin.mcpServers }),
            },
          }),
      notes: [...(plugin.notes ?? [])],
      actions: {
        canSetEnabled: !readOnly,
        canUninstall: !readOnly,
        ...(readOnly ? { reason: "Managed by organization policy." } : {}),
      },
    });
  }

  for (const [container, skills] of skillsByContainer) {
    if (listedNames.has(container)) continue;
    entries.push({
      instanceId: input.instanceId,
      cwd: input.cwd,
      configHome: input.configHome,
      pluginId: container,
      name: container,
      scope: "managed",
      state: "enabled",
      components: { skills },
      notes: [],
      actions: { canSetEnabled: false, canUninstall: false, reason: UNLISTED_PLUGIN_REASON },
    });
  }

  return entries;
}

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_PLUGIN_TIMEOUT = "30 seconds";

export function makeClaudePluginManagement(input: {
  readonly configHome: string;
  readonly run: ClaudePluginRun;
  readonly listSkills: (
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<SkillInventoryEntry>, ProviderDriverError>;
  readonly instanceId: ProviderInstanceId;
}): ProviderPluginManagement {
  const run = (args: ReadonlyArray<string>, cwd: string) =>
    input.run(args, cwd).pipe(
      Effect.timeoutOption(CLAUDE_PLUGIN_TIMEOUT),
      Effect.flatMap(
        Effect.fromOption(
          () =>
            new ProviderDriverError({
              driver: CLAUDE_DRIVER,
              instanceId: input.instanceId,
              detail: `claude ${args.join(" ")} timed out.`,
            }),
        ),
      ),
      Effect.filterOrFail(
        (result) => result.exitCode === 0,
        (result) =>
          new ProviderDriverError({
            driver: CLAUDE_DRIVER,
            instanceId: input.instanceId,
            detail: lastLine(result.stderr) || `claude ${args.join(" ")} failed.`,
          }),
      ),
    );

  return {
    configHome: input.configHome,
    list: Effect.fn("ClaudePluginManagement.list")(function* (cwd) {
      const result = yield* run(["plugin", "list", "--json"], cwd);
      const listed = yield* Effect.try({
        try: () => parseClaudePluginList(result.stdout),
        catch: (cause) =>
          new ProviderDriverError({
            driver: CLAUDE_DRIVER,
            instanceId: input.instanceId,
            detail: "Could not parse `claude plugin list --json`.",
            cause,
          }),
      });
      // 组件数量拿不到不影响插件本身。
      const skillScan = yield* input.listSkills(cwd).pipe(Effect.result);
      const pluginSkills =
        skillScan._tag === "Success"
          ? skillScan.success.filter((skill) => skill.source.kind === "plugin")
          : [];
      return {
        entries: claudePluginEntries({
          listed,
          pluginSkills,
          instanceId: input.instanceId,
          cwd,
          configHome: input.configHome,
        }),
        diagnostics:
          skillScan._tag === "Failure"
            ? [`Could not scan plugin skills: ${skillScan.failure.message}`]
            : [],
      };
    }),
    setEnabled: (mutation) =>
      run(
        [
          "plugin",
          mutation.enabled ? "enable" : "disable",
          mutation.pluginId,
          "--scope",
          mutation.scope,
          "--json",
        ],
        mutation.cwd,
      ).pipe(Effect.asVoid),
    uninstall: (mutation) =>
      run(
        [
          "plugin",
          "uninstall",
          mutation.pluginId,
          "--scope",
          mutation.scope,
          "--keep-data",
          "--json",
        ],
        mutation.cwd,
      ).pipe(Effect.asVoid),
  };
}

function lastLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1) ?? ""
  );
}
