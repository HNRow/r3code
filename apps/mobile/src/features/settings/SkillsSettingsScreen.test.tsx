import { RegistryProvider } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  type SkillInventory,
  type SkillInventoryEntry,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface PendingRequest {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly resolve: (inventory: SkillInventory) => void;
  readonly promise: Promise<unknown>;
}

const state = vi.hoisted(() => ({
  requests: [] as PendingRequest[],
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((
    _registry: unknown,
    _command: unknown,
    target: { readonly environmentId: EnvironmentId; readonly input: { readonly cwd: string } },
  ) => {
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
vi.mock("gt-react-native", () => ({
  msg: (message: string) => message,
  useGT: () => (message: string) => message,
  useMessages: () => (message: string) => message,
}));
vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  View: ({ children }: { children?: ReactNode }) => children,
  TextInput: () => null,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: ({
    title,
    detail,
    actionLabel,
    onAction,
  }: {
    title: string;
    detail: string;
    actionLabel?: string;
    onAction?: () => void;
  }) => (
    <div>
      <span>{title}</span>
      <span>{detail}</span>
      {actionLabel ? <button onClick={onAction}>{actionLabel}</button> : null}
    </div>
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: ({
    label,
    description,
    detail,
  }: {
    label: string;
    description?: string;
    detail?: string;
  }) => (
    <div>
      <span>{label}</span>
      <span>{description}</span>
      <span>{detail}</span>
    </div>
  ),
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({
    actions,
    onPressAction,
  }: {
    actions: readonly { id: string; title: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) =>
    actions.map(({ id, title }) => (
      <button key={id} onClick={() => onPressAction({ nativeEvent: { event: id } })}>
        Select {title}
      </button>
    )),
}));
vi.mock("./components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => projects,
  useEnvironmentServerConfig: () => ({ providers: [] }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { skillInventory: {} },
}));
vi.mock("../../state/query", () => ({
  formatEnvironmentQueryError: () => "Request failed",
}));

import { SkillsSettingsScreen } from "./SkillsSettingsScreen";

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

async function settle(request: PendingRequest, value: SkillInventory) {
  await act(async () => {
    request.resolve(value);
    await request.promise;
  });
}

function clickButton(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  button.click();
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.requests = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("SkillsSettingsScreen inventory behavior", () => {
  it("keeps the newly selected project's inventory when the old response arrives last", async () => {
    await act(() =>
      root.render(
        <RegistryProvider>
          <SkillsSettingsScreen />
        </RegistryProvider>,
      ),
    );
    expect(state.requests).toHaveLength(1);
    await act(() => clickButton("Select Project B: /repo/b"));
    expect(state.requests.map((request) => request.cwd)).toEqual(["/repo/a", "/repo/b"]);

    await settle(state.requests[1]!, inventory("New skill", "/repo/b"));
    expect(container.textContent).toContain("New skill");
    await settle(state.requests[0]!, inventory("Old skill", "/repo/a"));
    expect(container.textContent).toContain("New skill");
    expect(container.textContent).not.toContain("Old skill");
  });

  it.each([
    {
      diagnostics: ["Skill scan failed for provider instance 'claude'."],
      title: "Skills unavailable",
      otherTitle: "No skills",
    },
    { diagnostics: [], title: "No skills", otherTitle: "Skills unavailable" },
  ])("distinguishes $title from other empty states", async ({ diagnostics, title, otherTitle }) => {
    await act(() =>
      root.render(
        <RegistryProvider>
          <SkillsSettingsScreen />
        </RegistryProvider>,
      ),
    );
    expect(state.requests).toHaveLength(1);
    await settle(state.requests[0]!, emptyInventory(diagnostics));

    expect(container.textContent).toContain(title);
    expect(container.textContent).not.toContain(otherTitle);
    if (diagnostics.length > 0) expect(container.textContent).toContain(diagnostics[0]);
  });
});
