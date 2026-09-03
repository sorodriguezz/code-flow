/**
 * The operating system's own notifications.
 *
 * The app deliberately keeps running with its window hidden — closing it parks the process in the
 * tray so agent runs, reviews and terminals survive — which meant that until this existed, "your
 * review finished" landed in a bell inside a window nobody could see. The in-app notification is
 * still the record; this is the tap on the shoulder.
 *
 * Talks to `tauri-plugin-notification` through `invoke` rather than through its npm package. The
 * package is a thin wrapper over exactly these three commands, and this file is smaller than the
 * dependency — which matters more than usual here, because the whole surface is "may I?", "am I
 * allowed?" and "here it is".
 *
 * **Everything degrades to silence.** A platform with no notification service, a user who said no,
 * a Linux desktop without a daemon: all of them throw, and none of them is an error the person who
 * asked for a code review needs to hear about. The in-app bell already has the message.
 */

import { invoke } from "@tauri-apps/api/core";

type Permission = "granted" | "denied" | "default";

/**
 * Cached so a burst of finishing runs does not ask the OS the same question five times. Reset by
 * `requestNativePermission`, which is the only thing that can change the answer.
 */
let granted: boolean | null = null;

export async function nativePermission(): Promise<Permission> {
  try {
    const ok = await invoke<boolean>("plugin:notification|is_permission_granted");
    granted = ok;
    return ok ? "granted" : "default";
  } catch {
    return "denied";
  }
}

/**
 * Asks for permission, returning what the user said.
 *
 * macOS shows its prompt once per install and remembers the answer forever, so this is called from
 * the settings toggle rather than at startup: a permission dialog on first launch, before the user
 * has seen anything finish, is one people dismiss on reflex and can then only undo in System
 * Settings.
 */
export async function requestNativePermission(): Promise<Permission> {
  try {
    const answer = await invoke<Permission>("plugin:notification|request_permission");
    granted = answer === "granted";
    return answer;
  } catch {
    granted = false;
    return "denied";
  }
}

/**
 * Posts one notification, if we are allowed and the user wants them.
 *
 * Never throws and never awaits anything the caller depends on: it is called from `notify`, which
 * runs inside a zustand `set` on a path that must not be able to fail.
 */
export function sendNativeNotification(title: string, body: string): void {
  void (async () => {
    try {
      if (granted === null) await nativePermission();
      if (!granted) return;
      await invoke("plugin:notification|notify", { options: { title, body } });
    } catch {
      // See the header: silence is the correct failure mode here.
    }
  })();
}
