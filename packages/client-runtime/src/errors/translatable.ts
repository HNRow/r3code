import { decodeMsg, decodeOptions, mFallback } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

function englishSentence(marked: string): string {
  return typeof decodeOptions(marked)?.$_source === "string" ? decodeMsg(marked) : marked;
}

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

/** `detail` in English plus the marked text, for errors whose `message` reads `detail`. */
export function translatableDetail(...text: ReadonlyArray<string>): {
  readonly detail: string;
  readonly i18nMessage: ReadonlyArray<string>;
} {
  return { detail: text.map(englishSentence).join(" "), i18nMessage: text };
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

/** A thrown `Error`'s text in the active language, its `message`, and null otherwise. */
export function thrownErrorMessage(
  error: unknown,
  resolve: MFunctionType = mFallback,
): string | null {
  if (!(error instanceof Error)) return null;
  const text = errorI18nMessage(error);
  return text === undefined ? error.message : resolveMarkedText(text, resolve);
}
