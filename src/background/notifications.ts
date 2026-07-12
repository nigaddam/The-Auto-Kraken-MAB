let counter = 0;

export interface NotifyOptions {
  urgent?: boolean;
}

type NotificationPermissionLevel = "granted" | "denied";

function getNotificationPermissionLevel(): Promise<NotificationPermissionLevel> {
  return new Promise((resolve) => {
    chrome.notifications.getPermissionLevel((level) => resolve(level === "granted" ? "granted" : "denied"));
  });
}

export async function notify(title: string, message: string, options: NotifyOptions = {}): Promise<void> {
  const permissionLevel = await getNotificationPermissionLevel();
  if (permissionLevel !== "granted") {
    throw new Error(`Chrome notification permission is ${permissionLevel}.`);
  }

  counter += 1;
  const id = `kraken-guard-${Date.now()}-${counter}`;
  await new Promise<void>((resolve, reject) => {
    chrome.notifications.create(
      id,
      {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title,
        message,
        priority: options.urgent ? 2 : 0,
        requireInteraction: options.urgent ?? false,
      },
      () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      }
    );
  });
}
