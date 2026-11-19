import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand, type AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  filterPluginEntries,
  instanceScanProblem,
  instancesSharingConfigHome,
} from "@t3tools/client-runtime/pluginInventory";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { ProviderInstanceId } from "@t3tools/contracts";
import type {
  EnvironmentId,
  PluginInventory,
  PluginInventoryEntry,
  PluginMutationResult,
  PluginSetEnabledInput,
  PluginUninstallInput,
} from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { useGT, useMessages } from "gt-react";

import { useProjects } from "../../state/entities";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const PLUGIN_STATE_LABELS = (gt: (text: string) => string) => ({
  enabled: gt("Enabled"),
  disabled: gt("Disabled"),
  unavailable: gt("Unavailable"),
});

interface PluginsRequest {
  readonly targetKey: string;
  readonly inventory: PluginInventory | null;
  readonly error: string | null;
}

function PluginRow(props: {
  readonly entry: PluginInventoryEntry;
  readonly environmentId: EnvironmentId;
  readonly revision: string;
  readonly busy: boolean;
  readonly providerLabels: ReadonlyMap<string, string>;
  readonly onSetEnabled: (entry: PluginInventoryEntry, enabled: boolean) => void;
  readonly onUninstall: (entry: PluginInventoryEntry) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { entry } = props;
  const enabled = entry.state !== "enabled";
  const setEnabledInput: PluginSetEnabledInput = {
    instanceId: ProviderInstanceId.make(entry.instanceId),
    cwd: entry.cwd,
    pluginId: entry.pluginId,
    scope: entry.scope,
    enabled,
    expectedRevision: props.revision,
  };
  const uninstallInput: PluginUninstallInput = {
    instanceId: setEnabledInput.instanceId,
    cwd: entry.cwd,
    pluginId: entry.pluginId,
    scope: entry.scope,
    expectedRevision: props.revision,
  };
  const canSetEnabled = useAtomValue(
    serverEnvironment.setPluginEnabled.permissionAtom(
      props.environmentId,
      entry.actions.canSetEnabled ? setEnabledInput : undefined,
    ),
  );
  const canUninstall = useAtomValue(
    serverEnvironment.uninstallPlugin.permissionAtom(
      props.environmentId,
      entry.actions.canUninstall ? uninstallInput : undefined,
    ),
  );
  const stateLabels = PLUGIN_STATE_LABELS(gt);
  const components = [
    entry.components?.skills === undefined ? undefined : `${entry.components.skills} skills`,
    entry.components?.mcpServers === undefined
      ? undefined
      : `MCP: ${entry.components.mcpServers.join(", ")}`,
  ].filter((value): value is string => value !== undefined);

  return (
    <SettingsRow
      title={entry.name}
      description={
        <span className="block space-y-1">
          <span className="block">
            {entry.pluginId}
            {entry.marketplace === undefined ? "" : ` · ${entry.marketplace}`}
            {entry.version === undefined ? "" : ` · ${entry.version}`}
            {` · ${entry.scope}`}
          </span>
          <span className="block">
            {gt("Provider")}: {props.providerLabels.get(entry.instanceId) ?? entry.instanceId}
          </span>
          {components.length === 0 ? null : <span className="block">{components.join(" · ")}</span>}
          {entry.notes.map((note) => (
            <span key={note} className="block">
              {note}
            </span>
          ))}
          {entry.actions.reason === undefined ? null : (
            <span className="block">{entry.actions.reason}</span>
          )}
        </span>
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Badge variant="outline">{m(stateLabels[entry.state])}</Badge>
          {entry.actions.canSetEnabled ? (
            <Button
              variant="outline"
              size="xs"
              disabled={!canSetEnabled || props.busy}
              onClick={() => props.onSetEnabled(entry, enabled)}
            >
              {enabled ? gt("Enable") : gt("Disable")}
            </Button>
          ) : null}
          {entry.actions.canUninstall ? (
            <Button
              variant="outline"
              size="xs"
              disabled={!canUninstall || props.busy}
              onClick={() => props.onUninstall(entry)}
            >
              {gt("Uninstall")}
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

export function PluginsSettings() {
  const gt = useGT();
  const m = useMessages();
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const allProjects = useProjects();
  const connectedEnvironments = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const [environmentChoice, setEnvironmentChoice] = useState("");
  const [projectChoice, setProjectChoice] = useState("");
  const [query, setQuery] = useState("");
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [request, setRequest] = useState<PluginsRequest>({
    targetKey: "",
    inventory: null,
    error: null,
  });
  const [uninstallRequest, setUninstallRequest] = useState<{
    readonly entry: PluginInventoryEntry;
    readonly revision: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  const environment =
    connectedEnvironments.find((entry) => entry.environmentId === environmentChoice) ??
    connectedEnvironments[0] ??
    null;
  const environmentId = environment?.environmentId ?? null;
  const projects = allProjects.filter(
    (project) =>
      project.environmentId === environmentId && project.archivedAt == null && !project.isScratch,
  );
  const project = projects.find((entry) => entry.id === projectChoice) ?? projects[0] ?? null;
  const cwd = project?.workspaceRoot ?? null;
  const targetKey =
    environmentId === null || cwd === null
      ? null
      : JSON.stringify([environmentId, cwd, refreshIndex]);
  const providers =
    (environmentId === null ? undefined : providersByEnvironment.get(environmentId)) ?? [];
  const providerLabels: ReadonlyMap<string, string> = new Map(
    providers.map((provider) => [
      provider.instanceId,
      resolveProviderInstanceDisplayName(provider),
    ]),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the selected environment's plugin inventory and ignores stale replies
  useEffect(() => {
    let active = true;
    if (environmentId === null || cwd === null || targetKey === null) return;
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
          : { targetKey, inventory: null, error: formatEnvironmentQueryError(result.cause) },
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
    if (environmentId === null || cwd === null) return;
    setBusy(true);
    setMutationError(null);
    const result: AtomCommandResult<PluginMutationResult, unknown> = await runAtomCommand(
      registry,
      command as typeof serverEnvironment.setPluginEnabled,
      { environmentId, input: input as PluginSetEnabledInput },
      { reportFailure: false, reportDefect: false },
    );
    setBusy(false);
    if (result._tag === "Failure") {
      setMutationError(formatEnvironmentQueryError(result.cause));
      // 冲突说明别人刚改过同一目录，直接重拉清单。
      refresh();
      return;
    }
    setRestartRequired(result.value.requiresSessionRestart);
    refresh();
  };

  const diagnostics = inventory?.diagnostics ?? [];

  return (
    <SettingsPageContainer>
      <SettingsSection
        title={m("Plugins")}
        headerAction={
          <Button variant="outline" size="sm" disabled={!inventory} onClick={refresh}>
            <RefreshCwIcon className="size-4" />
            {gt("Refresh")}
          </Button>
        }
      >
        <p className="px-3 text-xs text-muted-foreground">
          {m("Plugins installed on this environment's providers.")}
        </p>
        <SettingsRow
          title={gt("Environment")}
          control={
            <Select
              value={environment?.environmentId ?? null}
              onValueChange={(next) => {
                if (next !== null) {
                  setEnvironmentChoice(next);
                  setProjectChoice("");
                }
              }}
            >
              <SelectTrigger size="sm" className="w-auto max-w-72" aria-label={gt("Environment")}>
                <SelectValue>
                  {(value: EnvironmentId) =>
                    connectedEnvironments.find((entry) => entry.environmentId === value)?.label ??
                    value
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {connectedEnvironments.map((entry) => (
                  <SelectItem key={entry.environmentId} value={entry.environmentId}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title={gt("Project")}
          description={m("Project-scope installs are listed for this directory only.")}
          control={
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={project?.id ?? ""}
              onChange={(event) => setProjectChoice(event.target.value)}
            >
              {projects.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title={gt("Search")}
          control={
            <Input
              value={query}
              placeholder={m("Name, id, or marketplace")}
              onChange={(event) => setQuery(event.target.value)}
            />
          }
        />
        {error === null ? null : <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
        {restartRequired ? (
          <p className="px-3 py-2 text-xs">
            {m("Plugin changes apply to new agent sessions. Restart agent sessions to use them.")}
          </p>
        ) : null}
        {mutationError === null ? null : (
          <p className="px-3 py-2 text-xs text-destructive">{mutationError}</p>
        )}
      </SettingsSection>

      {connectedEnvironments.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">
          {m("Connect an environment to inspect its plugins.")}
        </p>
      ) : cwd === null ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">
          {m("Add a project to manage its plugins.")}
        </p>
      ) : pending || inventory === null ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">{m("Loading plugins…")}</p>
      ) : (
        <>
          {inventory.instances.map((instance) => {
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
              >
                {instance.configHome === undefined ? null : (
                  <p className="px-3 text-xs text-muted-foreground break-all">
                    {instance.configHome}
                  </p>
                )}
                {shared.length === 0 ? null : (
                  <p className="px-3 text-xs text-muted-foreground">
                    {`${gt("Also affects")}: ${shared
                      .map((id) => providerLabels.get(id) ?? id)
                      .join(", ")}`}
                  </p>
                )}
                {!instance.supported ? (
                  <SettingsRow
                    title={m("Not supported")}
                    description={m("This provider does not expose plugin management.")}
                    control={null}
                  />
                ) : scanProblem !== undefined ? (
                  <SettingsRow title={m("Scan failed")} description={scanProblem} control={null} />
                ) : entries.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>{m("No plugins")}</EmptyTitle>
                      <EmptyDescription>
                        {m("Nothing is installed for this provider.")}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  entries.map((entry) => (
                    <PluginRow
                      key={`${entry.instanceId}:${entry.pluginId}:${entry.scope}`}
                      entry={entry}
                      environmentId={environmentId!}
                      revision={instance.revision}
                      busy={busy}
                      providerLabels={providerLabels}
                      onSetEnabled={(target, enabled) =>
                        void mutate(serverEnvironment.setPluginEnabled, {
                          instanceId: ProviderInstanceId.make(target.instanceId),
                          cwd: target.cwd,
                          pluginId: target.pluginId,
                          scope: target.scope,
                          enabled,
                          expectedRevision: instance.revision,
                        })
                      }
                      onUninstall={(target) =>
                        setUninstallRequest({ entry: target, revision: instance.revision })
                      }
                    />
                  ))
                )}
              </SettingsSection>
            );
          })}
          {diagnostics.length === 0 ? null : (
            <SettingsSection title={m("Scan problems")}>
              {diagnostics.map((diagnostic) => (
                <SettingsRow key={diagnostic} title={diagnostic} control={null} />
              ))}
            </SettingsSection>
          )}
        </>
      )}

      <AlertDialog
        open={uninstallRequest !== null}
        onOpenChange={(open) => {
          if (!open) setUninstallRequest(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{m("Uninstall this plugin?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {m(
                "R3 Code cannot reinstall it. Reinstall from its CLI: `claude plugin install` or `codex plugin add`.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setUninstallRequest(null)}>
              {gt("Cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const request = uninstallRequest;
                setUninstallRequest(null);
                if (request === null) return;
                void mutate(serverEnvironment.uninstallPlugin, {
                  instanceId: ProviderInstanceId.make(request.entry.instanceId),
                  cwd: request.entry.cwd,
                  pluginId: request.entry.pluginId,
                  scope: request.entry.scope,
                  expectedRevision: request.revision,
                });
              }}
            >
              {gt("Uninstall")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
