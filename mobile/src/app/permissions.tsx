import { StyleSheet, Text, View } from "react-native";

import { theme } from "@/lib/theme";

export default function Permissions() {
  return (
    <View style={styles.screen}>
      <Text style={styles.text}>Location permissions</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center" },
  text: { color: theme.text },
});
