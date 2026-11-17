import { View } from "react-native";
import { Text } from "@expo/ui/jetpack-compose";
import { IconButton } from "../../components/ui/IconButton";
import { NativeAppBar } from "../../components/ui/NativeAppBar.android";
import { T, useGT } from "gt-react-native";

export function NativeAppBarExample() {
  const gt = useGT();
  return (
    <NativeAppBar
      title={
        <Text style={{ fontSize: 21 }}>
          <T>Native app bar</T>
        </Text>
      }
      navigationIcon={
        <IconButton icon="arrow.left" accessibilityLabel={gt("Example back")} onPress={() => {}} />
      }
      actions={
        <View className="flex-row">
          <IconButton
            icon="magnifyingglass"
            accessibilityLabel={gt("Example search")}
            onPress={() => {}}
          />
        </View>
      }
    />
  );
}
