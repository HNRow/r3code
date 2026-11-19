import { Effect, Schema } from "effect";
import type { PluginInventoryEntry, ProviderInstanceId } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderPluginManagement } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";

const GROK_DRIVER = ProviderDriverKind.make("grok");
const GROK_PLUGIN_TIMEOUT = "30 seconds";

const GrokProvides = Schema.Struct({
  skills: Schema.optionalKey(Schema.Number),
  agents: Schema.optionalKey(Schema.Number),
  hooks: Schema.optionalKey(Schema.Boolean),
  mcpServers: Schema.optionalKey(Schema.Number),
});

const GrokInspectedPluginSchema = Schema.Struct({
  name: Schema.String,
  scope: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  trusted: Schema.optionalKey(Schema.Boolean),
  provides: Schema.optionalKey(GrokProvides),
});
export type GrokInspectedPlugin = typeof GrokInspectedPluginSchema.Type;

const GrokInstalledPluginSchema = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  name: Schema.String,
  repo_key: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.NullOr(Schema.String)),
  path: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
  marketplace: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type GrokInstalledPlugin = typeof GrokInstalledPluginSchema.Type;

const GrokInspectOutput = Schema.Struct({
  plugins: Schema.Array(GrokInspectedPluginSchema),
});
const GrokPluginListOutput = Schema.Array(GrokInstalledPluginSchema);

const decodeInspect = Schema.decodeUnknownSync(Schema.fromJsonString(GrokInspectOutput));
const decodePluginList = Schema.decodeUnknownSync(Schema.fromJsonString(GrokPluginListOutput));

export type GrokPluginRun = (
  args: ReadonlyArray<string>,
  cwd: string,
) => Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, ProviderDriverError>;

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

function isClaudeSourced(plugin: GrokInspectedPlugin): boolean {
  return (plugin.path ?? "").includes("/.claude/");
}

const CLAUDE_SOURCE_REASON = "Loaded from Claude Code; manage it in Claude Code.";
const UNMANAGED_REASON = "Not installed by `grok plugin`; manage it at its source.";
const SHARED_REPO_REASON =
  "Installed together with other plugins; uninstall it with `grok plugin uninstall`.";

export function grokPluginEntries(input: {
  readonly inspected: ReadonlyArray<GrokInspectedPlugin>;
  readonly installed: ReadonlyArray<GrokInstalledPlugin>;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly configHome: string;
}): ReadonlyArray<PluginInventoryEntry> {
  const installedByPath = new Map<string, GrokInstalledPlugin>();
  const repoCounts = new Map<string, number>();
  for (const plugin of input.installed) {
    if (plugin.path !== undefined) installedByPath.set(normalizePath(plugin.path), plugin);
    if (plugin.repo_key !== undefined) {
      repoCounts.set(plugin.repo_key, (repoCounts.get(plugin.repo_key) ?? 0) + 1);
    }
  }

  return input.inspected.map((plugin) => {
    const installedRecord =
      plugin.path === undefined ? undefined : installedByPath.get(normalizePath(plugin.path));
    const managed = installedRecord !== undefined && !isClaudeSourced(plugin);
    const sharedRepo =
      installedRecord?.repo_key !== undefined &&
      (repoCounts.get(installedRecord.repo_key) ?? 0) > 1;
    const skills = plugin.provides?.skills;
    const scope = plugin.scope === "project" ? "project" : "user";
    const reason = !managed
      ? isClaudeSourced(plugin)
        ? CLAUDE_SOURCE_REASON
        : UNMANAGED_REASON
      : sharedRepo
        ? SHARED_REPO_REASON
        : undefined;

    return {
      instanceId: input.instanceId,
      cwd: input.cwd,
      configHome: input.configHome,
      pluginId: plugin.name,
      name: plugin.name,
      ...(installedRecord?.version === undefined || installedRecord.version === null
        ? {}
        : { version: installedRecord.version }),
      ...(installedRecord?.marketplace === undefined || installedRecord.marketplace === null
        ? {}
        : { marketplace: installedRecord.marketplace }),
      scope,
      state: plugin.enabled ? "enabled" : "disabled",
      ...(skills === undefined || skills <= 0 ? {} : { components: { skills } }),
      notes: [],
      actions: {
        canSetEnabled: managed,
        canUninstall: managed && !sharedRepo,
        ...(reason === undefined ? {} : { reason }),
      },
    } satisfies PluginInventoryEntry;
  });
}

function grokError(instanceId: ProviderInstanceId, detail: string, cause?: unknown) {
  return new ProviderDriverError({
    driver: GROK_DRIVER,
    instanceId,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function errorLine(result: { readonly stdout: string; readonly stderr: string }): string {
  const source = result.stderr.trim().length > 0 ? result.stderr : result.stdout;
  const line = source
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.startsWith("Error:"));
  return line === undefined ? "" : line.slice("Error:".length).trim();
}

export function makeGrokPluginManagement(input: {
  readonly configHome: string;
  readonly instanceId: ProviderInstanceId;
  readonly run: GrokPluginRun;
}): ProviderPluginManagement {
  const run = (args: ReadonlyArray<string>, cwd: string) =>
    input.run(args, cwd).pipe(
      Effect.timeoutOption(GROK_PLUGIN_TIMEOUT),
      Effect.flatMap(
        Effect.fromOption(
          () =>
            grokError(input.instanceId, `grok ${args.join(" ")} timed out.`) as ProviderDriverError,
        ),
      ),
      Effect.filterOrFail(
        (result) => result.exitCode === 0,
        (result) =>
          grokError(input.instanceId, errorLine(result) || `grok ${args.join(" ")} failed.`),
      ),
    );

  const decode = <A>(json: string, detail: string, decodeJson: (value: string) => A) =>
    Effect.try({
      try: () => decodeJson(json),
      catch: (cause) => grokError(input.instanceId, detail, cause),
    });

  return {
    configHome: input.configHome,
    list: Effect.fn("GrokPluginManagement.list")(function* (cwd) {
      const [inspect, pluginList] = yield* Effect.all(
        [run(["inspect", "--json"], cwd), run(["plugin", "list", "--json"], cwd)],
        { concurrency: 2 },
      );
      const inspected = yield* decode(
        inspect.stdout,
        "Could not read `grok inspect --json`.",
        decodeInspect,
      );
      const installed = yield* decode(
        pluginList.stdout,
        "Could not read `grok plugin list --json`.",
        decodePluginList,
      );
      return {
        entries: grokPluginEntries({
          inspected: inspected.plugins,
          installed,
          instanceId: input.instanceId,
          cwd,
          configHome: input.configHome,
        }),
        diagnostics: [],
      };
    }),
    // Grok 的插件没有 per-project 覆盖，scope 只用于契约形状。
    setEnabled: (mutation) =>
      run(
        ["plugin", mutation.enabled ? "enable" : "disable", mutation.pluginId],
        mutation.cwd,
      ).pipe(Effect.asVoid),
    uninstall: (mutation) =>
      run(["plugin", "uninstall", mutation.pluginId, "--keep-data"], mutation.cwd).pipe(
        Effect.asVoid,
      ),
  };
}
