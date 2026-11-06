import { useEffect, useState, type ReactNode } from "react";

import { bandColor, diverging, LOADING_BANDS, loadingBand, type Theme } from "../colors";
import { describeEdit, fmt, type EffectiveNetwork } from "../edits";
import type { Encoding } from "../encoding";
import type {
  CompareResponse,
  ContingencyResponse,
  Edit,
  SavedScenario,
  Selection,
  ViewMode,
} from "../types";

// ------------------------------------------------------------------ primitives

export function Panel({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{title}</h2>
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** Number input that commits on Enter or blur, not on every keystroke. */
export function NumField({
  label,
  value,
  unit,
  onCommit,
  min,
  step = "any",
  disabled,
}: {
  label: string;
  value: number | null;
  unit?: string;
  onCommit: (v: number) => void;
  min?: number;
  step?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value == null ? "" : String(round(value)));
  useEffect(() => setText(value == null ? "" : String(round(value))), [value]);

  const commit = () => {
    const v = Number(text);
    if (text.trim() === "" || !Number.isFinite(v) || (min != null && v < min)) {
      setText(value == null ? "" : String(round(value)));
      return;
    }
    if (value == null || Math.abs(v - value) > 1e-9) onCommit(v);
  };

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input
          type="number"
          inputMode="decimal"
          value={text}
          step={step}
          min={min}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
        {unit && <span className="field-unit">{unit}</span>}
      </span>
    </label>
  );
}

const round = (v: number) => Math.round(v * 1000) / 1000;

function Stat({ value, label, tone }: { value: string; label: string; tone?: "up" | "down" }) {
  return (
    <div className="stat">
      <div className={`stat-value ${tone ?? ""}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

const money = (v: number) => `$${fmt(v, 0)}`;
const signed = (v: number, digits = 2) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${fmt(Math.abs(v), digits)}`;

// ------------------------------------------------------------------ summary

export function SummaryPanel({
  result,
  hasEdits,
  onSelect,
}: {
  result: CompareResponse | null;
  hasEdits: boolean;
  onSelect: (s: Selection) => void;
}) {
  if (!result) return null;
  const s = result.scenario;
  const lmps = Object.values(s.lmps).filter((v): v is number => v != null);
  const delta = result.diff.total_cost_delta;
  return (
    <Panel title="System">
      <div className="stats">
        <Stat value={`${money(s.total_cost)}/h`} label="Production cost" />
        {hasEdits && (
          <Stat
            value={`${delta >= 0 ? "+" : "−"}${money(Math.abs(delta))}/h`}
            label="vs base case"
            tone={delta > 0.5 ? "up" : delta < -0.5 ? "down" : undefined}
          />
        )}
        <Stat value={`$${fmt(Math.min(...lmps), 2)} – ${fmt(Math.max(...lmps), 2)}`} label="LMP range, $/MWh" />
        {s.n_islands > 1 && <Stat value={String(s.n_islands)} label="Islands" />}
      </div>

      <h3 className="subhead">
        Binding lines <span className="count">{s.binding_constraints.length}</span>
      </h3>
      {s.binding_constraints.length === 0 ? (
        <p className="muted">No congestion: every bus has the same price.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Line</th>
              <th className="num">Flow / limit</th>
              <th className="num">Shadow price</th>
            </tr>
          </thead>
          <tbody>
            {s.binding_constraints.map((c) => (
              <tr key={c.branch_id} className="clickable" onClick={() => onSelect({ kind: "branch", id: c.branch_id })}>
                <td>
                  {c.branch_id} <span className="muted">{c.from_bus}–{c.to_bus}</span>
                </td>
                <td className="num">
                  {fmt(Math.abs(c.flow_mw), 0)} / {fmt(c.limit_mw, 0)}
                </td>
                <td className="num">${fmt(c.shadow_price, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ inspector

type RemoveAdded = (kind: "bus" | "generator" | "branch", id: string | number) => void;

export function Inspector({
  selection,
  net,
  result,
  onEdit,
  onAddGenerator,
  onRemoveAdded,
  onClose,
}: {
  selection: Selection;
  net: EffectiveNetwork;
  result: CompareResponse | null;
  onEdit: (e: Edit) => void;
  onAddGenerator: (busId: number) => void;
  onRemoveAdded: RemoveAdded;
  onClose: () => void;
}) {
  if (!selection) {
    return (
      <Panel title="Inspector">
        <p className="muted">
          Click a bus or line to see its values and edit it. Use <strong>+ Bus</strong> and <strong>+ Line</strong> on the
          diagram to add new ones.
        </p>
      </Panel>
    );
  }
  const close = (
    <button className="link-btn" onClick={onClose} aria-label="Clear selection">
      Close
    </button>
  );
  return selection.kind === "bus" ? (
    <BusInspector
      busId={selection.id}
      net={net}
      result={result}
      onEdit={onEdit}
      onAddGenerator={onAddGenerator}
      onRemoveAdded={onRemoveAdded}
      actions={close}
    />
  ) : (
    <BranchInspector
      branchId={selection.id}
      net={net}
      result={result}
      onEdit={onEdit}
      onRemoveAdded={onRemoveAdded}
      actions={close}
    />
  );
}

function BusInspector({
  busId,
  net,
  result,
  onEdit,
  onAddGenerator,
  onRemoveAdded,
  actions,
}: {
  busId: number;
  net: EffectiveNetwork;
  result: CompareResponse | null;
  onEdit: (e: Edit) => void;
  onAddGenerator: (busId: number) => void;
  onRemoveAdded: RemoveAdded;
  actions: ReactNode;
}) {
  const bus = net.buses.get(busId);
  if (!bus) return null;
  const key = String(busId);
  const s = result?.scenario;
  const lmp = s?.lmps[key];
  const energy = s?.lmp_energy[key];
  const congestion = s?.lmp_congestion[key];
  const dLmp = result?.diff.lmps.find((d) => d.bus_id === busId)?.delta;
  const gens = net.gensByBus.get(busId) ?? [];
  const isNew = net.added.buses.has(busId);
  const connected = [...net.branches.values()].some((b) => b.from_bus === busId || b.to_bus === busId);

  return (
    <Panel title={`Bus ${busId}${bus.name ? ` · ${bus.name}` : ""}`} actions={actions}>
      <p className="muted small">
        {isNew ? "Added in this scenario" : `Area ${bus.area}`}
        {bus.base_kv ? ` · ${bus.base_kv} kV` : ""}
        {bus.bus_type === 3 ? " · reference bus" : ""}
      </p>
      {isNew && !connected && (
        <p className="callout">Not connected yet. Use <strong>+ Line</strong> to tie it into the network.</p>
      )}
      <div className="stats">
        <Stat value={lmp == null ? "—" : `$${fmt(lmp, 2)}`} label="LMP, $/MWh" />
        {dLmp != null && Math.abs(dLmp) > 0.005 && <Stat value={signed(dLmp)} label="vs base" />}
      </div>
      {lmp != null && energy != null && congestion != null && (
        <p className="muted small">
          Energy ${fmt(energy, 2)} + congestion {signed(congestion)}
        </p>
      )}
      {lmp == null && s && <p className="muted small">Islanded without generation: price undefined.</p>}

      <NumField
        label="Load"
        unit="MW"
        value={bus.load_mw}
        onCommit={(v) => onEdit({ op: "set_load", bus_id: busId, load_mw: v })}
      />

      {gens.length > 0 && <h3 className="subhead">Generators</h3>}
      {gens.map((g) => {
        const p = s?.generation_mw[g.generator_id] ?? 0;
        return (
          <div className="gen" key={g.generator_id}>
            <div className="gen-head">
              <strong>{g.generator_id}</strong>
              {net.added.generators.has(g.generator_id) && (
                <button className="link-btn" onClick={() => onRemoveAdded("generator", g.generator_id)}>
                  Remove
                </button>
              )}
              <span className="muted">
                {g.in_service ? `${fmt(p, 1)} of ${fmt(g.p_max_mw, 0)} MW` : "offline"}
              </span>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={g.in_service}
                  onChange={(e) =>
                    onEdit({ op: "set_generator", generator_id: g.generator_id, in_service: e.target.checked })
                  }
                />
                In service
              </label>
            </div>
            <div className="field-row">
              <NumField
                label="Pmax"
                unit="MW"
                min={0}
                value={g.p_max_mw}
                disabled={!g.in_service}
                onCommit={(v) => onEdit({ op: "set_generator", generator_id: g.generator_id, p_max_mw: v })}
              />
              <NumField
                label="Offer"
                unit="$/MWh"
                value={g.offer_price}
                disabled={!g.in_service}
                onCommit={(v) => onEdit({ op: "set_generator", generator_id: g.generator_id, offer_price: v })}
              />
            </div>
            {g.cost_c2 > 0 && <p className="muted small">Plus quadratic term {g.cost_c2} $/MW²h</p>}
          </div>
        );
      })}

      <div className="button-row">
        <button className="btn" onClick={() => onAddGenerator(busId)}>
          Add generator
        </button>
        {isNew && (
          <button className="btn danger" onClick={() => onRemoveAdded("bus", busId)}>
            Remove bus
          </button>
        )}
      </div>
    </Panel>
  );
}

function BranchInspector({
  branchId,
  net,
  result,
  onEdit,
  onRemoveAdded,
  actions,
}: {
  branchId: string;
  net: EffectiveNetwork;
  result: CompareResponse | null;
  onEdit: (e: Edit) => void;
  onRemoveAdded: RemoveAdded;
  actions: ReactNode;
}) {
  const br = net.branches.get(branchId);
  if (!br) return null;
  const f = result?.scenario.line_flows.find((x) => x.branch_id === branchId);
  const d = result?.diff.flows.find((x) => x.branch_id === branchId);
  const binding = result?.scenario.binding_constraints.find((c) => c.branch_id === branchId);
  const band = loadingBand(f?.loading_percent ?? null);
  const flow = f?.flow_mw ?? 0;
  const dir = flow >= 0 ? `${br.from_bus} → ${br.to_bus}` : `${br.to_bus} → ${br.from_bus}`;

  return (
    <Panel title={`Line ${branchId} · ${br.from_bus}–${br.to_bus}`} actions={actions}>
      {br.tap_ratio !== 1 && <p className="muted small">Transformer, tap {br.tap_ratio}</p>}
      {net.added.branches.has(branchId) && <p className="muted small">Added in this scenario</p>}
      <div className="stats">
        <Stat value={br.in_service ? `${fmt(Math.abs(flow), 1)} MW` : "Out"} label={br.in_service ? `Flow ${dir}` : "Out of service"} />
        {f?.loading_percent != null && br.in_service && (
          <Stat value={`${fmt(f.loading_percent, 0)}%`} label={band.label.split(" (")[0]} />
        )}
        {d?.delta_abs_mw != null && Math.abs(d.delta_abs_mw) > 0.05 && <Stat value={signed(d.delta_abs_mw, 1)} label="MW of flow vs base" />}
      </div>
      {binding && (
        <p className="callout">
          Binding. Each extra MW of capacity would save <strong>${fmt(binding.shadow_price, 2)}/h</strong>.
        </p>
      )}

      <div className="button-row">
        <button
          className={br.in_service ? "btn danger" : "btn"}
          onClick={() => onEdit({ op: "set_branch_status", branch_id: branchId, in_service: !br.in_service })}
        >
          {br.in_service ? "Trip line" : "Restore line"}
        </button>
        {net.added.branches.has(branchId) && (
          <button className="btn" onClick={() => onRemoveAdded("branch", branchId)}>
            Remove line
          </button>
        )}
      </div>

      <div className="field-row">
        <NumField
          label="Limit"
          unit="MW"
          min={0.001}
          value={br.limit_mw}
          disabled={br.limit_mw == null}
          onCommit={(v) => onEdit({ op: "set_branch_params", branch_id: branchId, limit_mw: v })}
        />
        <NumField
          label="Reactance"
          unit="pu"
          value={br.reactance_pu}
          onCommit={(v) => v !== 0 && onEdit({ op: "set_branch_params", branch_id: branchId, reactance_pu: v })}
        />
      </div>
      <label className="toggle">
        <input
          type="checkbox"
          checked={br.limit_mw == null}
          onChange={(e) =>
            onEdit(
              e.target.checked
                ? { op: "set_branch_params", branch_id: branchId, unlimited: true }
                : { op: "set_branch_params", branch_id: branchId, limit_mw: f?.limit_mw ?? Math.max(1, Math.abs(flow)), unlimited: false },
            )
          }
        />
        Unlimited capacity
      </label>
    </Panel>
  );
}

// ------------------------------------------------------------------ edits

export function EditsPanel({
  edits,
  errorIndex,
  saved,
  onRemove,
  onClear,
  onAdd,
  onSave,
  onLoad,
  onDelete,
}: {
  edits: Edit[];
  errorIndex: number | null;
  saved: SavedScenario[];
  onRemove: (i: number) => void;
  onClear: () => void;
  onAdd: (e: Edit) => void;
  onSave: (name: string) => void;
  onLoad: (s: SavedScenario) => void;
  onDelete: (s: SavedScenario) => void;
}) {
  const [name, setName] = useState("");
  return (
    <Panel
      title={`Scenario edits${edits.length ? ` (${edits.length})` : ""}`}
      actions={
        edits.length > 0 && (
          <>
            <button className="link-btn" onClick={() => onRemove(edits.length - 1)} title="Undo (Ctrl+Z)">
              Undo
            </button>
            <button className="link-btn" onClick={onClear}>
              Reset
            </button>
          </>
        )
      }
    >
      {edits.length === 0 ? (
        <p className="muted">Base case. Edits you make appear here, in order.</p>
      ) : (
        <ol className="edit-list">
          {edits.map((e, i) => (
            <li key={i} className={i === errorIndex ? "error" : ""}>
              <span>{describeEdit(e)}</span>
              <button className="x-btn" onClick={() => onRemove(i)} aria-label={`Remove edit ${i + 1}`}>
                ×
              </button>
            </li>
          ))}
        </ol>
      )}

      <NumField
        label="Scale all load (multiplier)"
        unit="× current"
        min={0}
        value={1}
        onCommit={(v) => v !== 1 && onAdd({ op: "scale_load", factor: v })}
      />

      <form
        className="save-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) {
            onSave(name.trim());
            setName("");
          }
        }}
      >
        <input placeholder="Scenario name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" type="submit" disabled={!name.trim() || edits.length === 0}>
          Save
        </button>
      </form>

      {saved.length > 0 && (
        <>
          <h3 className="subhead">Saved</h3>
          <ul className="saved-list">
            {saved.map((s) => (
              <li key={s.id}>
                <button className="link-btn" onClick={() => onLoad(s)}>
                  {s.scenario.name ?? "Untitled"}
                </button>
                <span className="muted small">{s.scenario.edits.length} edits</span>
                <button className="x-btn" onClick={() => onDelete(s)} aria-label={`Delete ${s.scenario.name}`}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ changes vs base

export function ChangesPanel({ result, onSelect }: { result: CompareResponse; onSelect: (s: Selection) => void }) {
  const { diff } = result;
  const lmpRows = diff.top_lmp_changes.filter((r) => r.delta != null && Math.abs(r.delta) > 0.005);
  const flowRows = diff.top_flow_changes.filter((r) => r.delta_abs_mw != null && Math.abs(r.delta_abs_mw) > 0.05);
  return (
    <Panel title="Biggest changes vs base">
      {diff.newly_binding.length > 0 && (
        <p className="small">
          Now binding: <strong>{diff.newly_binding.join(", ")}</strong>
        </p>
      )}
      {diff.no_longer_binding.length > 0 && (
        <p className="small">
          No longer binding: <strong>{diff.no_longer_binding.join(", ")}</strong>
        </p>
      )}
      <div className="two-col">
        <table className="table">
          <thead>
            <tr>
              <th>Bus</th>
              <th className="num">ΔLMP</th>
            </tr>
          </thead>
          <tbody>
            {lmpRows.map((r) => (
              <tr key={r.bus_id} className="clickable" onClick={() => onSelect({ kind: "bus", id: r.bus_id })}>
                <td>{r.bus_id}</td>
                <td className="num">{signed(r.delta!)}</td>
              </tr>
            ))}
            {lmpRows.length === 0 && (
              <tr>
                <td colSpan={2} className="muted">
                  No price changes
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <table className="table">
          <thead>
            <tr>
              <th>Line</th>
              <th className="num">Δ|flow| MW</th>
            </tr>
          </thead>
          <tbody>
            {flowRows.map((r) => (
              <tr key={r.branch_id} className="clickable" onClick={() => onSelect({ kind: "branch", id: r.branch_id })}>
                <td>{r.branch_id}</td>
                <td className="num">{signed(r.delta_abs_mw!, 1)}</td>
              </tr>
            ))}
            {flowRows.length === 0 && (
              <tr>
                <td colSpan={2} className="muted">
                  No flow changes
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ N-1

export function ContingencyPanel({
  data,
  running,
  active,
  onRun,
  onPick,
}: {
  data: ContingencyResponse | null;
  running: boolean;
  active: string | null;
  onRun: () => void;
  onPick: (outage: string | null, worst: string | null) => void;
}) {
  const rows = data?.contingencies.slice(0, 12) ?? [];
  return (
    <Panel
      title="N-1 contingencies"
      actions={
        <button className="btn small" onClick={onRun} disabled={running}>
          {running ? "Running…" : data ? "Re-run" : "Run N-1"}
        </button>
      }
    >
      {!data && (
        <p className="muted">
          Trips each line in turn, with dispatch held fixed, and reports the worst overloads.
        </p>
      )}
      {data && (
        <>
          <p className="small">
            <strong>{data.n_violating}</strong> of {data.contingencies.length} outages overload a line
            {data.islanding_outages.length > 0 && (
              <span className="muted"> · {data.islanding_outages.length} radial lines skipped</span>
            )}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Outage</th>
                <th>Worst line</th>
                <th className="num">Loading</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.outage_branch_id}
                  className={`clickable ${active === c.outage_branch_id ? "active" : ""}`}
                  onClick={() =>
                    active === c.outage_branch_id
                      ? onPick(null, null)
                      : onPick(c.outage_branch_id, c.worst_branch_id)
                  }
                >
                  <td>{c.outage_branch_id}</td>
                  <td>{c.worst_branch_id ?? "—"}</td>
                  <td className="num">
                    {c.max_loading_percent == null ? "—" : `${fmt(c.max_loading_percent, 0)}%`}
                    {c.max_loading_percent != null && c.max_loading_percent > data.overload_threshold_percent && (
                      <span className="status-chip critical" aria-label="overload">
                        ▲
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ legend

export function Legend({ encoding, theme, view }: { encoding: Encoding; theme: Theme; view: ViewMode }) {
  const [open, setOpen] = useState(true);
  if (!open) {
    return (
      <button className="legend legend-collapsed" onClick={() => setOpen(true)}>
        Show legend
      </button>
    );
  }
  const ramp = Array.from({ length: 11 }, (_, i) => diverging(-1 + i / 5, theme));
  const gradient = `linear-gradient(to right, ${ramp.join(", ")})`;
  const lg = encoding.legend;

  return (
    <div className="legend" aria-label="Legend">
      {view === "values" ? (
        <>
          <div className="legend-group">
            <div className="legend-title">Line loading</div>
            {LOADING_BANDS.map((b) => (
              <div className="legend-item" key={b.key}>
                <span className="legend-line" style={{ background: bandColor(b, theme) }} />
                {b.label}
              </div>
            ))}
            <div className="legend-item">
              <span className="legend-line dashed" style={{ borderColor: theme.muted }} />
              Out of service
            </div>
          </div>
          {lg.view === "values" && (
            <div className="legend-group">
              <div className="legend-title">LMP, $/MWh</div>
              <div className="legend-ramp" style={{ background: gradient }} />
              <div className="legend-ticks">
                <span>{fmt(lg.lmpCenter - lg.lmpExtent, 2)}</span>
                <span>{fmt(lg.lmpCenter, 2)} median</span>
                <span>{fmt(lg.lmpCenter + lg.lmpExtent, 2)}</span>
              </div>
            </div>
          )}
        </>
      ) : (
        lg.view === "delta" && (
          <>
            <div className="legend-group">
              <div className="legend-title">Change in |flow|, MW</div>
              <div className="legend-ramp" style={{ background: gradient }} />
              <div className="legend-ticks">
                <span>−{fmt(lg.flowExtent, 0)}</span>
                <span>0</span>
                <span>+{fmt(lg.flowExtent, 0)}</span>
              </div>
            </div>
            <div className="legend-group">
              <div className="legend-title">Change in LMP, $/MWh</div>
              <div className="legend-ramp" style={{ background: gradient }} />
              <div className="legend-ticks">
                <span>−{fmt(lg.lmpExtent, 2)}</span>
                <span>0</span>
                <span>+{fmt(lg.lmpExtent, 2)}</span>
              </div>
            </div>
          </>
        )
      )}
      <div className="legend-group">
        <div className="legend-item">
          <span className="legend-shape square" /> Generator bus
        </div>
        <div className="legend-item">
          <span className="legend-shape" /> Load bus
        </div>
        <div className="legend-item muted small">Line width ∝ {view === "values" ? "flow" : "change"}</div>
        <button className="link-btn legend-hide" onClick={() => setOpen(false)}>
          Hide legend
        </button>
      </div>
    </div>
  );
}
