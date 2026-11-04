/**
 * The two knobs the whole workspace shares: how many agent turns may run at once (the runner's
 * governor) and the decision layer — which voter it uses, how many votes, how sure it must be.
 */
import { useEffect, useState } from "react";
import { Brain, Cpu, Gauge, Sparkles } from "lucide-react";
import { useAgentsStore } from "../../state/agentsStore";
import {
  deciderConfig,
  deciderSet,
  deciderTry,
  governorSet,
  governorStatus,
  type DeciderConfig,
  type DeciderVerdict,
  type GovernorStatus,
} from "../../lib/tauri/runnerCommands";
import { pushErrorToast } from "../../state/toastStore";
import { Btn, Chip, Label, Modal, Seg, Stepper, Switch } from "./kit/ui";
import { useCrewStore, useL } from "./state";
import { useUiStore } from "../../state/uiStore";

export function GovernorDialog() {
  const l = useL();
  const close = useCrewStore((s) => s.close);
  const roster = useAgentsStore((s) => s.roster);
  const [status, setStatus] = useState<GovernorStatus | null>(null);
  const [max, setMax] = useState(6);
  const [perModel, setPerModel] = useState<Record<string, number>>({});

  useEffect(() => {
    void governorStatus().then((s) => {
      setStatus(s);
      setMax(s.max_turns);
      setPerModel(s.per_model);
    });
  }, []);

  const models = [...new Set(roster.map((a) => a.model).filter(Boolean))];
  const save = async () => {
    try {
      const next = await governorSet({ max_turns: max, per_model: perModel });
      setStatus(next);
      close();
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  return (
    <Modal
      title={l("Recursos del workspace", "Workspace resources")}
      subtitle={l("Cuántos turnos de agentes corren a la vez, entre todos los equipos. Lo que no cabe espera su turno, y nunca se frena una pregunta que escribes tú.", "How many agent turns run at once, across every team. What does not fit waits its turn, and a question you type is never held back.")}
      leading={<span className="grid h-10 w-10 place-items-center rounded-[12px] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"><Gauge className="h-5 w-5" /></span>}
      onClose={close}
      footer={
        <>
          <span className="flex-1 text-[12px] text-[var(--cf-text-faint)]">
            {status ? l(`Ahora: ${status.running} corriendo · ${status.waiting} en cola`, `Now: ${status.running} running · ${status.waiting} queued`) : ""}
          </span>
          <Btn kind="ghost" onClick={close} title={l("Cierra sin guardar cambios", "Closes without saving")}>{l("Cancelar", "Cancel")}</Btn>
          <Btn kind="primary" onClick={() => void save()} title={l("Aplica los topes a todo el workspace", "Applies the caps to the whole workspace")}>{l("Guardar", "Save")}</Btn>
        </>
      }
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px]">{l("Turnos a la vez", "Turns at once")}</span>
        <Stepper value={max} min={1} max={32} onChange={setMax} label="max" />
      </div>
      <div className="flex flex-col gap-2">
        <Label>{l("Tope por modelo (opcional)", "Cap per model (optional)")}</Label>
        {models.length === 0 && <span className="text-[12px] text-[var(--cf-text-muted)]">{l("Tus agentes aún no tienen modelo.", "Your agents have no model yet.")}</span>}
        {models.map((model) => (
          <div key={model} className="flex items-center justify-between gap-3 rounded-[9px] border border-[var(--cf-border)] px-3 py-1.5">
            <span title={l("Modelo usado por tus agentes", "Model your agents use")} className="font-mono text-[12px]">{model}</span>
            <span className="flex items-center gap-2">
              <Switch checked={model in perModel} onChange={(on) => setPerModel((p) => { const next = { ...p }; if (on) next[model] = 2; else delete next[model]; return next; })} />
              {model in perModel && <Stepper value={perModel[model]} min={1} max={16} onChange={(v) => setPerModel((p) => ({ ...p, [model]: v }))} label={model} />}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function DeciderDialog() {
  const l = useL();
  const close = useCrewStore((s) => s.close);
  const [config, setConfig] = useState<DeciderConfig | null>(null);
  const [verdict, setVerdict] = useState<DeciderVerdict | null>(null);
  const [trying, setTrying] = useState(false);

  useEffect(() => {
    void deciderConfig().then(setConfig);
  }, []);
  if (!config) return null;
  const patch = (p: Partial<DeciderConfig>) => setConfig({ ...config, ...p });

  const save = async () => {
    try {
      setConfig(await deciderSet(config));
      close();
    } catch (error) {
      pushErrorToast(String(error));
    }
  };
  const test = async () => {
    setTrying(true);
    try {
      await deciderSet(config);
      setVerdict(await deciderTry());
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setTrying(false);
    }
  };

  return (
    <Modal
      title={l("Capa de decisión", "Decision layer")}
      subtitle={l("El modelo escribe, el decisor decide, el código actúa. Las decisiones cerradas (reintentar o escalar, a quién va algo) se votan con un modelo barato; si el voto es claro se actúa sin gastar un turno caro, y si se divide decide el líder como siempre.", "The model writes, the decider decides, the code acts. Closed choices (retry or escalate, where something goes) are voted on by a cheap model; a clear vote is acted on without paying for an expensive turn, a split one goes to the lead as always.")}
      leading={<span className="grid h-10 w-10 place-items-center rounded-[12px] bg-[color-mix(in_oklab,var(--cf-violet)_14%,var(--cf-surface))] text-[var(--cf-violet)]"><Brain className="h-5 w-5" /></span>}
      onClose={close}
      footer={
        <>
          <Btn icon={Sparkles} onClick={() => void test()} disabled={trying} title={l("Hace una votación de prueba con estos ajustes", "Runs a test vote with these settings")}>{trying ? l("Votando…", "Voting…") : l("Probar", "Try it")}</Btn>
          {verdict && (
            <span className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <Chip tone={verdict.sharp ? "ok" : "warn"} title={verdict.sharp ? l("El voto fue claro: se actúa sin gastar un turno caro", "The vote was clear: acted on without an expensive turn") : l("El voto se dividió: decide el líder", "The vote split: the lead decides")}>{verdict.sharp ? l("claro", "sharp") : l("dividido", "split")}</Chip>
              <span>{verdict.choice ?? "—"} · p = {verdict.p.toFixed(2)} · {verdict.source} · {verdict.ms} ms</span>
            </span>
          )}
          <span className="flex-1" />
          <Btn kind="ghost" onClick={close} title={l("Cierra sin guardar cambios", "Closes without saving")}>{l("Cancelar", "Cancel")}</Btn>
          <Btn kind="primary" onClick={() => void save()} title={l("Guarda la capa de decisión", "Saves the decision layer")}>{l("Guardar", "Save")}</Btn>
        </>
      }
    >
      <Switch checked={config.enabled} onChange={(enabled) => patch({ enabled })} label={l("Activada", "On")} hint={l("Apagada, todo lo decide el líder como antes.", "Off, the lead decides everything as before.")} />
      <div className="flex flex-col gap-1.5">
        <Label>{l("Quién vota", "Who votes")}</Label>
        <Seg
          value={config.engine}
          onChange={(engine) => patch({ engine })}
          options={[
            { value: "auto", label: l("Automático", "Automatic"), icon: Sparkles, title: l("Local si hay uno descargado; si no, el modelo rápido", "Local if one is downloaded; otherwise the fast model") },
            { value: "local", label: l("Modelo local", "Local model"), icon: Cpu, title: l("Vota con un modelo en tu máquina, gratis", "Votes with a model on your machine, free") },
            { value: "cloud", label: l("Modelo rápido", "Fast model"), icon: Brain, title: l("Vota con el modelo barato de tu proveedor", "Votes with your provider's cheap model") },
            { value: "off", label: l("Nadie", "Nobody"), title: l("Nadie vota: decide siempre el líder", "Nobody votes: the lead always decides") },
          ]}
        />
        <p className="m-0 text-[12px] text-[var(--cf-text-muted)]">
          {l(
            "Automático usa el modelo local si tienes uno descargado (gratis, en tu máquina) y si no el modelo rápido de tu proveedor (Haiku en Claude). Los modelos locales se descargan solo si tú quieres, desde Ajustes › Modelos locales.",
            "Automatic uses the local model if you downloaded one (free, on your machine), else your provider's fast model (Haiku on Claude). Local models are downloaded only if you want, from Settings › Local models.",
          )}
        </p>
        <div>
          <Btn small title={l("Abre Ajustes para descargar modelos locales", "Opens Settings to download local models")} onClick={() => { close(); useUiStore.setState({ settingsOpen: true }); }}>{l("Abrir Ajustes", "Open Settings")}</Btn>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label>{l("Votos por decisión", "Votes per decision")}</Label>
          <Stepper value={config.forks} min={1} max={9} onChange={(forks) => patch({ forks })} label="forks" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{l("Claro a partir de", "Sharp from")}</Label>
          <input title={l("Probabilidad mínima para que un voto cuente como claro", "Minimum probability for a vote to count as sharp")} type="range" min={0.5} max={1} step={0.05} value={config.threshold} onChange={(e) => patch({ threshold: Number(e.target.value) })} className="accent-[var(--cf-accent)]" />
          <span className="text-[12px] tabular-nums">p ≥ {config.threshold.toFixed(2)}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{l("Si hay riesgo", "When risky")}</Label>
          <input title={l("Probabilidad exigida cuando la decisión tiene riesgo", "Probability required when the decision is risky")} type="range" min={config.threshold} max={1} step={0.01} value={config.risk_threshold} onChange={(e) => patch({ risk_threshold: Number(e.target.value) })} className="accent-[var(--cf-accent)]" />
          <span className="text-[12px] tabular-nums">p ≥ {config.risk_threshold.toFixed(2)}</span>
        </div>
      </div>
    </Modal>
  );
}
