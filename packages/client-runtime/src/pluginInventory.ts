import type { PluginInventory, PluginInventoryEntry, ProviderInstanceId } from "@t3tools/contracts";

/** Other instances that write the same provider config directory. */
export function instancesSharingConfigHome(
  inventory: PluginInventory,
  instanceId: ProviderInstanceId,
): ReadonlyArray<ProviderInstanceId> {
  const target = inventory.instances.find((instance) => instance.instanceId === instanceId);
  if (target?.configHome === undefined) return [];
  return inventory.instances
    .filter(
      (instance) => instance.instanceId !== instanceId && instance.configHome === target.configHome,
    )
    .map((instance) => instance.instanceId as ProviderInstanceId);
}

/** The diagnostic line for one instance, if its scan failed. */
export function instanceScanProblem(
  inventory: PluginInventory,
  instanceId: ProviderInstanceId,
): string | undefined {
  return inventory.diagnostics.find((line) => line.includes(`'${instanceId}'`));
}

export function filterPluginEntries(
  entries: ReadonlyArray<PluginInventoryEntry>,
  query: string,
): ReadonlyArray<PluginInventoryEntry> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return entries;
  return entries.filter((entry) =>
    [entry.name, entry.pluginId, entry.marketplace].some((value) =>
      value?.toLowerCase().includes(needle),
    ),
  );
}
