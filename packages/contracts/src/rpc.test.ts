import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { AssetCreateUrlResult, AttachmentCreateUploadUrlResult } from "./assets.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

describe("WebSocket RPC contracts", () => {
  it("only accepts asset and upload URLs on their own server routes", () => {
    const decodeAsset = Schema.decodeUnknownExit(AssetCreateUrlResult);
    const decodeUpload = Schema.decodeUnknownExit(AttachmentCreateUploadUrlResult);
    const expiresAt = 10_000;

    expect(
      Exit.isSuccess(
        decodeAsset({ relativeUrl: "/api/assets/token.sig/my%20file.png", expiresAt }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decodeUpload({
          relativeUrl: "/api/attachments/upload/token.sig",
          expiresAt,
          attachmentId: "attachment",
        }),
      ),
    ).toBe(true);

    for (const relativeUrl of [
      "data:text/plain,hello",
      "file:///tmp/document",
      "https://other.example/document",
      "//other.example/document",
      "/api/assets/token/../../../other",
    ]) {
      expect(Exit.isFailure(decodeAsset({ relativeUrl, expiresAt }))).toBe(true);
      expect(
        Exit.isFailure(decodeUpload({ relativeUrl, expiresAt, attachmentId: "attachment" })),
      ).toBe(true);
    }
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });

  it("lists skill inventories without a mutation revision", () => {
    const list = WsRpcGroup.requests.get(WS_METHODS.skillsList);
    if (list === undefined) throw new Error("skills.list is not registered");
    const decodePayload = Schema.decodeUnknownExit(list.payloadSchema);
    const decodeSuccess = Schema.decodeUnknownExit(list.successSchema);

    expect(Exit.isSuccess(decodePayload({ cwd: "/repo", instanceId: "claude" }))).toBe(true);
    expect(
      Exit.isSuccess(
        decodeSuccess({
          checkedAt: "2026-11-17T00:00:00.000Z",
          revision: "revision-1",
          entries: [],
          diagnostics: ["Skill scan failed for provider instance 'claude'."],
        }),
      ),
    ).toBe(true);
  });

  it("registers plugin inventory and mutations behind a provider-native id", () => {
    const list = WsRpcGroup.requests.get(WS_METHODS.pluginsList);
    const setEnabled = WsRpcGroup.requests.get(WS_METHODS.pluginsSetEnabled);
    const uninstall = WsRpcGroup.requests.get(WS_METHODS.pluginsUninstall);
    if (!list || !setEnabled || !uninstall) {
      throw new Error("plugin RPCs are not registered");
    }
    const decodeList = Schema.decodeUnknownExit(list.payloadSchema);
    const decodeListSuccess = Schema.decodeUnknownExit(list.successSchema);
    const decodeSetEnabled = Schema.decodeUnknownExit(setEnabled.payloadSchema);
    const decodeUninstall = Schema.decodeUnknownExit(uninstall.payloadSchema);
    const decodeMutation = Schema.decodeUnknownExit(setEnabled.successSchema);
    const base = {
      instanceId: "claude",
      cwd: "/repo",
      pluginId: "superpowers@claude-plugins-official",
      scope: "user",
      expectedRevision: "revision-1",
    };

    expect(Exit.isSuccess(decodeList({ cwd: "/repo" }))).toBe(true);
    expect(
      Exit.isSuccess(
        decodeListSuccess({
          checkedAt: "2026-11-19T00:00:00.000Z",
          instances: [
            { instanceId: "claude", supported: false, revision: "revision-1", entries: [] },
          ],
          diagnostics: [],
        }),
      ),
    ).toBe(true);
    expect(Exit.isSuccess(decodeSetEnabled({ ...base, enabled: false }))).toBe(true);
    expect(Exit.isSuccess(decodeUninstall(base))).toBe(true);
    expect(Exit.isSuccess(decodeMutation({ requiresSessionRestart: true }))).toBe(true);
    for (const pluginId of ["-rf", "a b", ""]) {
      expect(Exit.isFailure(decodeSetEnabled({ ...base, pluginId, enabled: true }))).toBe(true);
    }
  });

  it("registers skill mutations with optimistic revisions and restart results", () => {
    const base = {
      instanceId: "claude",
      cwd: "/repo",
      nativeId: "user:review",
      expectedRevision: "revision-1",
    };
    const install = WsRpcGroup.requests.get(WS_METHODS.skillsInstall);
    const setEnabled = WsRpcGroup.requests.get(WS_METHODS.skillsSetEnabled);
    const uninstall = WsRpcGroup.requests.get(WS_METHODS.skillsUninstall);
    const sync = WsRpcGroup.requests.get(WS_METHODS.skillsSync);
    if (!install || !setEnabled || !uninstall || !sync) {
      throw new Error("skill mutation RPCs are not registered");
    }

    const decodeInstall = Schema.decodeUnknownExit(install.payloadSchema);
    const decodeInstallValid = Schema.decodeExit(install.payloadSchema);
    const decodeSetEnabled = Schema.decodeExit(setEnabled.payloadSchema);
    const decodeUninstall = Schema.decodeExit(uninstall.payloadSchema);
    const decodeSync = Schema.decodeExit(sync.payloadSchema);
    const decodeMutationResults = [install, setEnabled, uninstall].map((rpc) =>
      Schema.decodeExit(rpc.successSchema),
    );
    const decodeSyncResult = Schema.decodeExit(sync.successSchema);

    expect(Exit.isSuccess(decodeInstallValid({ ...base, sourceFolder: "/source/review" }))).toBe(
      true,
    );
    expect(Exit.isFailure(decodeInstall({ ...base, nativeId: "review", sourceFolder: "/s" }))).toBe(
      true,
    );
    expect(Exit.isSuccess(decodeSetEnabled({ ...base, enabled: false }))).toBe(true);
    expect(Exit.isSuccess(decodeUninstall(base))).toBe(true);
    expect(
      Exit.isSuccess(
        decodeSync({
          sourceInstanceId: "claude-a",
          targetInstanceId: "claude-b",
          cwd: "/repo",
          mode: "link",
          nativeIds: ["review"],
          expectedRevision: "revision-1",
          onConflict: "backup",
        }),
      ),
    ).toBe(true);

    for (const decodeResult of decodeMutationResults) {
      expect(Exit.isSuccess(decodeResult({ requiresSessionRestart: true }))).toBe(true);
    }
    expect(
      Exit.isSuccess(
        decodeSyncResult({
          requiresSessionRestart: true,
          backups: [{ nativeId: "review", path: "/config/.t3-code/skill-sync-backups/review" }],
        }),
      ),
    ).toBe(true);
  });
});
