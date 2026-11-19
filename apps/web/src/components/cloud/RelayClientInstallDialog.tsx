import { DownloadIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { RelayClientInstallProgressStage } from "@t3tools/contracts";

import {
  completeRelayClientInstallDialogClose,
  readRelayClientInstallDialogState,
  respondToRelayClientInstallConfirmation,
  subscribeRelayClientInstallDialog,
} from "../../cloud/relayClientInstallDialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogAction,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Var, T, useGT, t } from "gt-react";
const installSteps: ReadonlyArray<{
  readonly stage: RelayClientInstallProgressStage;
  readonly label: string;
}> = [
  {
    stage: "checking",
    get label() {
      return t("Checking current installation");
    },
  },
  {
    stage: "waiting_for_lock",
    get label() {
      return t("Waiting for installer");
    },
  },
  {
    stage: "downloading",
    get label() {
      return t("Downloading relay client");
    },
  },
  {
    stage: "verifying",
    get label() {
      return t("Verifying download");
    },
  },
  {
    stage: "installing",
    get label() {
      return t("Installing relay client");
    },
  },
  {
    stage: "validating",
    get label() {
      return t("Validating executable");
    },
  },
  {
    stage: "activating",
    get label() {
      return t("Activating installation");
    },
  },
];

export function RelayClientInstallDialog() {
  const gt = useGT();
  const state = useSyncExternalStore(
    subscribeRelayClientInstallDialog,
    readRelayClientInstallDialogState,
    readRelayClientInstallDialogState,
  );
  const view = state.status === "closing" ? state.view : state;
  const isConfirming = view.status === "confirming";
  const isInstalling = view.status === "installing";
  const activeStepIndex = isInstalling
    ? installSteps.findIndex(({ stage }) => stage === view.stage)
    : -1;
  const activeStep = installSteps[activeStepIndex];

  return (
    <Dialog
      open={state.status === "confirming" || state.status === "installing"}
      onOpenChange={(open) => {
        if (!open && isConfirming) {
          respondToRelayClientInstallConfirmation(false);
        }
      }}
      onOpenChangeComplete={(open) => {
        if (!open) {
          completeRelayClientInstallDialogClose();
        }
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={isConfirming}>
        <DialogHeader>
          <div className="flex size-9 items-center justify-center rounded-lg border border-border/70 bg-muted/60">
            <DownloadIcon aria-hidden className="size-4.5 text-muted-foreground" />
          </div>
          <DialogTitle>
            {isInstalling ? t("Installing relay client") : t("Install relay client?")}
          </DialogTitle>
          <DialogDescription>
            {isInstalling
              ? t("R3 Code is preparing this environment for secure access through R3 Connect.")
              : t(
                  "R3 Code needs the relay client to make this environment available through R3 Connect.",
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          {isInstalling ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <p aria-live="polite" className="font-medium text-foreground">
                  {activeStep?.label}
                </p>
                <p className="shrink-0 tabular-nums text-muted-foreground">
                  <T>
                    <Var>{activeStepIndex + 1}</Var> of <Var>{installSteps.length}</Var>
                  </T>
                </p>
              </div>
              <progress
                aria-label={gt("Relay client installation progress")}
                className="h-2 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary"
                max={installSteps.length}
                value={activeStepIndex + 1}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                <T>Keep R3 Code open while the relay client is installed.</T>
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-border/70 bg-muted/35 p-3">
              <p className="text-sm font-medium text-foreground">
                <T>Managed relay client</T>
              </p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                <T>
                  R3 Code will download and install version<Var> </Var>
                  <Var>{view.status === "confirming" ? view.version : ""}</Var> locally.
                </T>
              </p>
            </div>
          )}
        </DialogPanel>
        {isConfirming ? (
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => respondToRelayClientInstallConfirmation(false)}
            >
              <T>Cancel</T>
            </Button>
            <DialogAction onClick={() => respondToRelayClientInstallConfirmation(true)}>
              <T>Download and install</T>
            </DialogAction>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
