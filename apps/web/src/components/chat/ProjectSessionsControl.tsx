import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { AgentSessionRecentSession, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { HistoryIcon } from "lucide-react";
import { useContext, useState } from "react";
import { T, useGT, useMessages } from "gt-react";

import { agentSessionImport, agentSessionList } from "../../state/agentSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatEnvironmentQueryError } from "../../state/query";
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
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

const SOURCE_LABELS = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  pi: "Pi",
} as const;

const TIMESTAMP_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ProjectSessionsControl({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <ThreadDetailsControl
        part="row"
        aria-label={gt("Project sessions")}
        onClick={() => setOpen(true)}
      >
        <HistoryIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className={`min-w-0 truncate ${THREAD_DETAILS_PANEL_LABEL_CLASS}`}>
          <T>Project sessions</T>
        </span>
      </ThreadDetailsControl>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <ProjectSessionsDialog environmentId={environmentId} projectId={projectId} />
        ) : null}
      </Dialog>
    </>
  );
}

function ProjectSessionsDialog({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const m = useMessages();
  const registry = useContext(RegistryContext);
  const atom = agentSessionList({ environmentId, input: { projectId } });
  const result = useAtomValue(atom);
  const data = AsyncResult.getOrElse(result, () => null);
  const importSessions = useAtomCommand(agentSessionImport, { reportFailure: false });
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const sessions = data?.sessions ?? [];
  const importableCount = sessions.filter((session) => !session.alreadyImported).length;
  const error = result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null;
  const loading = data === null && error === null;

  const runImport = async () => {
    setImporting(true);
    setImportError(null);
    const imported = await importSessions({ environmentId, input: { projectId } });
    setImporting(false);
    if (imported._tag === "Success") registry.refresh(atom);
    else if (imported._tag === "Failure")
      setImportError(formatEnvironmentQueryError(imported.cause));
  };

  return (
    <DialogPopup className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          <T>Project sessions</T>
        </DialogTitle>
        <DialogDescription>
          <T>
            Sessions that agents ran in this project's directory, including ones started outside R3
            Code.
          </T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {loading ? (
          <p className="text-muted-foreground text-sm">
            <T>Looking for sessions…</T>
          </p>
        ) : error !== null ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : sessions.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            <T>No sessions found for this project.</T>
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {sessions.map((session) => (
              <SessionRow
                key={`${session.source}\0${session.providerSessionId}`}
                session={session}
              />
            ))}
          </ul>
        )}
      </DialogPanel>
      <DialogFooter>
        {importError !== null ? (
          <p className="self-center text-sm text-destructive sm:mr-auto">{importError}</p>
        ) : null}
        <Button
          variant="outline"
          onClick={() => registry.refresh(atom)}
          disabled={loading || importing}
        >
          <T>Refresh</T>
        </Button>
        <Button onClick={() => void runImport()} disabled={importableCount === 0 || importing}>
          {importing
            ? m("Importing…")
            : importableCount === 0
              ? m("Nothing to import")
              : `${m("Import")} ${importableCount}`}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

function SessionRow({ session }: { readonly session: AgentSessionRecentSession }) {
  const m = useMessages();
  return (
    <li className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm">
      <span className="w-20 shrink-0 text-muted-foreground text-xs">
        {SOURCE_LABELS[session.source]}
      </span>
      <span className="min-w-0 flex-1 truncate">{session.title ?? session.providerSessionId}</span>
      {session.alreadyImported ? (
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
          {m("In a thread")}
        </span>
      ) : null}
      <span className="shrink-0 text-muted-foreground text-xs">
        {session.lastActiveAt === null
          ? null
          : TIMESTAMP_FORMAT.format(new Date(session.lastActiveAt))}
      </span>
    </li>
  );
}
