import { useWorkspaceStore } from "../../../state/workspaceStore";
import { followNotification, useNotificationStore } from "../../../state/notificationStore";
import { translate } from "../../../state/languageStore";
import { CodiError, type CodiAction } from "../registry";
import { defineAction, flag, params, say, text } from "./shared";

/**
 * The notification centre: what finished while the user was elsewhere, and the way to it. The rail
 * apps' own actions are in their areas — `notes`, `data`, `workspaceApps`, `devops`.
 */

export function notificationActions(): CodiAction[] {
  return [
    defineAction({
      id: "notifications.list",
      title: {
        en: "List the notification centre's entries — background work that finished — newest first.",
        es: "Lista las entradas del centro de notificaciones (trabajo en segundo plano que terminó), las más nuevas primero.",
      },
      aliases: { es: ["notificaciones", "que notificaciones tengo", "lee las notificaciones", "que paso", "avisos", "hay novedades"], en: ["notifications", "read the notifications", "what happened", "any news", "alerts"] },
      params: params({ unreadOnly: flag("Only the ones not read yet.") }),
      risk: "read",
      where: "main",
      run: async ({ unreadOnly }) => {
        const { items } = useNotificationStore.getState();
        const workspaces = useWorkspaceStore.getState().workspaces;
        const unread = items.filter((n) => !n.seen).length;
        const shown = (unreadOnly === true ? items.filter((n) => !n.seen) : items).slice(0, 10);
        return {
          result: {
            unread,
            notifications: shown.map((n) => ({
              id: n.id,
              title: translate(n.titleKey, n.params),
              ...(n.detail ? { detail: n.detail } : {}),
              status: n.status,
              ...(n.seen ? {} : { unread: true }),
              ...(n.workspaceId ? { workspace: workspaces.find((w) => w.id === n.workspaceId)?.name } : {}),
              minutesAgo: Math.round((Date.now() - n.finishedAt) / 60000),
              ...(n.target ? { openable: true } : {}),
            })),
          },
          say: unread ? say("codi.say.unread", { n: unread }) : say("codi.say.noUnread"),
        };
      },
    }),
    defineAction({
      id: "notification.open",
      title: {
        en: "Go to where a notification's work is (its id from notifications.list) — crossing workspace if it belongs to another.",
        es: "Va a donde está el trabajo de una notificación (su id de notifications.list), cambiando de workspace si es de otro.",
      },
      aliases: { es: ["abre la notificacion", "ve a la notificacion"], en: ["open the notification", "go to the notification"] },
      params: params({ id: text("The notification's id.") }, ["id"]),
      risk: "navigate",
      where: "main",
      run: async ({ id }) => {
        const item = useNotificationStore.getState().items.find((n) => n.id === id);
        if (!item) throw new CodiError(`no notification "${String(id)}" — list them again`);
        if (!item.target) throw new CodiError("that notification has nowhere to go", say("codi.say.notificationNowhere"));
        await followNotification(item);
        return { result: { opened: item.id }, say: say("codi.say.notificationOpened", { name: translate(item.titleKey, item.params) }) };
      },
    }),
  ];
}
