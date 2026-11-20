import { vi } from "vite-plus/test";

// 单元测试里没有启动 GT 的翻译管线，且移动端单测通常只 mock 了 react-native 的一小部分。
// 这里用等价的轻量实现替换 GT 包，返回英文原文，并支持 msg("...") 与 t`...` 两种写法。
function identity(message: unknown, ...values: ReadonlyArray<unknown>): string {
  if (typeof message === "string") {
    const variables = values[0];
    if (variables !== null && typeof variables === "object" && !Array.isArray(variables)) {
      return message.replace(/\{(\w+)\}/g, (match, key: string) => {
        const value = (variables as Record<string, unknown>)[key];
        return value === undefined ? match : String(value);
      });
    }
    return message;
  }
  if (!Array.isArray(message)) return message as string;
  const parts = message as ReadonlyArray<string>;
  return parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), "");
}

vi.mock("gt-react-native", () => ({
  GTProvider: (props: { readonly children?: unknown }) => props.children,
  initializeGT: () => {},
  msg: identity,
  T: (props: { readonly children?: unknown }) => props.children,
  Var: (props: { readonly children?: unknown }) => props.children,
  useGT: () => identity,
  useMessages: () => identity,
  useLocale: () => "en-US",
  useDefaultLocale: () => "en-US",
  getLocale: () => "en-US",
  decodeOptions: (message: string) => {
    const separator = message.lastIndexOf(":");
    if (separator < 0) return undefined;
    try {
      const decoded = JSON.parse(
        Buffer.from(message.slice(separator + 1), "base64").toString("utf8"),
      ) as Record<string, unknown>;
      if (typeof decoded.$_source !== "string") decoded.$_source = message.slice(0, separator);
      return decoded;
    } catch {
      return undefined;
    }
  },
  gtFallback: (message: string, options?: Record<string, unknown>) => identity(message, options),
  getReactI18nCache: () => ({ lookupTranslation: () => undefined }),
}));

vi.mock("@generaltranslation/react-core/pure", () => ({
  t: identity,
  msg: identity,
  decodeMsg: (message: unknown) => message,
}));

vi.mock("gt-i18n", () => ({
  t: identity,
  msg: identity,
  decodeMsg: (message: unknown) => message,
}));
