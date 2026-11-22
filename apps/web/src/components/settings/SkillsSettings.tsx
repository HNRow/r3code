import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand, type AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { filterSkillInventory } from "@t3tools/client-runtime/skillInventory";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { ProviderInstanceId } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ServerProvider,
  SkillInstallInput,
  SkillInventory,
  SkillInventoryEntry,
  SkillMutationResult,
  SkillSetEnabledInput,
  SkillSyncInput,
  SkillSyncResult,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { msg, useGT, useMessages } from "gt-react";

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
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const SKILL_STATE_LABELS: Readonly<Record<SkillInventoryEntry["state"], string>> = {
  enabled: msg("Enabled"),
  disabled: msg("Disabled"),
  shadowed: msg("Shadowed"),
  unavailable: msg("Unavailable"),
};

interface SelectOption {
  readonly value: string;
  readonly label: string;
}

function FilterSelect(props: {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<SelectOption>;
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <SettingsRow
      title={props.label}
      control={
        <Select
          value={props.value}
          disabled={props.disabled}
          onValueChange={(value) => {
            if (value !== null) props.onChange(value);
          }}
        >
          <div className="grid w-full min-w-0 sm:w-64">
            <SelectTrigger size="sm" aria-label={props.label}>
              <SelectValue placeholder={props.placeholder} />
            </SelectTrigger>
          </div>
          <SelectPopup>
            {props.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function InventoryEmpty(props: {
  readonly title: string;
  readonly description: string;
  readonly retryLabel?: string;
  readonly onRetry?: () => void;
}) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.onRetry ? (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={props.onRetry}>
            {props.retryLabel}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

interface InventoryRequest {
  readonly targetKey: string;
  readonly inventory: SkillInventory | null;
  readonly error: string | null;
}

type SyncMode = SkillSyncInput["mode"];
type ConflictMode = NonNullable<SkillSyncInput["onConflict"]>;

interface SkillDialogTarget {
  readonly targetKey: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly revision: string;
}

type UninstallDialogRequest = SkillDialogTarget & {
  readonly entry: SkillInventoryEntry;
};

type SyncDialogRequest = UninstallDialogRequest & {
  readonly mode: SyncMode;
};

function InstallSkillDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly cwd: string;
  readonly expectedRevision: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerLabels: ReadonlyMap<string, string>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onInstall: (input: SkillInstallInput) => Promise<boolean>;
}) {
  const gt = useGT();
  const [instanceId, setInstanceId] = useState(props.providers[0]!.instanceId);
  const [scope, setScope] = useState<"user" | "project">("user");
  const [name, setName] = useState("");
  const [sourceFolder, setSourceFolder] = useState("");
  const input: SkillInstallInput = {
    instanceId,
    cwd: props.cwd,
    nativeId: `${scope}:${name.trim() || "skill"}`,
    sourceFolder: sourceFolder.trim() || "/",
    expectedRevision: props.expectedRevision,
  };
  const permitted = useAtomValue(
    serverEnvironment.installSkill.permissionAtom(props.environmentId, input),
  );
  const valid =
    instanceId.length > 0 && /^[a-zA-Z0-9_-]+$/.test(name.trim()) && sourceFolder.trim().length > 0;
  const install = async () => {
    if (!valid || !permitted || props.busy) return;
    if (await props.onInstall(input)) props.onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{gt("Install a skill")}</DialogTitle>
          <DialogDescription>
            {gt(
              "The source folder is read from the selected environment. The destination is derived from the name and scope, not an absolute target path.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="skill-install-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void install();
            }}
          >
            <div className="grid gap-1.5">
              <Label>{gt("Provider instance")}</Label>
              <Select
                value={instanceId}
                onValueChange={(value) => {
                  if (value !== null) setInstanceId(value);
                }}
              >
                <SelectTrigger aria-label={gt("Provider instance")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {props.providers.map((provider) => (
                    <SelectItem key={provider.instanceId} value={provider.instanceId}>
                      {props.providerLabels.get(provider.instanceId) ?? provider.instanceId}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>{gt("Scope")}</Label>
              <Select
                value={scope}
                onValueChange={(value) => {
                  if (value === "user" || value === "project") setScope(value);
                }}
              >
                <SelectTrigger aria-label={gt("Scope")}>
                  <SelectValue>
                    {(value: string) => (value === "project" ? gt("Project") : gt("User"))}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="user">{gt("User")}</SelectItem>
                  <SelectItem value="project">{gt("Project")}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="skill-install-name">{gt("Skill name")}</Label>
              <Input
                id="skill-install-name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder={gt("my-skill")}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="skill-install-source">
                {gt("Source folder on")} {props.environmentLabel}
              </Label>
              <Input
                id="skill-install-source"
                value={sourceFolder}
                onChange={(event) => setSourceFolder(event.currentTarget.value)}
                placeholder={gt("/path/to/skill-folder")}
              />
              <p className="text-xs text-muted-foreground">
                {gt("This directory must contain SKILL.md on the selected environment.")}
              </p>
            </div>
            {props.error ? (
              <p role="alert" className="text-sm text-destructive">
                {props.error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
            {gt("Cancel")}
          </Button>
          <Button
            type="submit"
            form="skill-install-form"
            disabled={!valid || !permitted || props.busy}
          >
            {props.busy ? gt("Installing…") : gt("Install")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SyncSkillDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SkillInventoryEntry;
  readonly mode: SyncMode;
  readonly expectedRevision: string;
  readonly targets: ReadonlyArray<ServerProvider>;
  readonly providerLabels: ReadonlyMap<string, string>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onSync: (input: SkillSyncInput) => Promise<boolean>;
}) {
  const gt = useGT();
  const [targetInstanceId, setTargetInstanceId] = useState(props.targets[0]!.instanceId);
  const [onConflict, setOnConflict] = useState<ConflictMode>("cancel");
  const input: SkillSyncInput = {
    sourceInstanceId: ProviderInstanceId.make(props.entry.instanceId),
    targetInstanceId,
    cwd: props.entry.cwd,
    mode: props.mode,
    nativeIds: [props.entry.nativeId.slice("user:".length)],
    expectedRevision: props.expectedRevision,
    onConflict,
  };
  const permitted = useAtomValue(
    serverEnvironment.syncSkills.permissionAtom(props.environmentId, input),
  );
  const sync = async () => {
    if (!permitted || props.busy) return;
    if (await props.onSync(input)) props.onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {props.mode === "link" ? gt("Link") : gt("Copy")} {props.entry.name}{" "}
            {gt("to another Claude instance")}
          </DialogTitle>
          <DialogDescription>
            {props.mode === "link"
              ? gt("Link the user-level skill without modifying its source directory.")
              : gt("Copy the user-level skill directory to another Claude instance.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>{gt("Destination Claude instance")}</Label>
              <Select
                value={targetInstanceId}
                onValueChange={(value) => {
                  if (value !== null) setTargetInstanceId(value);
                }}
              >
                <SelectTrigger aria-label={gt("Destination Claude instance")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {props.targets.map((provider) => (
                    <SelectItem key={provider.instanceId} value={provider.instanceId}>
                      {props.providerLabels.get(provider.instanceId) ?? provider.instanceId}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>{gt("If the destination exists")}</Label>
              <Select
                value={onConflict}
                onValueChange={(value) => {
                  if (value === "cancel" || value === "backup") setOnConflict(value);
                }}
              >
                <SelectTrigger aria-label={gt("If the destination exists")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="cancel">{gt("Cancel without changing anything")}</SelectItem>
                  <SelectItem value="backup">{gt("Back up and continue")}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
            {onConflict === "backup" ? (
              <p className="text-sm text-muted-foreground">
                {gt(
                  "Choosing Back up and continue confirms that the existing destination will be moved to an R3 backup before this operation.",
                )}
              </p>
            ) : null}
            {props.error ? (
              <p role="alert" className="text-sm text-destructive">
                {props.error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
            {gt("Cancel")}
          </Button>
          <Button disabled={!permitted || props.busy} onClick={() => void sync()}>
            {props.mode === "link" ? gt("Link skill") : gt("Copy skill")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SkillRow(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SkillInventoryEntry;
  readonly expectedRevision: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerLabels: ReadonlyMap<string, string>;
  readonly busy: boolean;
  readonly onSetEnabled: (entry: SkillInventoryEntry, enabled: boolean) => void;
  readonly onUninstall: (entry: SkillInventoryEntry) => void;
  readonly onSync: (entry: SkillInventoryEntry, mode: SyncMode) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { entry } = props;
  const enabled = entry.state !== "enabled";
  const hasMutationNativeId = /^(user|project):[a-zA-Z0-9_-]+$/.test(entry.nativeId);
  const setEnabledInput: SkillSetEnabledInput = {
    instanceId: ProviderInstanceId.make(entry.instanceId),
    cwd: entry.cwd,
    nativeId: entry.nativeId,
    enabled,
    expectedRevision: props.expectedRevision,
  };
  const canSetEnabled = useAtomValue(
    serverEnvironment.setSkillEnabled.permissionAtom(
      props.environmentId,
      entry.actions.canSetEnabled && hasMutationNativeId ? setEnabledInput : undefined,
    ),
  );
  const canUninstall = useAtomValue(
    serverEnvironment.uninstallSkill.permissionAtom(
      props.environmentId,
      entry.actions.canUninstall && hasMutationNativeId
        ? {
            instanceId: ProviderInstanceId.make(entry.instanceId),
            cwd: entry.cwd,
            nativeId: entry.nativeId,
            expectedRevision: props.expectedRevision,
          }
        : undefined,
    ),
  );
  const sourceProvider = props.providers.find(
    (provider) => provider.instanceId === entry.instanceId,
  );
  const targets = props.providers.filter(
    (provider) =>
      provider.enabled &&
      provider.driver === "claudeAgent" &&
      provider.instanceId !== entry.instanceId,
  );
  const syncInput: SkillSyncInput = {
    sourceInstanceId: ProviderInstanceId.make(entry.instanceId),
    targetInstanceId: targets[0]?.instanceId ?? ProviderInstanceId.make(entry.instanceId),
    cwd: entry.cwd,
    mode: "copy",
    nativeIds: [entry.nativeId.startsWith("user:") ? entry.nativeId.slice(5) : "skill"],
    expectedRevision: props.expectedRevision,
    onConflict: "cancel",
  };
  const canSyncSource =
    entry.actions.canSetEnabled &&
    sourceProvider?.enabled === true &&
    sourceProvider.driver === "claudeAgent" &&
    entry.nativeId.startsWith("user:") &&
    entry.source.kind === "file" &&
    entry.source.scope === "user" &&
    entry.source.path !== undefined &&
    !entry.source.path.startsWith("acp://") &&
    (entry.state === "enabled" || entry.state === "disabled");
  const syncPermitted = useAtomValue(
    serverEnvironment.syncSkills.permissionAtom(
      props.environmentId,
      canSyncSource && targets.length > 0 ? syncInput : undefined,
    ),
  );
  const showSync = canSyncSource && targets.length > 0;

  return (
    <SettingsRow
      title={entry.name}
      description={
        <span className="block space-y-1">
          {entry.description ? <span className="block">{entry.description}</span> : null}
          <span className="block">
            {gt("Provider")}: {props.providerLabels.get(entry.instanceId) ?? entry.instanceId}
          </span>
          <span className="block">
            {gt("Source")}: {entry.source.kind} / {entry.source.scope}
          </span>
          {entry.source.path ? <span className="block break-all">{entry.source.path}</span> : null}
          {entry.actions.reason ? <span className="block">{entry.actions.reason}</span> : null}
          {entry.source.kind === "plugin" ? (
            <Link to="/settings/plugins" className="block underline">
              {m("Manage in Plugins")}
            </Link>
          ) : null}
        </span>
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Badge variant="outline">{m(SKILL_STATE_LABELS[entry.state])}</Badge>
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
          {showSync ? (
            <>
              <Button
                variant="outline"
                size="xs"
                disabled={!syncPermitted || props.busy}
                onClick={() => props.onSync(entry, "copy")}
              >
                {gt("Copy")}
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={!syncPermitted || props.busy}
                onClick={() => props.onSync(entry, "link")}
              >
                {gt("Link")}
              </Button>
            </>
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

export function SkillsSettings() {
  const gt = useGT();
  const m = useMessages();
  const searchableSetting = useSearchableSetting();
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
  const [providerChoice, setProviderChoice] = useState("");
  const [stateChoice, setStateChoice] = useState("");
  const [query, setQuery] = useState("");
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [request, setRequest] = useState<InventoryRequest>({
    targetKey: "",
    inventory: null,
    error: null,
  });
  const [installOpen, setInstallOpen] = useState(false);
  const [uninstallRequest, setUninstallRequest] = useState<UninstallDialogRequest | null>(null);
  const [syncRequest, setSyncRequest] = useState<SyncDialogRequest | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const mutationBusyRef = useRef(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationNotice, setMutationNotice] = useState<{
    readonly backups: SkillSyncResult["backups"];
  } | null>(null);

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
  const installProviders = providers.filter(
    (provider) => provider.enabled && provider.driver === "claudeAgent",
  );
  const isCurrentMutationTarget = useEffectEvent(
    (mutationTargetKey: string) => targetKey === mutationTargetKey,
  );
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

  const currentDialogTarget: SkillDialogTarget | null =
    environmentId === null || cwd === null || targetKey === null || inventory === null
      ? null
      : { targetKey, environmentId, cwd, revision: inventory.revision };
  const isCurrentDialogTarget = (target: SkillDialogTarget) =>
    currentDialogTarget?.targetKey === target.targetKey &&
    currentDialogTarget.environmentId === target.environmentId &&
    currentDialogTarget.cwd === target.cwd &&
    currentDialogTarget.revision === target.revision;

  const commandOptions = { reportFailure: false, reportDefect: false } as const;
  const beginMutation = () => {
    if (mutationBusyRef.current) return false;
    mutationBusyRef.current = true;
    setMutationBusy(true);
    setMutationError(null);
    setMutationNotice(null);
    return true;
  };
  const finishMutation = <E,>(
    result: AtomCommandResult<SkillMutationResult | SkillSyncResult, E>,
    mutationTargetKey: string,
  ): boolean => {
    mutationBusyRef.current = false;
    setMutationBusy(false);
    if (!isCurrentMutationTarget(mutationTargetKey)) return false;
    if (result._tag === "Failure") {
      setMutationError(formatEnvironmentQueryError(result.cause));
      return false;
    }
    setMutationNotice({
      backups: "backups" in result.value ? result.value.backups : [],
    });
    refresh();
    return true;
  };
  const install = async (input: SkillInstallInput) => {
    const mutationTargetKey = targetKey;
    if (environmentId === null || mutationTargetKey === null || !beginMutation()) return false;
    return finishMutation(
      await runAtomCommand(
        registry,
        serverEnvironment.installSkill,
        { environmentId, input },
        commandOptions,
      ),
      mutationTargetKey,
    );
  };
  const setEnabled = async (entry: SkillInventoryEntry, enabled: boolean) => {
    const mutationTargetKey = targetKey;
    if (
      environmentId === null ||
      inventory === null ||
      mutationTargetKey === null ||
      !beginMutation()
    )
      return;
    const input: SkillSetEnabledInput = {
      instanceId: ProviderInstanceId.make(entry.instanceId),
      cwd: entry.cwd,
      nativeId: entry.nativeId,
      enabled,
      expectedRevision: inventory.revision,
    };
    finishMutation(
      await runAtomCommand(
        registry,
        serverEnvironment.setSkillEnabled,
        { environmentId, input },
        commandOptions,
      ),
      mutationTargetKey,
    );
  };
  const uninstall = async () => {
    const request = uninstallRequest;
    if (request === null || !isCurrentDialogTarget(request) || !beginMutation()) return;
    const succeeded = finishMutation(
      await runAtomCommand(
        registry,
        serverEnvironment.uninstallSkill,
        {
          environmentId: request.environmentId,
          input: {
            instanceId: ProviderInstanceId.make(request.entry.instanceId),
            cwd: request.cwd,
            nativeId: request.entry.nativeId,
            expectedRevision: request.revision,
          },
        },
        commandOptions,
      ),
      request.targetKey,
    );
    if (succeeded) setUninstallRequest(null);
  };
  const sync = async (request: SyncDialogRequest, input: SkillSyncInput) => {
    if (!isCurrentDialogTarget(request) || !beginMutation()) return false;
    return finishMutation(
      await runAtomCommand(
        registry,
        serverEnvironment.syncSkills,
        { environmentId: request.environmentId, input },
        commandOptions,
      ),
      request.targetKey,
    );
  };

  const activeUninstallRequest =
    uninstallRequest !== null && isCurrentDialogTarget(uninstallRequest) ? uninstallRequest : null;
  const activeSyncRequest =
    syncRequest !== null && isCurrentDialogTarget(syncRequest) ? syncRequest : null;

  return (
    <SettingsPageContainer>
      <SettingsSection
        id={searchableSetting("skills").id}
        title={gt("Skills")}
        headerAction={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              disabled={inventory === null || installProviders.length === 0 || mutationBusy}
              onClick={() => {
                setMutationError(null);
                setInstallOpen(true);
              }}
            >
              {gt("Install")}
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={targetKey === null || pending || mutationBusy}
              onClick={refresh}
            >
              <RefreshCwIcon />
              {gt("Refresh")}
            </Button>
          </div>
        }
      >
        <FilterSelect
          label={gt("Environment")}
          value={environment?.environmentId ?? ""}
          options={connectedEnvironments.map((entry) => ({
            value: entry.environmentId,
            label: entry.label,
          }))}
          placeholder={gt("No connected environment")}
          disabled={connectedEnvironments.length === 0}
          onChange={setEnvironmentChoice}
        />
        <FilterSelect
          label={gt("Project")}
          value={project?.id ?? ""}
          options={projects.map((entry) => ({
            value: entry.id,
            label: `${entry.title}: ${entry.workspaceRoot}`,
          }))}
          placeholder={gt("No projects")}
          disabled={environmentId === null || projects.length === 0}
          onChange={setProjectChoice}
        />
        <FilterSelect
          label={gt("Provider")}
          value={providerFilter}
          options={[
            { value: "", label: gt("All providers") },
            ...providers.map((provider) => ({
              value: provider.instanceId as string,
              label: providerLabels.get(provider.instanceId) ?? provider.instanceId,
            })),
          ]}
          placeholder={gt("All providers")}
          disabled={environmentId === null}
          onChange={setProviderChoice}
        />
        <FilterSelect
          label={gt("State")}
          value={stateChoice}
          options={[
            { value: "", label: gt("All states") },
            ...Object.entries(SKILL_STATE_LABELS).map(([value, label]) => ({
              value,
              label: m(label),
            })),
          ]}
          placeholder={gt("All states")}
          onChange={setStateChoice}
        />
        <SettingsRow
          title={gt("Search")}
          control={
            <div className="grid w-full min-w-0 sm:w-64">
              <Input
                aria-label={gt("Search skills")}
                placeholder={gt("Name, description, or path")}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
          }
        />
      </SettingsSection>

      {inventory && inventory.diagnostics.length > 0 ? (
        <SettingsSection title={gt("Scan issues")}>
          {Array.from(new Set(inventory.diagnostics)).map((diagnostic) => (
            <SettingsRow key={diagnostic} title={gt("Scan problem")} description={diagnostic} />
          ))}
        </SettingsSection>
      ) : null}

      {mutationNotice ? (
        <SettingsSection title={gt("Skill change saved")}>
          <SettingsRow
            title={gt("Restart required")}
            description={
              <span className="block space-y-1">
                <span className="block">{gt("Restart provider sessions to use this change.")}</span>
                {mutationNotice.backups.map((backup) => (
                  <span key={`${backup.nativeId}:${backup.path}`} className="block">
                    <span className="block">
                      {gt("Backup")}: {backup.nativeId}
                    </span>
                    <span className="block break-all">{backup.path}</span>
                  </span>
                ))}
              </span>
            }
          />
        </SettingsSection>
      ) : null}
      {mutationError &&
      !installOpen &&
      activeSyncRequest === null &&
      activeUninstallRequest === null ? (
        <SettingsSection title={gt("Skill mutation failed")}>
          <SettingsRow title={gt("Error")} description={mutationError} />
        </SettingsSection>
      ) : null}

      <SettingsSection title={gt("Inventory")}>
        {pending && inventory === null ? (
          <div role="status" className="px-4 py-8 text-center text-sm text-muted-foreground">
            {gt("Loading skills…")}
          </div>
        ) : error ? (
          <InventoryEmpty
            title={gt("Couldn't load skills")}
            description={error}
            retryLabel={gt("Try again")}
            onRetry={refresh}
          />
        ) : environmentId === null ? (
          <InventoryEmpty
            title={gt("No connected environment")}
            description={gt("Connect an environment to inspect its skills.")}
          />
        ) : project === null ? (
          <InventoryEmpty
            title={gt("No projects")}
            description={gt("Add a project to this environment to inspect its skills.")}
          />
        ) : inventory === null ? null : entries.length > 0 ? (
          entries.map((entry) => (
            <SkillRow
              key={`${entry.instanceId}:${entry.cwd}:${entry.nativeId}`}
              environmentId={environmentId!}
              entry={entry}
              expectedRevision={inventory.revision}
              providers={providers}
              providerLabels={providerLabels}
              busy={mutationBusy}
              onSetEnabled={(entry, enabled) => void setEnabled(entry, enabled)}
              onUninstall={(entry) => {
                if (currentDialogTarget === null) return;
                setMutationError(null);
                setUninstallRequest({ ...currentDialogTarget, entry });
              }}
              onSync={(entry, mode) => {
                if (currentDialogTarget === null) return;
                setMutationError(null);
                setSyncRequest({ ...currentDialogTarget, entry, mode });
              }}
            />
          ))
        ) : inventory.diagnostics.length > 0 && inventory.entries.length === 0 ? (
          <InventoryEmpty
            title={gt("Skills unavailable")}
            description={gt("The scan reported problems. Review the scan issues above.")}
          />
        ) : inventory.entries.length === 0 ? (
          <InventoryEmpty
            title={gt("No skills")}
            description={gt("No skills were found in this project.")}
          />
        ) : (
          <InventoryEmpty
            title={gt("No matching skills")}
            description={gt("Try a different provider, state, or search query.")}
          />
        )}
      </SettingsSection>

      {installOpen &&
      environmentId !== null &&
      environment !== null &&
      cwd !== null &&
      inventory &&
      installProviders.length > 0 ? (
        <InstallSkillDialog
          environmentId={environmentId}
          environmentLabel={environment.label}
          cwd={cwd}
          expectedRevision={inventory.revision}
          providers={installProviders}
          providerLabels={providerLabels}
          busy={mutationBusy}
          error={mutationError}
          onClose={() => setInstallOpen(false)}
          onInstall={install}
        />
      ) : null}
      {activeSyncRequest ? (
        <SyncSkillDialog
          environmentId={activeSyncRequest.environmentId}
          entry={activeSyncRequest.entry}
          mode={activeSyncRequest.mode}
          expectedRevision={activeSyncRequest.revision}
          targets={providers.filter(
            (provider) =>
              provider.enabled &&
              provider.driver === "claudeAgent" &&
              provider.instanceId !== activeSyncRequest.entry.instanceId,
          )}
          providerLabels={providerLabels}
          busy={mutationBusy}
          error={mutationError}
          onClose={() => setSyncRequest(null)}
          onSync={(input) => sync(activeSyncRequest, input)}
        />
      ) : null}
      <AlertDialog
        open={activeUninstallRequest !== null}
        onOpenChange={(open) => {
          if (!open && !mutationBusy) setUninstallRequest(null);
        }}
      >
        {activeUninstallRequest ? (
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {gt("Move")} {activeUninstallRequest.entry.name} {gt("to R3 quarantine?")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {gt(
                  "This moves the skill to R3 quarantine and removes it from active skills. It does not permanently delete the skill files.",
                )}
              </AlertDialogDescription>
              {mutationError ? (
                <p role="alert" className="text-sm text-destructive">
                  {mutationError}
                </p>
              ) : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                variant="outline"
                disabled={mutationBusy}
                onClick={() => setUninstallRequest(null)}
              >
                {gt("Cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={mutationBusy}
                onClick={() => void uninstall()}
              >
                {mutationBusy ? gt("Moving…") : gt("Move to quarantine")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        ) : null}
      </AlertDialog>
    </SettingsPageContainer>
  );
}
