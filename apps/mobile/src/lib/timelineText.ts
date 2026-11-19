import { t } from "../i18n/gt";
import { msg } from "gt-react-native";

// 服务端把这些英文原样写进事件记录（见 RestartContinuation / ProviderRuntimeRecoveryService），
// 客户端只按整句查表翻译；provider 发来的通知原文不在表里，保持不动。
const SERVER_NOTICE_TEXT: ReadonlySet<string> = new Set([
  msg("R3 Code restarted and resumed this turn"),
  msg("R3 Code restarted and stopped background work"),
  msg("Cancelled because the server restarted before the provider work completed."),
  msg("Cancelled because the server shut down before the provider work completed."),
]);

const TURN_FOLD_TEXT: ReadonlySet<string> = new Set([
  msg("Worked"),
  msg("You stopped this response"),
  msg("Continued"),
]);

export function translateServerNotice(text: string, m: (text: string) => string): string {
  return SERVER_NOTICE_TEXT.has(text) ? m(text) : text;
}

/** Turn fold labels are built in English by the thread feed, so the render side resolves them. */
export function translateTurnFoldLabel(label: string, m: (text: string) => string): string {
  const match = /^(Worked for|You stopped after|Continued for) (.+)$/.exec(label);
  if (match) {
    const [, prefix, duration] = match;
    if (prefix === "Worked for") return t`Worked for ${duration}`;
    if (prefix === "You stopped after") return t`You stopped after ${duration}`;
    return t`Continued for ${duration}`;
  }
  return TURN_FOLD_TEXT.has(label) ? m(label) : label;
}
