import { RegistryProvider } from "@effect/atom-react";
import {
  clientRpcRequiredScopes,
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type SkillInventory,
  type SkillInventoryEntry,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { SkillsSettings } from "./SkillsSettings";

interface PendingRequest {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly resolve: (inventory: SkillInventory) => void;
  readonly promise: Promise<unknown>;
}

interface MutationCall {
  readonly commandId: string;
  readonly environmentId: EnvironmentId;
  readonly input: unknown;
}

const state = vi.hoisted(() => ({
  requests: [] as PendingRequest[],
  environments: [] as unknown[],
  projects: [] as unknown[],
  providers: [] as unknown[],
  mutationCalls: [] as MutationCall[],
  mutationResult: { _tag: "Success", value: { requiresSessionRestart: true } } as unknown,
  mutationExecutor: null as ((call: MutationCall) => Promise<unknown>) | null,
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((
    _registry: unknown,
    command: { readonly id: string },
    target: { readonly environmentId: EnvironmentId; readonly input: { readonly cwd: string } },
  ) => {
    if (command.id !== "skillInventory") {
      const call = {
        commandId: command.id,
        environmentId: target.environmentId,
        input: target.input,
      };
      state.mutationCalls.push(call);
      return state.mutationExecutor?.(call) ?? Promise.resolve(state.mutationResult);
    }
    let complete!: (value: unknown) => void;
    const promise = new Promise((resolve) => {
      complete = resolve;
    });
    state.requests.push({
      environmentId: target.environmentId,
      cwd: target.input.cwd,
      resolve: (inventory) => complete({ _tag: "Success", value: inventory }),
      promise,
    });
    return promise;
  }) as never,
}));
vi.mock(import("../../state/entities"), () => ({
  useProjects: (() => state.projects) as never,
  useServerConfigs: () => new Map(),
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironments: (() => ({ environments: state.environments })) as never,
  useEnvironmentProviders: (() => new Map([[environmentId, state.providers]])) as never,
  usePrimaryEnvironmentId: () => null,
  usePrimaryEnvironment: () => null,
}));
vi.mock(import("../../state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  const command = (id: string, method: string) => ({
    id,
    permissionAtom: (_environmentId: unknown, input: unknown) =>
      Atom.make(clientRpcRequiredScopes(method, input).includes("providers:manage")),
  });
  return {
    serverEnvironment: {
      skillInventory: command("skillInventory", WS_METHODS.skillsList),
      installSkill: command("install", WS_METHODS.skillsInstall),
      setSkillEnabled: command("setEnabled", WS_METHODS.skillsSetEnabled),
      uninstallSkill: command("uninstall", WS_METHODS.skillsUninstall),
      syncSkills: command("sync", WS_METHODS.skillsSync),
    } as never,
  };
});
vi.mock(import("../../hooks/useSettings"), () => ({
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE:
    "This setting is saved on a server, and the hosted app is not anchored to one. Change it from the desktop app or from the server's own address." as const,
  usePrimarySettingsAvailable: () => true,
}));
vi.mock(import("./SettingsScopeContext"), () => ({
  useOptionalSettingsScope: () => null,
}));
vi.mock(import("./SettingsScopeSentence"), () => ({
  SettingsScopeSentence: () => null,
}));
vi.mock(import("./SettingInheritance"), () => ({
  SettingInheritance: () => null,
}));
vi.mock(import("./useScopedSettings"), () => ({
  useClearScopedSettings: () => () => undefined,
  useClearProjectOverrides: () => () => undefined,
}));

const environmentId = EnvironmentId.make("environment");
const environments = [
  {
    environmentId,
    label: "Environment",
    connection: { phase: "connected" },
    serverConfig: {},
  },
];
const projects = [
  {
    id: ProjectId.make("project-a"),
    environmentId,
    title: "Project A",
    workspaceRoot: "/repo/a",
  },
  {
    id: ProjectId.make("project-b"),
    environmentId,
    title: "Project B",
    workspaceRoot: "/repo/b",
  },
];

const providers = [
  { instanceId: "claude-a", driver: "claudeAgent", displayName: "Claude A", enabled: true },
  { instanceId: "claude-b", driver: "claudeAgent", displayName: "Claude B", enabled: true },
];

function inventory(name: string, cwd: string): SkillInventory {
  const entry: SkillInventoryEntry = {
    instanceId: "claude",
    cwd,
    nativeId: name,
    name,
    description: `${name} description`,
    source: { kind: "file", scope: "project", path: `${cwd}/SKILL.md` },
    state: "enabled",
    actions: { canSetEnabled: false, canUninstall: false, reason: "Read-only source" },
  };
  return {
    checkedAt: "2026-11-17T00:00:00.000Z",
    revision: name,
    entries: [entry],
    diagnostics: [],
  };
}

function emptyInventory(diagnostics: readonly string[]): SkillInventory {
  return {
    checkedAt: "2026-11-17T00:00:00.000Z",
    revision: "empty",
    entries: [],
    diagnostics: [...diagnostics],
  };
}

function mutableInventory(): SkillInventory {
  return {
    checkedAt: "2026-11-17T00:00:00.000Z",
    revision: "revision-1",
    entries: [
      {
        instanceId: "claude-a",
        cwd: "/repo/a",
        nativeId: "user:review",
        name: "review",
        description: "Review changes",
        source: { kind: "file", scope: "user", path: "/claude-a/skills/review/SKILL.md" },
        state: "enabled",
        actions: { canSetEnabled: true, canUninstall: true },
      },
    ],
    diagnostics: [],
  };
}

function setup() {
  state.requests = [];
  state.environments = environments;
  state.projects = projects;
  state.providers = providers;
  state.mutationCalls = [];
  state.mutationResult = { _tag: "Success", value: { requiresSessionRestart: true } };
  state.mutationExecutor = null;
}

async function settle(request: PendingRequest, value: SkillInventory) {
  await act(async () => {
    request.resolve(value);
    await request.promise;
  });
}

describe("SkillsSettings inventory behavior", () => {
  it("keeps the newly selected project's inventory when the old response arrives last", async () => {
    setup();
    await using screen = await render(
      <RegistryProvider>
        <SkillsSettings />
      </RegistryProvider>,
    );
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await userEvent.click(screen.getByRole("combobox", { name: "Project" }));
    await userEvent.click(page.getByRole("option", { name: "Project B: /repo/b" }));
    await vi.waitFor(() => expect(state.requests).toHaveLength(2));
    expect(state.requests.map((request) => request.cwd)).toEqual(["/repo/a", "/repo/b"]);

    await settle(state.requests[1]!, inventory("New skill", "/repo/b"));
    await expect.element(screen.getByRole("heading", { name: "New skill" })).toBeVisible();
    const description = screen.getByText("New skill description");
    expect(
      description.element().closest('[data-slot="settings-row"]')?.querySelector("p p, p div"),
    ).toBeNull();

    await settle(state.requests[0]!, inventory("Old skill", "/repo/a"));
    await expect.element(screen.getByRole("heading", { name: "New skill" })).toBeVisible();
    await expect
      .element(screen.getByRole("heading", { name: "Old skill" }))
      .not.toBeInTheDocument();
  });

  it.each([
    {
      diagnostics: ["Skill scan failed for provider instance 'claude'."],
      title: "Skills unavailable",
      otherTitle: "No skills",
    },
    { diagnostics: [], title: "No skills", otherTitle: "Skills unavailable" },
  ])("distinguishes $title from other empty states", async ({ diagnostics, title, otherTitle }) => {
    setup();
    await using screen = await render(
      <RegistryProvider>
        <SkillsSettings />
      </RegistryProvider>,
    );
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await settle(state.requests[0]!, emptyInventory(diagnostics));

    await expect.element(screen.getByText(title, { exact: true })).toBeVisible();
    await expect.element(screen.getByText(otherTitle, { exact: true })).not.toBeInTheDocument();
    if (diagnostics.length > 0) {
      await expect.element(screen.getByText(diagnostics[0]!)).toBeVisible();
    }
  });
  it("renders read-only native ids without decoding them as mutation inputs", async () => {
    setup();
    const readOnlyEntry = (
      name: string,
      nativeId: string,
      source: SkillInventoryEntry["source"],
    ): SkillInventoryEntry => ({
      instanceId: "claude-a",
      cwd: "/repo/a",
      nativeId,
      name,
      source,
      state: "enabled",
      actions: { canSetEnabled: false, canUninstall: false, reason: "Read-only source" },
    });
    await using screen = await render(
      <RegistryProvider>
        <SkillsSettings />
      </RegistryProvider>,
    );
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await settle(state.requests[0]!, {
      checkedAt: "2026-11-17T00:00:00.000Z",
      revision: "read-only",
      entries: [
        readOnlyEntry("plugin-skill", "plugin:review", { kind: "plugin", scope: "managed" }),
        readOnlyEntry("managed-skill", "managed:review", { kind: "managed", scope: "managed" }),
        readOnlyEntry("acp-skill", "acp://skill/review", {
          kind: "agent",
          scope: "agent",
          path: "acp://skill/review",
        }),
        readOnlyEntry("absolute-skill", "/claude/skills/review/SKILL.md", {
          kind: "file",
          scope: "project",
          path: "/claude/skills/review/SKILL.md",
        }),
      ],
      diagnostics: [],
    });

    for (const name of ["plugin-skill", "managed-skill", "acp-skill", "absolute-skill"]) {
      await expect.element(screen.getByRole("heading", { name })).toBeVisible();
    }
    for (const name of ["Enable", "Disable", "Uninstall", "Copy", "Link"]) {
      await expect
        .element(screen.getByRole("button", { name, exact: true }))
        .not.toBeInTheDocument();
    }
  });
});

describe("SkillsSettings mutation behavior", () => {
  it("confirms quarantine before uninstalling, then reloads with a restart notice", async () => {
    setup();
    await using screen = await render(
      <RegistryProvider>
        <SkillsSettings />
      </RegistryProvider>,
    );
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await settle(state.requests[0]!, mutableInventory());

    await userEvent.click(screen.getByRole("button", { name: "Uninstall", exact: true }));
    await expect
      .element(screen.getByRole("heading", { name: "Move review to R3 quarantine?" }))
      .toBeVisible();
    await expect.element(screen.getByText(/does not permanently delete/)).toBeVisible();
    expect(state.mutationCalls).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Move to quarantine" }));
    await vi.waitFor(() => expect(state.mutationCalls).toHaveLength(1));
    expect(state.mutationCalls[0]).toEqual({
      commandId: "uninstall",
      environmentId,
      input: {
        instanceId: "claude-a",
        cwd: "/repo/a",
        nativeId: "user:review",
        expectedRevision: "revision-1",
      },
    });
    await expect
      .element(screen.getByText("Restart provider sessions to use this change."))
      .toBeVisible();
    await vi.waitFor(() => expect(state.requests).toHaveLength(2));
  });

  it("requires explicit backup confirmation and shows backup paths after linking", async () => {
    setup();
    state.mutationResult = {
      _tag: "Success",
      value: {
        requiresSessionRestart: true,
        backups: [{ nativeId: "review", path: "/claude-b/.t3-code/skill-sync-backups/review" }],
      },
    };
    await using screen = await render(
      <RegistryProvider>
        <SkillsSettings />
      </RegistryProvider>,
    );
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await settle(state.requests[0]!, mutableInventory());

    await userEvent.click(screen.getByRole("button", { name: "Link", exact: true }));
    await expect
      .element(screen.getByRole("heading", { name: "Link review to another Claude instance" }))
      .toBeVisible();
    await userEvent.click(screen.getByRole("combobox", { name: "If the destination exists" }));
    await userEvent.click(page.getByRole("option", { name: "Back up and continue" }));
    await expect.element(screen.getByText(/Choosing Back up and continue confirms/)).toBeVisible();
    expect(state.mutationCalls).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Link skill" }));
    await vi.waitFor(() => expect(state.mutationCalls).toHaveLength(1));
    expect(state.mutationCalls[0]).toEqual({
      commandId: "sync",
      environmentId,
      input: {
        sourceInstanceId: "claude-a",
        targetInstanceId: "claude-b",
        cwd: "/repo/a",
        mode: "link",
        nativeIds: ["review"],
        expectedRevision: "revision-1",
        onConflict: "backup",
      },
    });
    await expect
      .element(screen.getByText("/claude-b/.t3-code/skill-sync-backups/review"))
      .toBeVisible();
    await expect
      .element(screen.getByText("Restart provider sessions to use this change."))
      .toBeVisible();
    await vi.waitFor(() => expect(state.requests).toHaveLength(2));
  });

  it.each(["project", "environment"] as const)(
    "invalidates an open uninstall dialog after a $kind change",
    async (kind) => {
      setup();
      const otherEnvironmentId = EnvironmentId.make("environment-other");
      state.environments = [
        ...environments,
        {
          environmentId: otherEnvironmentId,
          label: "Other environment",
          connection: { phase: "connected" },
          serverConfig: {},
        },
      ];
      await using screen = await render(
        <RegistryProvider>
          <SkillsSettings />
        </RegistryProvider>,
      );
      await vi.waitFor(() => expect(state.requests).toHaveLength(1));
      await settle(state.requests[0]!, mutableInventory());
      await userEvent.click(screen.getByRole("button", { name: "Uninstall", exact: true }));
      await expect
        .element(screen.getByRole("heading", { name: "Move review to R3 quarantine?" }))
        .toBeVisible();

      await act(async () => {
        if (kind === "project") {
          state.projects = [projects[1]!];
        } else {
          state.environments = state.environments.filter(
            (environment) =>
              (environment as { environmentId: EnvironmentId }).environmentId ===
              otherEnvironmentId,
          );
          state.projects = projects.map((project) => ({
            ...project,
            environmentId: otherEnvironmentId,
          }));
        }
        await screen.rerender(
          <RegistryProvider>
            <SkillsSettings />
          </RegistryProvider>,
        );
      });

      await vi.waitFor(() => expect(state.requests).toHaveLength(2));
      await expect
        .element(screen.getByRole("heading", { name: "Move review to R3 quarantine?" }))
        .not.toBeInTheDocument();
      expect(state.mutationCalls).toHaveLength(0);
    },
  );

  it("prevents duplicate in-flight mutations and keeps the dialog after failure", async () => {
    setup();
    let resolveMutation!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveMutation = resolve;
    });
    state.mutationExecutor = () => pending;
    await using screen = await render(
      <RegistryProvider>
        <SkillsSettings />
      </RegistryProvider>,
    );
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await settle(state.requests[0]!, mutableInventory());
    await userEvent.click(screen.getByRole("button", { name: "Uninstall", exact: true }));
    const confirm = screen.getByRole("button", { name: "Move to quarantine" });

    await act(async () => {
      (confirm.element() as HTMLElement).click();
      (confirm.element() as HTMLElement).click();
    });
    expect(state.mutationCalls).toHaveLength(1);

    await act(async () => {
      resolveMutation({ _tag: "Failure", cause: Cause.fail("Injected mutation failure") });
      await pending;
    });
    await expect
      .element(screen.getByRole("heading", { name: "Move review to R3 quarantine?" }))
      .toBeVisible();
    await expect.element(screen.getByRole("alert")).toBeVisible();
  });
});

describe("SkillsSettings provider targets", () => {
  it("lists only enabled Claude instances in the install dropdown", async () => {
    setup();
    state.providers = [
      providers[0]!,
      { ...providers[1]!, enabled: false },
      { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true },
    ];
    await using screen = await render(
      <RegistryProvider>
        <SkillsSettings />
      </RegistryProvider>,
    );
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await settle(state.requests[0]!, emptyInventory([]));

    await userEvent.click(screen.getByRole("button", { name: "Install", exact: true }));
    await userEvent.click(screen.getByRole("combobox", { name: "Provider instance" }));

    await expect.element(page.getByRole("option", { name: "Claude A" })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "Claude B" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: "Codex" })).not.toBeInTheDocument();
  });

  it("disables Install when only non-Claude or disabled providers are available", async () => {
    setup();
    state.providers = [
      { ...providers[1]!, enabled: false },
      { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true },
    ];
    await using screen = await render(
      <RegistryProvider>
        <SkillsSettings />
      </RegistryProvider>,
    );
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await settle(state.requests[0]!, emptyInventory([]));

    await expect
      .element(screen.getByRole("button", { name: "Install", exact: true }))
      .toBeDisabled();
  });

  it("does not offer or submit a disabled sync target", async () => {
    setup();
    state.providers = [providers[0]!, { ...providers[1]!, enabled: false }];
    await using screen = await render(
      <RegistryProvider>
        <SkillsSettings />
      </RegistryProvider>,
    );
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await settle(state.requests[0]!, mutableInventory());

    await expect
      .element(screen.getByRole("button", { name: "Copy", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Link", exact: true }))
      .not.toBeInTheDocument();
    expect(state.mutationCalls).toHaveLength(0);
  });
});

describe("SkillsSettings mutation target races", () => {
  it.each(["Success", "Failure"] as const)(
    "ignores a stale %s after the project changes",
    async (outcome) => {
      setup();
      let resolveMutation!: (value: unknown) => void;
      const pending = new Promise((resolve) => {
        resolveMutation = resolve;
      });
      state.mutationExecutor = () => pending;
      await using screen = await render(
        <RegistryProvider>
          <SkillsSettings />
        </RegistryProvider>,
      );
      await vi.waitFor(() => expect(state.requests).toHaveLength(1));
      await settle(state.requests[0]!, mutableInventory());
      await userEvent.click(screen.getByRole("button", { name: "Disable", exact: true }));
      await vi.waitFor(() => expect(state.mutationCalls).toHaveLength(1));
      await userEvent.click(screen.getByRole("combobox", { name: "Project" }));
      await userEvent.click(page.getByRole("option", { name: "Project B: /repo/b" }));
      await vi.waitFor(() => expect(state.requests).toHaveLength(2));
      await settle(state.requests[1]!, inventory("New skill", "/repo/b"));

      await act(async () => {
        resolveMutation(
          outcome === "Success"
            ? { _tag: "Success", value: { requiresSessionRestart: true } }
            : { _tag: "Failure", cause: Cause.fail("Injected stale failure") },
        );
        await pending;
      });

      expect(state.requests).toHaveLength(2);
      await expect
        .element(screen.getByText("Restart provider sessions to use this change."))
        .not.toBeInTheDocument();
      await expect
        .element(screen.getByText("Skill mutation failed", { exact: true }))
        .not.toBeInTheDocument();
    },
  );
});

describe("SkillsSettings final review regressions", () => {
  it("does not offer or submit sync from a disabled source", async () => {
    setup();
    state.providers = [{ ...providers[0]!, enabled: false }, providers[1]!];
    await using screen = await render(
      <RegistryProvider>
        <SkillsSettings />
      </RegistryProvider>,
    );
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await settle(state.requests[0]!, mutableInventory());

    await expect
      .element(screen.getByRole("button", { name: "Copy", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Link", exact: true }))
      .not.toBeInTheDocument();
    expect(state.mutationCalls).toHaveLength(0);
  });

  it("disables Refresh during a mutation without dropping its success notice or refresh", async () => {
    setup();
    let resolveMutation!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveMutation = resolve;
    });
    state.mutationExecutor = () => pending;
    await using screen = await render(
      <RegistryProvider>
        <SkillsSettings />
      </RegistryProvider>,
    );
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await settle(state.requests[0]!, mutableInventory());
    await userEvent.click(screen.getByRole("button", { name: "Disable", exact: true }));
    await vi.waitFor(() => expect(state.mutationCalls).toHaveLength(1));

    await expect
      .element(screen.getByRole("button", { name: "Refresh", exact: true }))
      .toBeDisabled();

    await act(async () => {
      resolveMutation({ _tag: "Success", value: { requiresSessionRestart: true } });
      await pending;
    });
    await expect
      .element(screen.getByText("Restart provider sessions to use this change."))
      .toBeVisible();
    await vi.waitFor(() => expect(state.requests).toHaveLength(2));
  });
});
