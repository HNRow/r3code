import { vi } from "vite-plus/test";

// 单元测试里没有启动 GT 的翻译管线；这里用等价的轻量实现，返回英文原文。
// 支持 t`...` / msg("...") 两种写法。
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

vi.mock("gt-react", () => ({
  GTProvider: (props: { readonly children?: unknown }) => props.children,
  initializeGTSPA: async () => {},
  getTranslationsSnapshot: () => ({}),
  msg: identity,
  t: identity,
  T: (props: { readonly children?: unknown }) => props.children,
  Branch: (props: { readonly children?: unknown }) => props.children,
  Plural: (props: { readonly children?: unknown }) => props.children,
  Num: (props: { readonly children?: unknown }) => props.children,
  Currency: (props: { readonly children?: unknown }) => props.children,
  DateTime: (props: { readonly children?: unknown }) => props.children,
  RelativeTime: (props: { readonly children?: unknown }) => props.children,
  Derive: (props: { readonly children?: unknown }) => props.children,
  useLocale: () => "en-US",
  useDefaultLocale: () => "en-US",
  getLocale: () => "en-US",
  useTranslations: () => ({}),
  Var: (props: { readonly children?: unknown }) => props.children,
  useGT: () => identity,
  useMessages: () => identity,
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
