import type { SkillInventory, SkillInventoryEntry } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type SkillInventoryEntryDraft = Omit<SkillInventoryEntry, "instanceId" | "cwd" | "actions"> & {
  actions?: SkillInventoryEntry["actions"];
};

interface BuildSkillInventoryInput {
  instanceId: string;
  cwd: string;
  revision: string;
  entries: readonly SkillInventoryEntryDraft[];
  diagnostics: readonly string[];
}

export function buildSkillInventory(input: BuildSkillInventoryInput): SkillInventory {
  return {
    checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    revision: input.revision,
    entries: input.entries.map((entry) => ({
      ...entry,
      instanceId: input.instanceId,
      cwd: input.cwd,
      actions: entry.actions ?? { canSetEnabled: false, canUninstall: false },
    })),
    diagnostics: [...input.diagnostics],
  };
}

interface FilterSkillInventoryOptions {
  state?: SkillInventoryEntry["state"];
  instanceId?: string;
  cwd?: string;
  query?: string;
  enabledOnly?: boolean;
}

export function filterSkillInventory(
  inventory: SkillInventory,
  options: FilterSkillInventoryOptions,
): SkillInventoryEntry[] {
  const query = options.query?.toLowerCase();
  const seenNames = new Set<string>();

  return inventory.entries.filter((entry) => {
    if (options.state !== undefined && entry.state !== options.state) return false;
    if (options.instanceId !== undefined && entry.instanceId !== options.instanceId) return false;
    if (options.cwd !== undefined && entry.cwd !== options.cwd) return false;
    if (
      query !== undefined &&
      ![entry.name, entry.description, entry.source.path].some((value) =>
        value?.toLowerCase().includes(query),
      )
    ) {
      return false;
    }
    if (!options.enabledOnly) return true;
    if (entry.state !== "enabled") return false;

    const key = JSON.stringify([entry.instanceId, entry.cwd, entry.name]);
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });
}
