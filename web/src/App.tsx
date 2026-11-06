import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError } from "./api";
import { DARK, LIGHT, loadingBand, type Theme } from "./colors";
import {
  applyEdits,
  fmt,
  newBranch,
  newGenerator,
  nextBusId,
  removeEdit as removeEditAt,
  solverEdits,
  upsertEdit,
} from "./edits";
import { encode } from "./encoding";
import { NetworkView, type TooltipContent } from "./components/NetworkView";
import {
  ChangesPanel,
  ContingencyPanel,
  EditsPanel,
  Inspector,
  Legend,
  SummaryPanel,
} from "./components/Panels";
import type {
  CaseData,
  CaseSummary,
  CompareResponse,
  ContingencyResponse,
  Edit,
  LabelOptions,
  Positions,
  SavedScenario,
  Selection,
  Tool,
  ViewMode,
} from "./types";

const CASE_KEY = "flowstate.case";
const LABELS_KEY = "flowstate.labels";

function storedLabels(): LabelOptions {
  try {
    const v = JSON.parse(localStorage.getItem(LABELS_KEY) ?? "null");
    if (v && typeof v.buses === "boolean" && typeof v.lines === "boolean") return v;
  } catch {
    /* storage unavailable or corrupt */
  }
  return { buses: false, lines: false };
}

function storedCase(): string {
  try {
    return localStorage.getItem(CASE_KEY) ?? "case118";
  } catch {
    return "case118";
  }
}

function useTheme(): Theme {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark ? DARK : LIGHT;
}

const TOOLS: [Tool, string, string][] = [
  ["select", "Select", "Select and drag buses and lines"],
  ["add-bus", "+ Bus", "Click empty space to add a bus"],
  ["add-line", "+ Line", "Click two buses to connect them"],
];

export default function App() {
  const theme = useTheme();
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [caseId, setCaseId] = useState(storedCase);
  const [caseData, setCaseData] = useState<CaseData | null>(null);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<{ message: string; editIndex: number | null } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [view, setView] = useState<ViewMode>("values");
  const [contingency, setContingency] = useState<ContingencyResponse | null>(null);
  const [runningN1, setRunningN1] = useState(false);
  const [highlight, setHighlight] = useState<{ outage: string | null; worst: string | null }>({
    outage: null,
    worst: null,
  });
  const [saved, setSaved] = useState<SavedScenario[]>([]);
  const [relayoutToken, setRelayoutToken] = useState(0);
  const [labels, setLabels] = useState<LabelOptions>(storedLabels);
  const [tool, setTool] = useState<Tool>("select");
  const [pendingBus, setPendingBus] = useState<number | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(LABELS_KEY, JSON.stringify(labels));
    } catch {
      /* fine */
    }
  }, [labels]);

  const pickTool = (t: Tool) => {
    setTool(t);
    setPendingBus(null);
  };

  // ---- load the case list once
  useEffect(() => {
    api
      .cases()
      .then(setCases)
      .catch((e) => setFatal(`Cannot reach the API (${e.message}). Is the backend running on port 8100?`));
  }, []);

  // ---- load a case
  useEffect(() => {
    let cancelled = false;
    setCaseData(null);
    setResult(null);
    setEdits([]);
    setSelection(null);
    setContingency(null);
    setHighlight({ outage: null, worst: null });
    setError(null);
    setTool("select");
    setPendingBus(null);
    try {
      localStorage.setItem(CASE_KEY, caseId);
    } catch {
      /* storage unavailable: fine */
    }
    api
      .case(caseId)
      .then((c) => !cancelled && setCaseData(c))
      .catch((e) => !cancelled && setFatal(e.message));
    api
      .scenarios(caseId)
      .then((s) => !cancelled && setSaved(s))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  // ---- re-solve whenever the edits change (moving a new bus around doesn't count)
  const solveKey = JSON.stringify(solverEdits(edits));
  const toSolve = useMemo(() => JSON.parse(solveKey) as Edit[], [solveKey]);
  useEffect(() => {
    if (!caseData) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setSolving(true);
      api
        .compare({ base_case: caseData.id, edits: toSolve }, ctrl.signal)
        .then((r) => {
          setResult(r);
          setError(null);
        })
        .catch((e) => {
          if (ctrl.signal.aborted) return;
          if (e instanceof ApiError) setError({ message: e.message, editIndex: e.editIndex ?? null });
          else setError({ message: String(e.message ?? e), editIndex: null });
        })
        .finally(() => !ctrl.signal.aborted && setSolving(false));
    }, 120);
    setContingency(null);
    setHighlight({ outage: null, worst: null });
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [caseData, toSolve]);

  const net = useMemo(() => (caseData ? applyEdits(caseData, edits) : null), [caseData, edits]);
  const encoding = useMemo(
    () => (caseData && net ? encode(net, result, view, theme, labels) : null),
    [caseData, net, result, view, theme, labels],
  );

  // ---- edits
  const addEdit = useCallback(
    (e: Edit) => caseData && setEdits((prev) => upsertEdit(prev, e, caseData)),
    [caseData],
  );
  const removeEdit = useCallback((i: number) => setEdits((prev) => removeEditAt(prev, i)), []);

  /** Remove a bus, generator or line that this scenario added (and everything attached to it). */
  const removeAdded = useCallback((kind: "bus" | "generator" | "branch", id: string | number) => {
    setEdits((prev) => {
      const i = prev.findIndex(
        (e) =>
          (kind === "bus" && e.op === "add_bus" && e.bus_id === id) ||
          (kind === "generator" && e.op === "add_generator" && e.generator_id === id) ||
          (kind === "branch" && e.op === "add_branch" && e.branch_id === id),
      );
      return i >= 0 ? removeEditAt(prev, i) : prev;
    });
    if (kind !== "generator") setSelection(null);
  }, []);

  // ---- clicks on the diagram, depending on the active tool
  const onTap = useCallback(
    (target: Selection, pos: { x: number; y: number }) => {
      if (!net || !caseData) return;
      if (tool === "add-bus") {
        if (target) return setSelection(target);
        const id = nextBusId(net);
        addEdit({ op: "add_bus", bus_id: id, load_mw: 0, x: Math.round(pos.x), y: Math.round(pos.y) });
        setSelection({ kind: "bus", id });
        return;
      }
      if (tool === "add-line") {
        if (target?.kind !== "bus") return;
        if (pendingBus == null || pendingBus === target.id) return setPendingBus(target.id);
        const edit = newBranch(net, pendingBus, target.id);
        addEdit(edit);
        setSelection({ kind: "branch", id: edit.branch_id! });
        setPendingBus(null);
        return;
      }
      setSelection(target);
    },
    [net, caseData, tool, pendingBus, addEdit],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea, select");
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        setEdits((prev) => prev.slice(0, -1));
      } else if (e.key === "Escape") {
        setTool("select");
        setPendingBus(null);
        setSelection(null);
        setHighlight({ outage: null, worst: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- layout persistence (debounced)
  const layoutTimer = useRef<number | undefined>(undefined);
  const savePositions = useCallback(
    (p: Positions) => {
      if (!caseData) return;
      const id = caseData.id;
      // Base-case buses go to the case's saved layout. Buses this scenario added keep their
      // position in their add_bus edit, so it travels with the scenario.
      const baseIds = new Set(caseData.buses.map((b) => String(b.bus_id)));
      const basePositions: Positions = {};
      for (const [k, v] of Object.entries(p)) if (baseIds.has(k)) basePositions[k] = v;
      setEdits((prev) => {
        let changed = false;
        const next = prev.map((e) => {
          const q = e.op === "add_bus" ? p[String(e.bus_id)] : undefined;
          if (e.op !== "add_bus" || !q || (Math.round(q.x) === e.x && Math.round(q.y) === e.y)) return e;
          changed = true;
          return { ...e, x: Math.round(q.x), y: Math.round(q.y) };
        });
        return changed ? next : prev;
      });
      window.clearTimeout(layoutTimer.current);
      layoutTimer.current = window.setTimeout(() => api.saveLayout(id, basePositions).catch(() => undefined), 600);
    },
    [caseData],
  );

  // ---- N-1
  const runN1 = () => {
    if (!caseData) return;
    setRunningN1(true);
    api
      .contingency({ base_case: caseData.id, edits: toSolve })
      .then(setContingency)
      .catch((e) => setError({ message: e.message, editIndex: null }))
      .finally(() => setRunningN1(false));
  };

  // ---- saved scenarios
  const saveScenario = (name: string) => {
    if (!caseData) return;
    api
      .saveScenario({ base_case: caseData.id, edits, name })
      .then((s) => setSaved((prev) => [s, ...prev]))
      .catch((e) => setError({ message: e.message, editIndex: null }));
  };
  const deleteScenario = (s: SavedScenario) =>
    api.deleteScenario(s.id).then(() => setSaved((prev) => prev.filter((x) => x.id !== s.id)));

  // ---- tooltip text
  const describe = useCallback(
    (sel: NonNullable<Selection>): TooltipContent | null => {
      if (!net) return null;
      const s = result?.scenario;
      if (sel.kind === "bus") {
        const bus = net.buses.get(sel.id);
        if (!bus) return null;
        const key = String(sel.id);
        const lmp = s?.lmps[key];
        const gen = (net.gensByBus.get(sel.id) ?? []).reduce(
          (sum, g) => sum + (s?.generation_mw[g.generator_id] ?? 0),
          0,
        );
        const rows = [
          { value: lmp == null ? "—" : `$${fmt(lmp, 2)}`, label: "LMP $/MWh" },
          { value: `${fmt(bus.load_mw, 1)} MW`, label: "load" },
        ];
        if (net.gensByBus.has(sel.id)) rows.push({ value: `${fmt(gen, 1)} MW`, label: "generation" });
        const d = result?.diff.lmps.find((x) => x.bus_id === sel.id)?.delta;
        if (d != null && Math.abs(d) > 0.005) rows.push({ value: `${d > 0 ? "+" : "−"}$${fmt(Math.abs(d), 2)}`, label: "LMP vs base" });
        return { title: `Bus ${sel.id}${bus.name ? ` · ${bus.name}` : ""}`, rows };
      }
      const br = net.branches.get(sel.id);
      const f = s?.line_flows.find((x) => x.branch_id === sel.id);
      if (!br) return null;
      if (!br.in_service) return { title: `Line ${sel.id} · ${br.from_bus}–${br.to_bus}`, rows: [{ value: "Out", label: "of service" }] };
      const rows = [{ value: `${fmt(Math.abs(f?.flow_mw ?? 0), 1)} MW`, label: "flow" }];
      if (f?.limit_mw != null) {
        rows.push({ value: `${fmt(f.loading_percent ?? 0, 0)}%`, label: `of ${fmt(f.limit_mw, 0)} MW · ${loadingBand(f.loading_percent).label.split(" (")[0].toLowerCase()}` });
      } else rows.push({ value: "∞", label: "no limit" });
      const d = result?.diff.flows.find((x) => x.branch_id === sel.id)?.delta_abs_mw;
      if (d != null && Math.abs(d) > 0.05) rows.push({ value: `${d > 0 ? "+" : "−"}${fmt(Math.abs(d), 1)} MW`, label: "flow vs base" });
      return { title: `Line ${sel.id} · ${br.from_bus}–${br.to_bus}`, rows };
    },
    [net, result],
  );

  const selectFromList = (s: Selection) => setSelection(s);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Flowstate</div>
        <label className="select">
          <span className="sr-only">Case</span>
          <select value={caseId} onChange={(e) => setCaseId(e.target.value)}>
            {cases.length === 0 && <option value={caseId}>{caseId}</option>}
            {cases.map((c) => (
              <option key={c.id} value={c.id}>
                IEEE {c.n_buses}-bus · {c.n_branches} lines
              </option>
            ))}
          </select>
        </label>
        <div className="segmented" role="radiogroup" aria-label="View">
          {(["values", "delta"] as ViewMode[]).map((v) => (
            <button
              key={v}
              role="radio"
              aria-checked={view === v}
              className={view === v ? "on" : ""}
              onClick={() => setView(v)}
            >
              {v === "values" ? "Flows & prices" : "Change vs base"}
            </button>
          ))}
        </div>
        <div className="label-toggles" role="group" aria-label="Labels">
          <span className="muted small">Labels</span>
          {(["buses", "lines"] as const).map((k) => (
            <button
              key={k}
              className={`chip ${labels[k] ? "on" : ""}`}
              aria-pressed={labels[k]}
              title={k === "buses" ? "Show load and generation at each bus" : "Show line ID and flow on each line"}
              onClick={() => setLabels((l) => ({ ...l, [k]: !l[k] }))}
            >
              {k === "buses" ? "Buses" : "Lines"}
            </button>
          ))}
        </div>
        <button className="btn ghost" onClick={() => setRelayoutToken((t) => t + 1)} disabled={!caseData}>
          Re-layout
        </button>
        <div className={`solve-state ${solving ? "busy" : ""}`} aria-live="polite">
          {solving ? "Solving…" : result ? `DC-OPF · ${result.scenario.status}` : ""}
        </div>
      </header>

      <main className="main">
        <div className="graph-pane">
          {fatal && <div className="banner error">{fatal}</div>}
          {error && (
            <div className="banner error" role="alert">
              <strong>{error.editIndex != null ? `Edit ${error.editIndex + 1} is invalid.` : "No feasible dispatch."}</strong>{" "}
              {error.message}
              {result && <span className="muted"> Showing the last solvable state.</span>}
              {edits.length > 0 && (
                <button className="link-btn" onClick={() => setEdits((p) => p.slice(0, -1))}>
                  Undo last edit
                </button>
              )}
            </div>
          )}
          {caseData && encoding ? (
            <>
              <NetworkView
                caseData={caseData}
                net={net!}
                encoding={encoding}
                theme={theme}
                selection={selection}
                highlight={highlight}
                relayoutToken={relayoutToken}
                tool={tool}
                pendingBus={pendingBus}
                describe={describe}
                onTap={onTap}
                onPositionsChange={savePositions}
              />
              <div className="tool-strip">
              <div className="tool-bar segmented" role="radiogroup" aria-label="Diagram tool">
                {TOOLS.map(([t, text, title]) => (
                  <button
                    key={t}
                    role="radio"
                    aria-checked={tool === t}
                    className={tool === t ? "on" : ""}
                    title={title}
                    onClick={() => pickTool(t)}
                  >
                    {text}
                  </button>
                ))}
              </div>
              {tool !== "select" && (
                <div className="tool-hint" role="status">
                  {tool === "add-bus"
                    ? "Click empty space to place a new bus."
                    : pendingBus == null
                      ? "Click the bus the new line starts at."
                      : `From bus ${pendingBus}: click the bus it ends at.`}
                  <button className="link-btn" onClick={() => pickTool("select")}>
                    Done (Esc)
                  </button>
                </div>
              )}
              </div>
              <Legend encoding={encoding} theme={theme} view={view} />
            </>
          ) : (
            !fatal && <div className="loading">Loading {caseId}…</div>
          )}
        </div>

        <aside className="sidebar">
          <SummaryPanel result={result} hasEdits={edits.length > 0} onSelect={selectFromList} />
          {net && (
            <Inspector
              selection={selection}
              net={net}
              result={result}
              onEdit={addEdit}
              onAddGenerator={(busId) => addEdit(newGenerator(net, busId))}
              onRemoveAdded={removeAdded}
              onClose={() => setSelection(null)}
            />
          )}
          <EditsPanel
            edits={edits}
            errorIndex={error?.editIndex ?? null}
            saved={saved}
            onRemove={removeEdit}
            onClear={() => setEdits([])}
            onAdd={addEdit}
            onSave={saveScenario}
            onLoad={(s) => setEdits(s.scenario.edits)}
            onDelete={deleteScenario}
          />
          {result && edits.length > 0 && <ChangesPanel result={result} onSelect={selectFromList} />}
          <ContingencyPanel
            data={contingency}
            running={runningN1}
            active={highlight.outage}
            onRun={runN1}
            onPick={(outage, worst) => {
              setHighlight({ outage, worst });
              if (worst) setSelection({ kind: "branch", id: worst });
            }}
          />
        </aside>
      </main>
    </div>
  );
}
