import { SymbolView } from "expo-symbols";
import { Tabs } from "expo-router";

import { theme } from "@/lib/theme";

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: theme.brand }}>
      <Tabs.Screen
        name="index"
        options={{
          title: "Clock",
          tabBarIcon: ({ color, size }) => (
            <SymbolView
              name={{ ios: "clock", android: "schedule" }}
              size={size}
              tintColor={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: "History",
          tabBarIcon: ({ color, size }) => (
            <SymbolView
              name={{ ios: "clock.arrow.circlepath", android: "history" }}
              size={size}
              tintColor={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color, size }) => (
            <SymbolView
              name={{ ios: "person.crop.circle", android: "account_circle" }}
              size={size}
              tintColor={color}
            />
          ),
        }}
      />
    </Tabs>
  );
}
