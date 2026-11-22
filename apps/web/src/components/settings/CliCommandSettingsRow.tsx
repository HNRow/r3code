import { useState } from "react";

import {
  desktopCliCommandStateAtom,
  getDesktopCliCommandBridge,
  refreshDesktopCliCommandState,
} from "~/state/desktopCliCommand";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { T, t, useGT } from "gt-react";

const FAILURE_TITLES = {
  install: "Could not install t3",
  uninstall: "Could not remove t3",
  addToPath: "Could not add t3 to PATH",
} as const;

/** The desktop `t3` command's state, and its actions with a toast on failure. */
export function useDesktopCliCommand() {
  const gt = useGT();
  const bridge = getDesktopCliCommandBridge();
  const query = useEnvironmentQuery(bridge ? desktopCliCommandStateAtom : null);
  const [pending, setPending] = useState(false);

  const run = (action: keyof typeof FAILURE_TITLES) => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(refreshDesktopCliCommandState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              action === "install"
                ? gt("Could not install t3")
                : action === "uninstall"
                  ? gt("Could not remove t3")
                  : gt("Could not add t3 to PATH"),
            description: error instanceof Error ? error.message : gt("Something went wrong."),
          }),
        );
      })
      .finally(() => setPending(false));
  };

  return {
    state: bridge ? query.data : undefined,
    busy: pending || query.isPending,
    run,
  };
}

export function CliCommandSettingsRow() {
  const gt = useGT();
  const { state, busy, run } = useDesktopCliCommand();

  if (!state?.supported) return null;
  const installed = state.installedPath !== null;
  const description = state.shadowedBy
    ? gt("Another t3 at {path} runs first in a new terminal. Remove it to use R3 Code's.", {
        path: state.shadowedBy,
      })
    : !installed
      ? gt("Run R3 Code's CLI as `t3` from any terminal.")
      : state.onPath
        ? gt("Installed at {path}. Open a new terminal to use it.", { path: state.installedPath })
        : state.pathSetup?.added
          ? gt("Installed at {path} and added to PATH in {file}. Open a new terminal to use it.", {
              path: state.installedPath,
              file: state.pathSetup.file,
            })
          : state.pathSetup
            ? gt("Installed at {path}, which is not on your PATH yet.", {
                path: state.installedPath,
              })
            : gt(
                "Installed at {path}, which is not on your PATH yet. Add its folder to your PATH to run `t3`.",
                { path: state.installedPath },
              );

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <div className="flex gap-2">
          {state.pathSetup && !state.pathSetup.added ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
              <T>Add to PATH</T>
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (!installed && Boolean(state.shadowedBy))}
            onClick={() => run(installed ? "uninstall" : "install")}
          >
            {installed ? t("Remove") : t("Install")}
          </Button>
        </div>
      }
    />
  );
}
