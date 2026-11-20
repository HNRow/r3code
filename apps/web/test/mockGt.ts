import { vi } from "vite-plus/test";

// 单元测试里没有启动 GT 的翻译管线；这里用等价的轻量实现，返回英文原文。
// 支持 t`...` / msg("...") 两种写法。
// ICU 的单复数/选择分支，测试里只取英文分支
function closeBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readBranches(body: string): Map<string, string> {
  const branches = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i]!)) i++;
    const start = i;
    while (i < body.length && !/[\s{]/.test(body[i]!)) i++;
    if (start === i) break;
    const name = body.slice(start, i);
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (body[i] !== "{") continue;
    const end = closeBrace(body, i);
    if (end < 0) break;
    branches.set(name, body.slice(i + 1, end));
    i = end + 1;
  }
  return branches;
}

function resolveIcu(message: string, variables: Record<string, unknown>): string {
  let text = message;
  const pattern = /\{(\w+),\s*(plural|selectordinal|select)\s*,/;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const end = closeBrace(text, match.index);
    if (end < 0) break;
    const branches = readBranches(text.slice(match.index + match[0].length, end));
    const value = variables[match[1]!];
    const branch =
      branches.get(`=${String(value)}`) ??
      (match[2] === "select"
        ? branches.get(String(value))
        : Number(value) === 1
          ? branches.get("one")
          : branches.get("other")) ??
      branches.get("other") ??
      "";
    text = text.slice(0, match.index) + branch + text.slice(end + 1);
  }
  return text;
}

function decodeBase64(value: string): string {
  if (typeof atob === "function") {
    return new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
  }
  return Buffer.from(value, "base64").toString("utf8");
}

// m()/useMessages() 在真实运行时会把编译后的 "<source>:<base64>" 解回原文
function decodeEncoded(
  message: string,
): { source: string; options: Record<string, unknown> } | null {
  const separator = message.lastIndexOf(":");
  if (separator < 0) return null;
  try {
    const options = JSON.parse(decodeBase64(message.slice(separator + 1))) as Record<
      string,
      unknown
    >;
    return {
      source: typeof options.$_source === "string" ? options.$_source : message.slice(0, separator),
      options,
    };
  } catch {
    return null;
  }
}

function identity(message: unknown, ...values: ReadonlyArray<unknown>): string {
  if (typeof message === "string") {
    const decoded = decodeEncoded(message);
    if (decoded) {
      return identity(decoded.source, {
        ...decoded.options,
        ...(values[0] as Record<string, unknown> | undefined),
      });
    }
    const variables =
      values[0] !== null && typeof values[0] === "object" && !Array.isArray(values[0])
        ? (values[0] as Record<string, unknown>)
        : {};
    return resolveIcu(message, variables)
      .replace(/\{(\w+)\}/g, (match, key: string) =>
        variables[key] === undefined ? match : String(variables[key]),
      )
      .replace(/''/g, "'");
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
