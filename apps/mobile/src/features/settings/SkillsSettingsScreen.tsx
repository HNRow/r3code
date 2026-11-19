import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { filterSkillInventory } from "@t3tools/client-runtime/skillInventory";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type { SkillInventory, SkillInventoryEntry } from "@t3tools/contracts";
import { useContext, useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useGT, useMessages } from "gt-react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { t } from "../../i18n/gt";

const SKILL_STATE_LABELS: Readonly<Record<SkillInventoryEntry["state"], string>> = {
  get enabled() {
    return t("Enabled");
  },
  get disabled() {
    return t("Disabled");
  },
  get shadowed() {
    return t("Shadowed");
  },
  get unavailable() {
    return t("Unavailable");
  },
};

interface FilterOption {
  readonly value: string;
  readonly label: string;
}

function FilterRow(props: {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<FilterOption>;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}) {
  const selectedLabel =
    props.options.find((option) => option.value === props.value)?.label ?? props.value;
  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${selectedLabel}`}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      className="active:opacity-70"
    >
      <ListRowLayout
        label={props.label}
        detail={selectedLabel}
        accessory={
          <SymbolView
            name="chevron.down"
            size={14}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        }
      />
    </Pressable>
  );
  if (props.disabled) return row;
  return (
    <Menu
      actions={props.options.map((option, index) => ({
        id: `${index}`,
        title: option.label,
        selected: option.value === props.value,
      }))}
      onPressAction={({ nativeEvent }) => {
        const option = props.options[Number(nativeEvent.event)];
        if (option) props.onChange(option.value);
      }}
    >
      {row}
    </Menu>
  );
}

interface InventoryRequest {
  readonly targetKey: string;
  readonly inventory: SkillInventory | null;
  readonly error: string | null;
}

export function SkillsSettingsScreen() {
  const gt = useGT();
  const m = useMessages();
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const allProjects = useProjects();
  const connectedEnvironments = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const [environmentChoice, setEnvironmentChoice] = useState("");
  const [projectChoice, setProjectChoice] = useState("");
  const [providerChoice, setProviderChoice] = useState("");
  const [stateChoice, setStateChoice] = useState("");
  const [query, setQuery] = useState("");
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [request, setRequest] = useState<InventoryRequest>({
    targetKey: "",
    inventory: null,
    error: null,
  });

  const environment =
    connectedEnvironments.find((entry) => entry.environmentId === environmentChoice) ??
    connectedEnvironments[0] ??
    null;
  const environmentId = environment?.environmentId ?? null;
  const serverConfig = useEnvironmentServerConfig(environmentId);
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
  const providers = serverConfig?.providers ?? [];
  const providerFilter = providers.some((provider) => provider.instanceId === providerChoice)
    ? providerChoice
    : "";
  const providerLabels: ReadonlyMap<string, string> = new Map(
    providers.map((provider) => [
      provider.instanceId,
      resolveProviderInstanceDisplayName(provider),
    ]),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the selected environment's read-only inventory and ignores stale replies
  useEffect(() => {
    let active = true;
    if (environmentId === null || cwd === null || targetKey === null) return;
    void runAtomCommand(
      registry,
      serverEnvironment.skillInventory,
      { environmentId, input: { cwd } },
      { reportFailure: false, reportDefect: false },
    ).then((result) => {
      if (!active) return;
      if (result._tag === "Success") {
        setRequest({ targetKey, inventory: result.value, error: null });
      } else {
        setRequest({
          targetKey,
          inventory: null,
          error: formatEnvironmentQueryError(result.cause),
        });
      }
    });
    return () => {
      active = false;
    };
  }, [registry, environmentId, cwd, targetKey]);

  const refresh = () => setRefreshIndex((value) => value + 1);
  const inventory = request.targetKey === targetKey ? request.inventory : null;
  const pending = targetKey !== null && request.targetKey !== targetKey;
  const error = request.targetKey === targetKey ? request.error : null;
  const entries = inventory
    ? filterSkillInventory(inventory, {
        ...(providerFilter ? { instanceId: providerFilter } : {}),
        ...(stateChoice ? { state: stateChoice as SkillInventoryEntry["state"] } : {}),
        ...(query.trim() ? { query: query.trim() } : {}),
      })
    : [];

  return (
    <SettingsScreen title={gt("Skills")}>
      <SettingsSection title={gt("Filters")}>
        <FilterRow
          label={gt("Environment")}
          value={environment?.environmentId ?? ""}
          options={connectedEnvironments.map((entry) => ({
            value: entry.environmentId,
            label: entry.label,
          }))}
          disabled={connectedEnvironments.length === 0}
          onChange={setEnvironmentChoice}
        />
        <FilterRow
          label={gt("Project")}
          value={project?.id ?? ""}
          options={projects.map((entry) => ({
            value: entry.id,
            label: `${entry.title}: ${entry.workspaceRoot}`,
          }))}
          disabled={environmentId === null || projects.length === 0}
          onChange={setProjectChoice}
        />
        <FilterRow
          label={gt("Provider")}
          value={providerFilter}
          options={[
            { value: "", label: gt("All providers") },
            ...providers.map((provider) => ({
              value: provider.instanceId as string,
              label: providerLabels.get(provider.instanceId) ?? provider.instanceId,
            })),
          ]}
          disabled={environmentId === null}
          onChange={setProviderChoice}
        />
        <FilterRow
          label={gt("State")}
          value={stateChoice}
          options={[
            { value: "", label: gt("All states") },
            ...Object.entries(SKILL_STATE_LABELS).map(([value, label]) => ({
              value,
              label: m(label),
            })),
          ]}
          onChange={setStateChoice}
        />
        <View className="gap-2 px-4 py-3">
          <Text textRole="body" className="text-foreground">
            {gt("Search")}
          </Text>
          <TextInput
            accessibilityLabel={gt("Search skills")}
            placeholder={gt("Name, description, or path")}
            placeholderTextColorClassName="accent-foreground-muted"
            value={query}
            onChangeText={setQuery}
            className="min-h-8 font-sans text-base text-foreground"
          />
        </View>
        <View className="px-4 pb-3">
          <Button
            label={gt("Refresh")}
            tone="secondary"
            size="compact"
            fullWidth
            disabled={targetKey === null || pending}
            onPress={refresh}
          />
        </View>
      </SettingsSection>

      {inventory && inventory.diagnostics.length > 0 ? (
        <SettingsSection title={gt("Scan issues")}>
          {Array.from(new Set(inventory.diagnostics)).map((diagnostic) => (
            <ListRowLayout
              key={diagnostic}
              icon="exclamationmark.triangle"
              label={gt("Scan problem")}
              description={diagnostic}
            />
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection title={gt("Inventory")}>
        {pending && inventory === null ? (
          <View className="items-center px-4 py-8">
            <AppActivityIndicator />
            <Text textRole="body" className="mt-3 text-foreground-muted">
              {gt("Loading skills…")}
            </Text>
          </View>
        ) : error ? (
          <EmptyState
            title={gt("Couldn't load skills")}
            detail={error}
            actionLabel={gt("Try again")}
            onAction={refresh}
            variant="plain"
          />
        ) : environmentId === null ? (
          <EmptyState
            title={gt("No connected environment")}
            detail={gt("Connect an environment to inspect its skills.")}
            variant="plain"
          />
        ) : project === null ? (
          <EmptyState
            title={gt("No projects")}
            detail={gt("Add a project to this environment to inspect its skills.")}
            variant="plain"
          />
        ) : inventory === null ? null : entries.length > 0 ? (
          entries.map((entry) => (
            <ListRowLayout
              key={`${entry.instanceId}:${entry.cwd}:${entry.nativeId}`}
              icon="brain"
              label={entry.name}
              description={[
                entry.description,
                `${gt("Provider")}: ${providerLabels.get(entry.instanceId) ?? entry.instanceId}`,
                `${gt("Source")}: ${entry.source.kind} / ${entry.source.scope}`,
                entry.source.path,
                entry.actions.reason,
              ]
                .filter(Boolean)
                .join("\n")}
              detail={m(SKILL_STATE_LABELS[entry.state])}
            />
          ))
        ) : inventory.diagnostics.length > 0 && inventory.entries.length === 0 ? (
          <EmptyState
            title={gt("Skills unavailable")}
            detail={gt("The scan reported problems. Review the scan issues above.")}
            variant="plain"
          />
        ) : inventory.entries.length === 0 ? (
          <EmptyState
            title={gt("No skills")}
            detail={gt("No skills were found in this project.")}
            variant="plain"
          />
        ) : (
          <EmptyState
            title={gt("No matching skills")}
            detail={gt("Try a different provider, state, or search query.")}
            variant="plain"
          />
        )}
      </SettingsSection>
    </SettingsScreen>
  );
}
