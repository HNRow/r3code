import { describe, expect, it } from "vite-plus/test";
import type { PluginInventory, PluginInventoryEntry } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  filterPluginEntries,
  instanceScanProblem,
  instancesSharingConfigHome,
} from "./pluginInventory.ts";

const entry = (overrides: Partial<PluginInventoryEntry> = {}): PluginInventoryEntry => ({
  instanceId: "claude-a",
  cwd: "/repo",
  configHome: "/home/user/.claude",
  pluginId: "superpowers@claude-plugins-official",
  name: "superpowers",
  marketplace: "claude-plugins-official",
  scope: "user",
  state: "enabled",
  notes: [],
  actions: { canSetEnabled: true, canUninstall: true },
  ...overrides,
});

const inventory: PluginInventory = {
  checkedAt: "2026-11-19T00:00:00.000Z",
  diagnostics: [],
  instances: [
    {
      instanceId: "claude-a",
      supported: true,
      configHome: "/home/user/.claude",
      revision: "a",
      entries: [],
    },
    {
      instanceId: "claude-b",
      supported: true,
      configHome: "/home/user/.claude",
      revision: "b",
      entries: [],
    },
    {
      instanceId: "codex",
      supported: true,
      configHome: "/home/user/.codex",
      revision: "c",
      entries: [],
    },
    { instanceId: "opencode", supported: false, revision: "d", entries: [] },
  ],
};

describe("instancesSharingConfigHome", () => {
  it("lists the other instances on the same config directory", () => {
    expect(instancesSharingConfigHome(inventory, ProviderInstanceId.make("claude-a"))).toEqual([
      ProviderInstanceId.make("claude-b"),
    ]);
  });

  it("is empty without a shared directory", () => {
    expect(instancesSharingConfigHome(inventory, ProviderInstanceId.make("codex"))).toEqual([]);
    expect(instancesSharingConfigHome(inventory, ProviderInstanceId.make("opencode"))).toEqual([]);
  });
});

describe("instanceScanProblem", () => {
  it("finds the diagnostic line naming the instance", () => {
    const failed: PluginInventory = {
      ...inventory,
      diagnostics: ["Plugin scan failed for provider instance 'codex': boom"],
    };

    expect(instanceScanProblem(failed, ProviderInstanceId.make("codex"))).toContain("boom");
    expect(instanceScanProblem(failed, ProviderInstanceId.make("claude-a"))).toBeUndefined();
  });
});

describe("filterPluginEntries", () => {
  it("matches name, id and marketplace case-insensitively", () => {
    const entries = [
      entry(),
      entry({ pluginId: "other@market", name: "other", marketplace: "market" }),
    ];

    expect(filterPluginEntries(entries, "SUPER").map((item) => item.pluginId)).toEqual([
      "superpowers@claude-plugins-official",
    ]);
    expect(filterPluginEntries(entries, "market")[0]?.name).toBe("other");
    expect(filterPluginEntries(entries, "  ").length).toBe(2);
  });
});
