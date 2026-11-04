/**
 * A template's own actions — edit, back to the original, delete — and its editor. They live where
 * templates are picked (the first step of «Nuevo agente», the team templates dialog): one door for
 * templates instead of a separate library screen that showed the same cards.
 */
import { useState } from "react";
import { Pencil, RotateCcw, Save, Trash2 } from "lucide-react";
import { useLibraryStore } from "../../../state/libraryStore";
import { confirmAction } from "../../../state/confirmStore";
import { pushErrorToast } from "../../../state/toastStore";
import { isBuiltin, type AgentTemplateBody } from "../../../lib/agents/builtinTemplates";
import type { LibraryItem } from "../../../types/crew";
import { AgentAvatar } from "../kit/Avatar";
import { Btn, IconBtn, Modal, field } from "../kit/ui";
import { useL } from "../state";

/** Edit (agents only), back to the original (an edited built-in), delete (one of yours). */
export function TemplateActions({ item, onEdit }: { item: LibraryItem; onEdit?: () => void }) {
  const l = useL();
  const edited = Boolean(item.based_on);
  const own = !isBuiltin(item.id) && !item.based_on;
  return (
    <span className="flex items-center gap-0.5 rounded-md bg-[var(--cf-surface)] shadow-[0_0_0_1px_var(--cf-border)]">
      {onEdit && <IconBtn title={l("Editar la plantilla", "Edit the template")} icon={Pencil} onClick={onEdit} />}
      {edited && <IconBtn title={l("Volver a la plantilla original", "Back to the original template")} icon={RotateCcw} onClick={() => void useLibraryStore.getState().remove(item.id)} />}
      {own && (
        <IconBtn
          title={l("Borrar esta plantilla tuya", "Delete this template of yours")}
          icon={Trash2}
          danger
          onClick={() => void confirmAction(l(`¿Borrar la plantilla «${item.name}»?`, `Delete template «${item.name}»?`)).then((ok) => { if (ok) void useLibraryStore.getState().remove(item.id); })}
        />
      )}
    </span>
  );
}

export function TemplateEditor({ item, onClose }: { item: LibraryItem; onClose: () => void }) {
  const l = useL();
  const [draft, setDraft] = useState<LibraryItem>(item);
  const body = draft.body as AgentTemplateBody;
  const setBody = (p: Partial<AgentTemplateBody>) => setDraft((d) => ({ ...d, body: { ...(d.body as AgentTemplateBody), ...p } }));
  const save = async () => {
    try {
      await useLibraryStore.getState().save(draft);
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    }
  };
  return (
    <Modal
      title={l(`Plantilla: ${item.name}`, `Template: ${item.name}`)}
      subtitle={isBuiltin(item.id) ? l("Es integrada: guardar crea tu copia, y siempre puedes volver a la original.", "It is built in: saving makes your copy, and you can always go back to the original.") : l("Los agentes hechos con ella podrán actualizarse a esta versión.", "Agents made from it can update to this version.")}
      leading={<AgentAvatar agent={{ id: item.id, icon: draft.icon, color: draft.color }} size={40} />}
      onClose={onClose}
      footer={
        <>
          <span className="flex-1" />
          <Btn kind="ghost" title={l("Cierra sin guardar los cambios", "Closes without saving changes")} onClick={onClose}>{l("Cancelar", "Cancel")}</Btn>
          <Btn kind="primary" icon={Save} title={l("Guarda la plantilla en tu biblioteca", "Saves the template to your library")} onClick={() => void save()}>{l("Guardar", "Save")}</Btn>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={l("Nombre", "Name")} className={field} />
        <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder={l("Descripción", "Description")} className={field} />
        <input value={body.provider} onChange={(e) => setBody({ provider: e.target.value.trim() })} placeholder="claude" className={`${field} font-mono`} />
        <input value={body.model} onChange={(e) => setBody({ model: e.target.value.trim() })} placeholder="claude-sonnet-…" className={`${field} font-mono`} />
      </div>
      <input value={body.role} onChange={(e) => setBody({ role: e.target.value })} placeholder={l("Papel", "Role")} className={field} />
      <textarea value={body.prompt} onChange={(e) => setBody({ prompt: e.target.value })} rows={9} className={`${field} h-auto resize-y py-2 font-mono text-[12px]`} />
    </Modal>
  );
}
