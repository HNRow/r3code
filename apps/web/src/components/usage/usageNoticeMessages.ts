import { msg } from "gt-react";

// limitsNotice falls back to these strings in @t3tools/shared, which has no i18n runtime.
// The catalog only knows messages extracted here.
void [
  msg("This account has no subscription limits."),
  msg("Could not read limits."),
  msg("No limits reported."),
];
