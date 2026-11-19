import { describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { SkillInventory } from "@t3tools/contracts";
import { buildSkillInventory, filterSkillInventory } from "./skillInventory.ts";

const decodeSkillInventory = Schema.decodeUnknownSync(SkillInventory);

describe("skill inventory", () => {
  it("keeps disabled and shadowed entries while `$` filtering only shows enabled unique names", () => {
    const inventory = buildSkillInventory({
      instanceId: "claude_dp41sf",
      cwd: "/work/project",
      revision: "rev-1",
      entries: [
        {
          nativeId: "a",
          name: "review",
          state: "disabled",
          source: { kind: "file", scope: "user", path: "/home/u/skills/review" },
        },
        {
          nativeId: "b",
          name: "review",
          state: "shadowed",
          source: { kind: "file", scope: "project", path: "/work/project/.claude/skills/review" },
        },
        {
          nativeId: "c",
          name: "test",
          state: "enabled",
          source: { kind: "file", scope: "project", path: "/work/project/.claude/skills/test" },
        },
      ],
      diagnostics: [],
    });
    expect(inventory.entries).toHaveLength(3);
    expect(
      filterSkillInventory(inventory, { state: "enabled" }).map((entry) => entry.name),
    ).toEqual(["test"]);
  });

  it("builds a schema-valid inventory with read-only defaults and preserved entry data", () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-17T12:00:00.000Z") });
    try {
      const inventory = buildSkillInventory({
        instanceId: "claude_dp41sf",
        cwd: "/work/project",
        revision: "rev-2",
        entries: [
          {
            nativeId: "a",
            name: "review",
            description: "Reviews code",
            state: "disabled",
            source: { kind: "file", scope: "user", path: "/home/u/skills/review" },
          },
          {
            nativeId: "b",
            name: "test",
            state: "enabled",
            source: { kind: "plugin", scope: "managed", containerId: "plugin-1" },
            actions: { canSetEnabled: true, canUninstall: false, reason: "Managed by plugin" },
          },
        ],
        diagnostics: ["Skipped unreadable skill"],
      });

      expect(inventory).toEqual({
        checkedAt: "2026-11-17T12:00:00.000Z",
        revision: "rev-2",
        entries: [
          {
            instanceId: "claude_dp41sf",
            cwd: "/work/project",
            nativeId: "a",
            name: "review",
            description: "Reviews code",
            state: "disabled",
            source: { kind: "file", scope: "user", path: "/home/u/skills/review" },
            actions: { canSetEnabled: false, canUninstall: false },
          },
          {
            instanceId: "claude_dp41sf",
            cwd: "/work/project",
            nativeId: "b",
            name: "test",
            state: "enabled",
            source: { kind: "plugin", scope: "managed", containerId: "plugin-1" },
            actions: { canSetEnabled: true, canUninstall: false, reason: "Managed by plugin" },
          },
        ],
        diagnostics: ["Skipped unreadable skill"],
      });
      expect(decodeSkillInventory(inventory)).toEqual(inventory);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters by instance and cwd", () => {
    const inventory = buildSkillInventory({
      instanceId: "claude",
      cwd: "/work/project",
      revision: "rev-1",
      entries: [
        {
          nativeId: "a",
          name: "review",
          state: "enabled",
          source: { kind: "file", scope: "user" },
        },
        {
          nativeId: "b",
          name: "test",
          state: "disabled",
          source: { kind: "file", scope: "project" },
        },
        {
          nativeId: "c",
          name: "deploy",
          state: "enabled",
          source: { kind: "file", scope: "project" },
        },
      ],
      diagnostics: [],
    });
    const scopedInventory = {
      ...inventory,
      entries: inventory.entries.map((entry) =>
        entry.nativeId === "c" ? { ...entry, instanceId: "cursor", cwd: "/work/other" } : entry,
      ),
    };

    expect(
      filterSkillInventory(scopedInventory, { instanceId: "claude" }).map(
        (entry) => entry.nativeId,
      ),
    ).toEqual(["a", "b"]);
    expect(
      filterSkillInventory(scopedInventory, { cwd: "/work/project" }).map(
        (entry) => entry.nativeId,
      ),
    ).toEqual(["a", "b"]);
    expect(
      filterSkillInventory(scopedInventory, { instanceId: "cursor", cwd: "/work/other" }).map(
        (entry) => entry.nativeId,
      ),
    ).toEqual(["c"]);
    expect(
      filterSkillInventory(scopedInventory, { instanceId: "claude", cwd: "/work/other" }),
    ).toEqual([]);
  });

  it("matches query against name, description, and source path case-insensitively", () => {
    const inventory = buildSkillInventory({
      instanceId: "claude",
      cwd: "/work/project",
      revision: "rev-1",
      entries: [
        {
          nativeId: "a",
          name: "Review",
          state: "enabled",
          source: { kind: "file", scope: "user", path: "/skills/review" },
        },
        {
          nativeId: "b",
          name: "test",
          description: "Writes SUMMARY reports",
          state: "enabled",
          source: { kind: "file", scope: "project", path: "/skills/test" },
        },
        {
          nativeId: "c",
          name: "deploy",
          state: "enabled",
          source: { kind: "file", scope: "project", path: "/work/Skills/Release" },
        },
      ],
      diagnostics: [],
    });

    expect(
      filterSkillInventory(inventory, { query: "review" }).map((entry) => entry.nativeId),
    ).toEqual(["a"]);
    expect(
      filterSkillInventory(inventory, { query: "summary" }).map((entry) => entry.nativeId),
    ).toEqual(["b"]);
    expect(
      filterSkillInventory(inventory, { query: "skills/release" }).map((entry) => entry.nativeId),
    ).toEqual(["c"]);
    expect(filterSkillInventory(inventory, { query: "missing" })).toEqual([]);
  });

  it("deduplicates enabledOnly by name within each instance and cwd without mutating the inventory", () => {
    const inventory = buildSkillInventory({
      instanceId: "claude",
      cwd: "/work/project",
      revision: "rev-1",
      entries: [
        {
          nativeId: "a",
          name: "review",
          state: "enabled",
          source: { kind: "file", scope: "user" },
        },
        {
          nativeId: "b",
          name: "review",
          state: "enabled",
          source: { kind: "file", scope: "project" },
        },
        {
          nativeId: "c",
          name: "review",
          state: "enabled",
          source: { kind: "file", scope: "project" },
        },
        {
          nativeId: "d",
          name: "review",
          state: "enabled",
          source: { kind: "file", scope: "project" },
        },
        {
          nativeId: "e",
          name: "review",
          state: "disabled",
          source: { kind: "file", scope: "project" },
        },
        {
          nativeId: "f",
          name: "test",
          state: "shadowed",
          source: { kind: "file", scope: "project" },
        },
        {
          nativeId: "g",
          name: "test",
          state: "enabled",
          source: { kind: "file", scope: "project" },
        },
      ],
      diagnostics: [],
    });
    const scopedInventory = {
      ...inventory,
      entries: inventory.entries.map((entry) => {
        if (entry.nativeId === "c") return { ...entry, cwd: "/work/other" };
        if (entry.nativeId === "d") return { ...entry, instanceId: "cursor" };
        return entry;
      }),
    };

    expect(
      filterSkillInventory(scopedInventory, { state: "enabled" }).map((entry) => entry.nativeId),
    ).toEqual(["a", "b", "c", "d", "g"]);
    const filtered = filterSkillInventory(scopedInventory, { enabledOnly: true });
    expect(filtered.map((entry) => entry.nativeId)).toEqual(["a", "c", "d", "g"]);
    expect(filtered).not.toBe(scopedInventory.entries);
    expect(scopedInventory.entries.map((entry) => [entry.nativeId, entry.state])).toEqual([
      ["a", "enabled"],
      ["b", "enabled"],
      ["c", "enabled"],
      ["d", "enabled"],
      ["e", "disabled"],
      ["f", "shadowed"],
      ["g", "enabled"],
    ]);
  });
});
