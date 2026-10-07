import { useState } from "react";
import { Loader2, Plug } from "lucide-react";
import { Button } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { Dialog, Field } from "./ui";
import { containersDockerContextAdd } from "../../lib/tauri/containersCommands";
import { useContainersStore } from "../../state/containersStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";

/**
 * A Docker engine on another computer, as a Docker context — `docker context create`, the same thing
 * a terminal would make, so `docker --context <name>` works there too. SSH uses the user's own keys
 * and `~/.ssh/config`; nothing secret is asked for or kept here.
 */
export function AddEngineDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const detect = useContainersStore((s) => s.detect);
  const setContext = useContainersStore((s) => s.setContext);
  const setNav = useContainersStore((s) => s.setNav);
  const [name, setName] = useState("");
  const [host, setHost] = useState("ssh://");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(name.trim()) && /^(ssh|tcp|unix|npipe):\/\/.+/.test(host.trim());
  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await containersDockerContextAdd(name.trim(), host.trim(), description.trim() || null);
      pushSuccessToast(t("containers.m.engine.added", { name: name.trim() }));
      await detect();
      setContext("docker", name.trim());
      setNav({ runtime: "docker", section: "containers" });
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={t("containers.m.engine.title")}
      onClose={onClose}
      width={500}
      footer={
        <>
          <Button size="md" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="md" variant="primary" onClick={() => void save()} disabled={!valid || saving}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
            {t("containers.m.engine.connect")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" onKeyDown={(e) => e.key === "Enter" && void save()}>
        <p className="text-[12px] leading-relaxed text-[var(--cf-text-muted)]">{t("containers.m.engine.lead")}</p>
        <Field label={t("containers.m.engine.name")}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="servidor-prod" spellCheck={false} className={fieldClass({ size: "sm", className: "w-full font-mono" })} />
        </Field>
        <Field label={t("containers.m.engine.host")} hint={t("containers.m.engine.hostHint")}>
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="ssh://usuario@servidor" spellCheck={false} className={fieldClass({ size: "sm", className: "w-full font-mono" })} />
        </Field>
        <Field label={t("containers.m.engine.description")}>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("containers.m.run.optional")} className={fieldClass({ size: "sm", className: "w-full" })} />
        </Field>
      </div>
    </Dialog>
  );
}
