import {
  Platform,
  Text as RNText,
  TextInput as RNTextInput,
  type TextInputInstance,
  type TextInputProps as RNTextInputProps,
  type TextProps as RNTextProps,
} from "react-native";

import { MOBILE_TEXT_CLASSES } from "../../lib/typography";

import { cn } from "../../lib/cn";
import { useMessages } from "gt-react-native";

export type AppTextProps = RNTextProps & {
  readonly className?: string;
  readonly textRole?: keyof typeof MOBILE_TEXT_CLASSES;
  /** 品牌名和用户数据要设 false：它们不是源码文案，翻译会误伤（如 "Code" → "代码"）。 */
  readonly translate?: boolean;
};

export function AppText({
  className,
  textRole,
  children,
  translate = true,
  ...props
}: AppTextProps) {
  // Label text reaches every row and button as a plain string, so the catalog resolves here
  // instead of at each call site. Unknown strings, such as thread titles, pass through.
  const m = useMessages();
  const content = translate && typeof children === "string" ? m(children) : children;
  return (
    <RNText
      className={cn(
        "font-sans text-foreground",
        textRole && MOBILE_TEXT_CLASSES[textRole],
        className,
      )}
      selectionColorClassName={Platform.OS === "android" ? "accent-focus/32" : undefined}
      {...props}
    >
      {content}
    </RNText>
  );
}

export type AppTextInputProps = Omit<RNTextInputProps, "placeholderTextColor"> & {
  readonly className?: string;
  readonly ref?: React.Ref<TextInputInstance>;
};

export function AppTextInput({ className, ref, placeholder, ...props }: AppTextInputProps) {
  const m = useMessages();
  return (
    <RNTextInput
      ref={ref}
      placeholder={typeof placeholder === "string" ? m(placeholder) : placeholder}
      className={cn(
        "min-h-13.5 rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base text-foreground",
        className,
      )}
      placeholderTextColorClassName="accent-placeholder"
      selectionColorClassName={"accent-focus/32"}
      cursorColorClassName={"accent-focus"}
      selectionHandleColorClassName={Platform.OS === "android" ? "accent-focus" : undefined}
      {...props}
    />
  );
}
