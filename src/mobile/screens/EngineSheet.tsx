import { useEffect, useState } from "react";
import { Check, ChevronLeft, Loader2 } from "lucide-react";
import { t } from "../i18n";
import { useNav } from "../nav";
import { Sheet } from "../ui/Sheet";
import { Card, Divider, Row, Section } from "../ui/List";
import {
  modelLabel,
  modelOptions,
  PHONE_PROVIDERS,
  providerLabel,
  useChatEngine,
  type ChatEngine,
  type ModelOption,
} from "../chatEngine";

/**
 * The chat's engine: a provider, then one of its models (see `chatEngine.ts`).
 *
 * # A conversation keeps its provider
 *
 * As on the desk: each CLI keeps its own sessions, so the turns so far live where another engine
 * cannot read them, and its resume token means nothing there. Once a conversation has turns, the
 * other providers' models start a **new** conversation on that engine — said under the provider's
 * name before it is tapped — rather than quietly dropping the thread. Another model of the same
 * provider is just picked.
 */
export function EngineSheet({
  projectId,
  conversationId,
  current,
  locked,
}: {
  projectId: string;
  conversationId: string;
  /** What the chip showed — `null` while the routing was still being read. */
  current: ChatEngine | null;
  /** The conversation has turns: another provider means a new conversation. */
  locked: boolean;
}) {
  const back = useNav((s) => s.back);
  const [browsing, setBrowsing] = useState<string | null>(null);
  const live = useChatEngine((s) => (browsing ? s.live[browsing] : undefined));
  const loading = useChatEngine((s) => (browsing ? (s.loading[browsing] ?? false) : false));
  const loadModels = useChatEngine((s) => s.loadModels);

  useEffect(() => {
    if (browsing) void loadModels(browsing);
  }, [browsing, loadModels]);

  const moves = (provider: string) => locked && current !== null && provider !== current.provider;

  const choose = (model: string) => {
    if (!browsing) return;
    const engine = { provider: browsing, model };
    const store = useChatEngine.getState();
    if (moves(browsing)) store.startFresh(projectId, engine);
    else store.pick(conversationId, engine);
    back();
  };

  if (!browsing) {
    return (
      <Sheet title={t("engine.title")}>
        <Section title={t("engine.providers")}>
          <Card>
            {PHONE_PROVIDERS.map((provider, index) => {
              const Icon = provider.icon;
              const here = current?.provider === provider.id;
              return (
                <div key={provider.id}>
                  {index > 0 && <Divider inset />}
                  <Row
                    leading={<Icon size={17} className="text-[var(--cf-text-muted)]" aria-hidden />}
                    title={providerLabel(provider.id)}
                    subtitle={
                      here && current
                        ? modelLabel(current.provider, current.model)
                        : moves(provider.id)
                          ? t("engine.newConversation")
                          : undefined
                    }
                    trailing={here ? <Check size={17} className="text-[var(--cf-accent)]" aria-hidden /> : undefined}
                    onClick={() => setBrowsing(provider.id)}
                  />
                </div>
              );
            })}
          </Card>
        </Section>
      </Sheet>
    );
  }

  const options = modelOptions(browsing, live);
  const latest = options.filter((m) => !m.legacy);
  const older = options.filter((m) => m.legacy);
  const selected = current?.provider === browsing ? current.model : null;
  const list = (models: ModelOption[], withDefault: boolean) => (
    <Card>
      {withDefault && (
        <ModelRow title={t("engine.cliDefault")} subtitle={t("engine.cliDefaultHint")} on={selected === ""} onClick={() => choose("")} />
      )}
      {models.map((model, index) => (
        <div key={model.id}>
          {(withDefault || index > 0) && <Divider />}
          <ModelRow
            title={model.label}
            // The id under its name when the two differ — what a run will report, and what the
            // desk's Settings shows.
            subtitle={model.label !== model.id ? model.id : undefined}
            on={selected === model.id}
            onClick={() => choose(model.id)}
          />
        </div>
      ))}
    </Card>
  );

  return (
    <Sheet title={t("engine.title")}>
      <Section
        title={providerLabel(browsing)}
        action={
          <button
            type="button"
            onClick={() => setBrowsing(null)}
            className="cf-tap flex items-center gap-0.5 text-xs font-medium text-[var(--cf-accent-text)]"
          >
            <ChevronLeft size={14} aria-hidden />
            {t("engine.providers")}
          </button>
        }
      >
        {moves(browsing) && <p className="px-1 pb-2 text-xs text-[var(--cf-text-muted)]">{t("engine.newConversationHint")}</p>}
        {list(latest, true)}
        {loading && (
          <p className="flex items-center gap-2 px-1 pt-2 text-xs text-[var(--cf-text-muted)]">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            {t("engine.loading")}
          </p>
        )}
      </Section>
      {older.length > 0 && <Section title={t("engine.older")}>{list(older, false)}</Section>}
    </Sheet>
  );
}

function ModelRow({ title, subtitle, on, onClick }: { title: string; subtitle?: string; on: boolean; onClick: () => void }) {
  return (
    <Row
      title={title}
      subtitle={subtitle}
      chevron={false}
      titleClassName={on ? "font-semibold" : ""}
      trailing={on ? <Check size={17} className="text-[var(--cf-accent)]" aria-hidden /> : undefined}
      onClick={onClick}
    />
  );
}
