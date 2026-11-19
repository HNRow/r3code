import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

// 翻译库里 "Code" → "代码"；用它才能区分“翻译过”和“原样输出”。
vi.mock("gt-react-native", () => ({
  useMessages: () => (message: string) => (message === "Code" ? "代码" : message),
}));

import { AppText } from "./AppText";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

function render(node: ReactNode) {
  act(() => root.render(node));
  return container.textContent;
}

describe("AppText", () => {
  it("translates string children by default", () => {
    expect(render(<AppText>Code</AppText>)).toBe("代码");
  });

  it("renders children verbatim when translate is false", () => {
    expect(render(<AppText translate={false}>Code</AppText>)).toBe("Code");
  });
});
