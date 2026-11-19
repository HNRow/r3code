import { mFallback } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

// 本 fork 的错误目前只带英文 message；i18nMessage 是上游给已标记文案预留的字段。
function resolveMarkedText(text: ReadonlyArray<string>, resolve: MFunctionType): string {
  return text.map((sentence) => resolve(sentence)).join(" ");
}

function errorI18nMessage(error: unknown): ReadonlyArray<string> | undefined {
  if (typeof error !== "object" || error === null || !("i18nMessage" in error)) return undefined;
  const text = error.i18nMessage;
  return Array.isArray(text) && text.every((sentence) => typeof sentence === "string")
    ? text
    : undefined;
}

/** What to show for an error: its marked text in the active language, else its message. */
export function errorDisplayMessage(
  error: unknown,
  resolve: MFunctionType = mFallback,
): string | null {
  const text = errorI18nMessage(error);
  if (text !== undefined) return resolveMarkedText(text, resolve);
  if (typeof error !== "object" || error === null || !("message" in error)) return null;
  return typeof error.message === "string" && error.message.trim().length > 0
    ? error.message
    : null;
}
