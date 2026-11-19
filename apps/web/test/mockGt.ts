import { vi } from "vite-plus/test";

// 单元测试里没有启动 GT 的翻译管线；这里用等价的轻量实现，返回英文原文。
// 支持 t`...` / msg("...") 两种写法。
function identity(message: unknown, ...values: ReadonlyArray<unknown>): string {
  if (typeof message === "string") return message;
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
  Var: (props: { readonly children?: unknown }) => props.children,
  useGT: () => identity,
  useMessages: () => identity,
  decodeOptions: () => undefined,
  gtFallback: (message: string) => message,
  getReactI18nCache: () => ({ lookupTranslation: () => undefined }),
}));
