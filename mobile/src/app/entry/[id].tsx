import { useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { theme } from "@/lib/theme";

export default function EntryDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <View style={styles.screen}>
      <Text style={styles.text}>Entry {id}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center" },
  text: { color: theme.text },
});
