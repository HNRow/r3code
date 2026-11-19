import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ToolCallVisibility } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../../../components/ui/AppText";
import { ListChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { SettingsSection } from "../../components/SettingsSection";
import { useGT, T } from "gt-react-native";
import { t } from "../../../../i18n/gt";

const TOOL_CALL_VISIBILITY_OPTIONS: ReadonlyArray<{
  readonly value: ToolCallVisibility;
  readonly label: string;
}> = [
  {
    value: "showAll",
    get label() {
      return t("Show all");
    },
  },
  {
    value: "hideSuccessful",
    get label() {
      return t("Hide successful");
    },
  },
  {
    value: "hideAll",
    get label() {
      return t("Hide all");
    },
  },
  {
    value: "zen",
    get label() {
      return t("Zen");
    },
  },
];

export function ToolCallsAppearanceSection() {
  const gt = useGT();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const selected = AsyncResult.isSuccess(preferences)
    ? (preferences.value.toolCallVisibility ?? "showAll")
    : null;

  return (
    <View className="gap-3">
      <SettingsSection title={gt("Tool calls in chat")}>
        {TOOL_CALL_VISIBILITY_OPTIONS.map((option, index) => (
          <ListChoiceRow
            key={option.value}
            label={option.label}
            selected={selected === option.value}
            separated={index > 0}
            disabled={selected === null}
            onPress={() => savePreferences({ toolCallVisibility: option.value })}
          />
        ))}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        <T>
          Hide the commands, edits, and searches agents run. Hide successful keeps failures. Zen
          shows only final answers. Approvals, questions, and errors always show.
        </T>
      </Text>
    </View>
  );
}
