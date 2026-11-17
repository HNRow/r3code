import type { ComponentProps } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { T } from "gt-react";

export function ChatGptUsageButton(props: Omit<ComponentProps<typeof Button>, "onClick">) {
  return (
    <Button
      variant="ghost-muted"
      size="sm"
      {...props}
      onClick={() => void ensureLocalApi().shell.openExternal(CHATGPT_USAGE_URL)}
    >
      <T>
        Manage usage
        <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
      </T>
    </Button>
  );
}
