import * as Haptics from "expo-haptics";

export function notifyClockSuccess(): void {
  if (process.env.EXPO_OS !== "ios") return;

  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
    () => {},
  );
}
