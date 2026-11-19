import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  filterPluginEntries,
  instanceScanProblem,
  instancesSharingConfigHome,
} from "@t3tools/client-runtime/pluginInventory";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { ProviderInstanceId } from "@t3tools/contracts";
import type {
  PluginInventory,
  PluginInventoryEntry,
  PluginSetEnabledInput,
  PluginUninstallInput,
} from "@t3tools/contracts";
import { useContext, useEffect, useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";
import { useGT, useMessages } from "gt-react-native";
import { t } from "../../i18n/gt";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

const PLUGIN_STATE_LABELS = (): Readonly<Record<PluginInventoryEntry["state"], string>> => ({
  get enabled() {
    return t("Enabled");
  },
  get disabled() {
    return t("Disabled");
  },
  get unavailable() {
    return t("Unavailable");
  },
});

export function PluginsSettingsScreen() {
  const gt = useGT();
  const m = useMessages();
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const projects = useProjects();
  const connected = environments.filter((entry) => entry.connection.phase === "connected");
  const environment = connected[0] ?? null;
  const environmentId = environment?.environmentId ?? null;
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const providerLabels: ReadonlyMap<string, string> = new Map(
    (serverConfig?.providers ?? []).map((provider) => [
      provider.instanceId,
      resolveProviderInstanceDisplayName(provider),
    ]),
  );
  const selectableProjects = projects.filter(
    (project) =>
      project.environmentId === environmentId && project.archivedAt == null && !project.isScratch,
  );
  const [projectChoice, setProjectChoice] = useState("");
  const project =
    selectableProjects.find((entry) => entry.id === projectChoice) ?? selectableProjects[0] ?? null;
  const cwd = project?.workspaceRoot ?? null;
  const [query, setQuery] = useState("");
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [request, setRequest] = useState<{
    readonly targetKey: string;
    readonly inventory: PluginInventory | null;
    readonly error: string | null;
  }>({ targetKey: "", inventory: null, error: null });
  const targetKey =
    environmentId === null || cwd === null
      ? null
      : JSON.stringify([environmentId, cwd, refreshIndex]);
  const [busy, setBusy] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the selected environment's plugin inventory and ignores stale replies
  useEffect(() => {
    if (environmentId === null || cwd === null || targetKey === null) return;
    let active = true;
    void runAtomCommand(
      registry,
      serverEnvironment.pluginInventory,
      { environmentId, input: { cwd } },
      { reportFailure: false, reportDefect: false },
    ).then((result) => {
      if (!active) return;
      setRequest(
        result._tag === "Success"
          ? { targetKey, inventory: result.value, error: null }
          : {
              targetKey,
              inventory: null,
              error: formatEnvironmentQueryError(result.cause),
            },
      );
    });
    return () => {
      active = false;
    };
  }, [registry, environmentId, cwd, targetKey]);

  const refresh = () => setRefreshIndex((value) => value + 1);
  const inventory = request.targetKey === targetKey ? request.inventory : null;
  const pending = targetKey !== null && request.targetKey !== targetKey;
  const error = request.targetKey === targetKey ? request.error : null;

  const mutate = async (
    command: typeof serverEnvironment.setPluginEnabled | typeof serverEnvironment.uninstallPlugin,
    input: PluginSetEnabledInput | PluginUninstallInput,
  ) => {
    if (environmentId === null) return;
    setBusy(true);
    const result = await runAtomCommand(
      registry,
      command as typeof serverEnvironment.setPluginEnabled,
      { environmentId, input: input as PluginSetEnabledInput },
      { reportFailure: false, reportDefect: false },
    );
    setBusy(false);
    if (result._tag === "Failure") {
      setRequest({
        targetKey: targetKey ?? "",
        inventory: null,
        error: formatEnvironmentQueryError(result.cause),
      });
      refresh();
      return;
    }
    setRestartRequired(result.value.requiresSessionRestart);
    refresh();
  };

  const confirmUninstall = (entry: PluginInventoryEntry, revision: string) => {
    Alert.alert(
      m("Uninstall this plugin?"),
      m(
        "R3 Code cannot reinstall it. Reinstall from its CLI: `claude plugin install` or `codex plugin add`.",
      ),
      [
        { text: gt("Cancel"), style: "cancel" },
        {
          text: gt("Uninstall"),
          style: "destructive",
          onPress: () =>
            void mutate(serverEnvironment.uninstallPlugin, {
              instanceId: ProviderInstanceId.make(entry.instanceId),
              cwd: entry.cwd,
              pluginId: entry.pluginId,
              scope: entry.scope,
              expectedRevision: revision,
            }),
        },
      ],
    );
  };

  const labels = PLUGIN_STATE_LABELS();

  return (
    <SettingsScreen title={m("Plugins")}>
      <SettingsSection
        title={m("Plugins")}
        footer={m("Plugins installed on this environment's providers.")}
      >
        <View className="flex-row items-center justify-between px-4 py-2">
          <Text className="text-sm text-foreground">{gt("Project")}</Text>
          <View className="flex-1 flex-row flex-wrap justify-end gap-2">
            {selectableProjects.map((option) => (
              <Pressable
                key={option.id}
                onPress={() => setProjectChoice(option.id)}
                accessibilityRole="button"
              >
                <Text
                  className={
                    option.id === project?.id
                      ? "text-sm font-t3-medium text-foreground"
                      : "text-sm text-foreground-muted"
                  }
                >
                  {option.title}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        <View className="px-4 pb-2">
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={m("Name, id, or marketplace")}
            placeholderTextColor="#8a8a8e"
            className="rounded-md border border-border px-2 py-1.5 text-sm text-foreground"
          />
        </View>
        <View className="flex-row items-center justify-between px-4 pb-2">
          <Button label={gt("Refresh")} tone="secondary" onPress={refresh} disabled={busy} />
          {restartRequired ? (
            <Text className="ml-2 flex-1 text-xs text-foreground-muted">
              {m("Plugin changes apply to new agent sessions. Restart agent sessions to use them.")}
            </Text>
          ) : null}
        </View>
      </SettingsSection>

      {inventory !== null && inventory.diagnostics.length > 0 ? (
        <SettingsSection title={m("Scan problems")}>
          {inventory.diagnostics.map((diagnostic) => (
            <Text key={diagnostic} className="px-4 py-2 text-xs text-foreground-muted">
              {diagnostic}
            </Text>
          ))}
        </SettingsSection>
      ) : null}
      {error === null ? null : (
        <SettingsSection title={m("Scan problems")}>
          <Text className="px-4 py-2 text-xs text-danger-foreground">{error}</Text>
        </SettingsSection>
      )}

      {connected.length === 0 ? (
        <Text className="px-4 py-6 text-sm text-foreground-muted">
          {m("Connect an environment to inspect its plugins.")}
        </Text>
      ) : cwd === null ? (
        <Text className="px-4 py-6 text-sm text-foreground-muted">
          {m("Add a project to manage its plugins.")}
        </Text>
      ) : pending || inventory === null ? (
        <View className="items-center py-8">
          <AppActivityIndicator />
        </View>
      ) : (
        inventory.instances.map((instance) => {
          const shared = instancesSharingConfigHome(
            inventory,
            ProviderInstanceId.make(instance.instanceId),
          );
          const scanProblem = instanceScanProblem(
            inventory,
            ProviderInstanceId.make(instance.instanceId),
          );
          const entries = filterPluginEntries(instance.entries, query);
          return (
            <SettingsSection
              key={instance.instanceId}
              title={providerLabels.get(instance.instanceId) ?? instance.instanceId}
              footer={[
                instance.configHome ?? "",
                shared.length === 0 ? "" : `${gt("Also affects")}: ${shared.join(", ")}`,
              ]
                .filter(Boolean)
                .join("\n")}
            >
              {!instance.supported ? (
                <Text className="px-4 py-2 text-sm text-foreground-muted">
                  {m("This provider does not expose plugin management.")}
                </Text>
              ) : scanProblem !== undefined ? (
                <Text className="px-4 py-2 text-xs text-foreground-muted">
                  {m("Scan failed")}: {scanProblem}
                </Text>
              ) : entries.length === 0 ? (
                <EmptyState
                  title={m("No plugins")}
                  detail={m("Nothing is installed for this provider.")}
                />
              ) : (
                entries.map((entry) => {
                  const target = entry.state !== "enabled";
                  const components = [
                    entry.components?.skills === undefined
                      ? undefined
                      : `${entry.components.skills} skills`,
                    entry.components?.mcpServers === undefined
                      ? undefined
                      : `MCP: ${entry.components.mcpServers.join(", ")}`,
                  ].filter((value): value is string => value !== undefined);
                  return (
                    <View
                      key={`${entry.instanceId}:${entry.pluginId}:${entry.scope}`}
                      className="gap-1 border-b border-border/60 px-4 py-2"
                    >
                      <Text translate={false} className="text-sm font-t3-medium text-foreground">
                        {entry.name}
                      </Text>
                      <Text translate={false} className="text-xs text-foreground-muted">
                        {[entry.pluginId, entry.marketplace, entry.version, entry.scope]
                          .filter((value): value is string => Boolean(value))
                          .join(" · ")}
                      </Text>
                      {components.length === 0 ? null : (
                        <Text className="text-xs text-foreground-muted">
                          {components.join(" · ")}
                        </Text>
                      )}
                      {entry.notes.map((note) => (
                        <Text key={note} className="text-xs text-foreground-muted">
                          {note}
                        </Text>
                      ))}
                      {entry.actions.reason === undefined ? null : (
                        <Text translate={false} className="text-xs text-foreground-muted">
                          {entry.actions.reason}
                        </Text>
                      )}
                      <View className="mt-1 flex-row items-center gap-2">
                        <Text className="text-xs text-foreground-muted">{labels[entry.state]}</Text>
                        {entry.actions.canSetEnabled ? (
                          <Button
                            label={target ? gt("Enable") : gt("Disable")}
                            tone="secondary"
                            disabled={busy}
                            onPress={() =>
                              void mutate(serverEnvironment.setPluginEnabled, {
                                instanceId: ProviderInstanceId.make(entry.instanceId),
                                cwd: entry.cwd,
                                pluginId: entry.pluginId,
                                scope: entry.scope,
                                enabled: target,
                                expectedRevision: instance.revision,
                              })
                            }
                          />
                        ) : null}
                        {entry.actions.canUninstall ? (
                          <Button
                            label={gt("Uninstall")}
                            tone="secondary"
                            disabled={busy}
                            onPress={() => confirmUninstall(entry, instance.revision)}
                          />
                        ) : null}
                      </View>
                    </View>
                  );
                })
              )}
            </SettingsSection>
          );
        })
      )}
    </SettingsScreen>
  );
}
