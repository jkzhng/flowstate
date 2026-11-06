import type { Branch, Bus, CaseData, Edit, Generator } from "./types";

type EditOf<K extends Edit["op"]> = Extract<Edit, { op: K }>;

/** Identity of the element an edit targets; two edits with the same key collapse into one. */
function editKey(e: Edit): string | null {
  switch (e.op) {
    case "set_branch_status":
      return `status:${e.branch_id}`;
    case "set_branch_params":
      return `params:${e.branch_id}`;
    case "set_load":
      return `load:${e.bus_id}`;
    case "set_generator":
      return `gen:${e.generator_id}`;
    case "scale_load":
      return null; // multiplicative: each one stacks
    case "add_branch":
    case "add_bus":
    case "add_generator":
      return null;
  }
}

/**
 * Edits to an element that this scenario added are folded into the edit that added it, so
 * "add bus 119" + "bus 119 load → 40" shows as one entry and removing it removes everything.
 */
function foldIntoAdd(edits: Edit[], edit: Edit): Edit[] | null {
  const at = (pred: (e: Edit) => boolean) => edits.findIndex(pred);
  const replace = (i: number, e: Edit) => edits.map((x, j) => (j === i ? e : x));

  if (edit.op === "set_load") {
    const i = at((e) => e.op === "add_bus" && e.bus_id === edit.bus_id);
    if (i >= 0) return replace(i, { ...(edits[i] as EditOf<"add_bus">), load_mw: edit.load_mw });
  }
  if (edit.op === "set_generator") {
    const i = at((e) => e.op === "add_generator" && e.generator_id === edit.generator_id);
    if (i >= 0) {
      const g = { ...(edits[i] as EditOf<"add_generator">) };
      if (edit.in_service != null) g.in_service = edit.in_service;
      if (edit.p_max_mw != null) g.p_max_mw = edit.p_max_mw;
      if (edit.p_min_mw != null) g.p_min_mw = edit.p_min_mw;
      if (edit.offer_price != null) g.offer_price = edit.offer_price;
      return replace(i, g);
    }
  }
  if (edit.op === "set_branch_params") {
    const i = at((e) => e.op === "add_branch" && e.branch_id === edit.branch_id);
    if (i >= 0) {
      const b = { ...(edits[i] as EditOf<"add_branch">) };
      if (edit.reactance_pu != null) b.reactance_pu = edit.reactance_pu;
      if (edit.unlimited) delete b.limit_mw;
      else if (edit.limit_mw != null) b.limit_mw = edit.limit_mw;
      return replace(i, b);
    }
  }
  return null;
}

/**
 * Add an edit, merging with any earlier edit on the same element. Edits that put an element
 * back to its base-case value are dropped, so the list only shows real changes.
 */
export function upsertEdit(edits: Edit[], edit: Edit, base: CaseData): Edit[] {
  const folded = foldIntoAdd(edits, edit);
  if (folded) return folded;

  const key = editKey(edit);
  let merged: Edit = edit;
  let index = -1;
  if (key) {
    index = edits.findIndex((e) => editKey(e) === key);
    if (index >= 0 && (edit.op === "set_generator" || edit.op === "set_branch_params")) {
      merged = { ...edits[index], ...edit } as Edit;
      if (edit.op === "set_branch_params" && edit.limit_mw != null) {
        (merged as EditOf<"set_branch_params">).unlimited = false;
      }
    }
  }
  const noop = isNoop(merged, base);
  const next = edits.slice();
  if (index >= 0) {
    if (noop) next.splice(index, 1);
    else next[index] = merged;
  } else if (!noop) {
    next.push(merged);
  }
  return next;
}

/** Remove edit `index` plus any later edits that only make sense with it (lines to a removed bus, ...). */
export function removeEdit(edits: Edit[], index: number): Edit[] {
  const deadBuses = new Set<number>();
  const deadGens = new Set<string>();
  const deadBranches = new Set<string>();
  const kill = (e: Edit) => {
    if (e.op === "add_bus") deadBuses.add(e.bus_id);
    if (e.op === "add_generator") deadGens.add(e.generator_id);
    if (e.op === "add_branch" && e.branch_id) deadBranches.add(e.branch_id);
  };
  kill(edits[index]);
  return edits.filter((e, i) => {
    if (i === index) return false;
    if (i < index) return true;
    const dependent =
      ((e.op === "add_branch") && (deadBuses.has(e.from_bus) || deadBuses.has(e.to_bus))) ||
      ((e.op === "add_generator" || e.op === "set_load") && deadBuses.has(e.bus_id)) ||
      (e.op === "set_generator" && deadGens.has(e.generator_id)) ||
      ((e.op === "set_branch_status" || e.op === "set_branch_params") && deadBranches.has(e.branch_id));
    if (dependent) kill(e);
    return !dependent;
  });
}

/** The same edits without diagram positions, so dragging a new bus doesn't trigger a re-solve. */
export function solverEdits(edits: Edit[]): Edit[] {
  return edits.map((e) => {
    if (e.op !== "add_bus") return e;
    const { x: _x, y: _y, ...rest } = e;
    return rest;
  });
}

function isNoop(e: Edit, base: CaseData): boolean {
  switch (e.op) {
    case "set_branch_status":
      return findBranch(base, e.branch_id)?.in_service === e.in_service;
    case "set_load": {
      const bus = base.buses.find((b) => b.bus_id === e.bus_id);
      return bus != null && Math.abs(bus.load_mw - e.load_mw) < 1e-9;
    }
    case "set_generator": {
      const g = base.generators.find((x) => x.generator_id === e.generator_id);
      if (!g) return false;
      return (
        (e.in_service == null || e.in_service === g.in_service) &&
        (e.p_min_mw == null || e.p_min_mw === g.p_min_mw) &&
        (e.p_max_mw == null || e.p_max_mw === g.p_max_mw) &&
        (e.offer_price == null || e.offer_price === g.offer_price)
      );
    }
    case "set_branch_params": {
      const br = findBranch(base, e.branch_id);
      if (!br) return false;
      const limitSame = e.unlimited
        ? br.limit_mw == null
        : e.limit_mw == null || e.limit_mw === br.limit_mw;
      return limitSame && (e.reactance_pu == null || e.reactance_pu === br.reactance_pu);
    }
    case "scale_load":
      return e.factor === 1;
    default:
      return false;
  }
}

const findBranch = (c: CaseData, id: string) => c.branches.find((b) => b.branch_id === id);

export interface EffectiveNetwork {
  buses: Map<number, Bus>;
  generators: Map<string, Generator>;
  branches: Map<string, Branch>;
  gensByBus: Map<number, Generator[]>;
  /** Elements that exist only because this scenario added them. */
  added: { buses: Set<number>; generators: Set<string>; branches: Set<string> };
}

/** Client-side mirror of src/scenario.py's apply_scenario, used only for display. */
export function applyEdits(base: CaseData, edits: Edit[]): EffectiveNetwork {
  const buses = new Map(base.buses.map((b) => [b.bus_id, { ...b }]));
  const generators = new Map(base.generators.map((g) => [g.generator_id, { ...g }]));
  const branches = new Map(base.branches.map((b) => [b.branch_id, { ...b }]));
  const added = { buses: new Set<number>(), generators: new Set<string>(), branches: new Set<string>() };
  for (const e of edits) {
    switch (e.op) {
      case "set_branch_status": {
        const br = branches.get(e.branch_id);
        if (br) br.in_service = e.in_service;
        break;
      }
      case "set_branch_params": {
        const br = branches.get(e.branch_id);
        if (!br) break;
        if (e.reactance_pu != null) br.reactance_pu = e.reactance_pu;
        if (e.unlimited) br.limit_mw = null;
        else if (e.limit_mw != null) br.limit_mw = e.limit_mw;
        break;
      }
      case "set_load": {
        const bus = buses.get(e.bus_id);
        if (bus) bus.load_mw = e.load_mw;
        break;
      }
      case "scale_load":
        for (const bus of buses.values()) if (e.area == null || bus.area === e.area) bus.load_mw *= e.factor;
        break;
      case "set_generator": {
        const g = generators.get(e.generator_id);
        if (!g) break;
        if (e.in_service != null) g.in_service = e.in_service;
        if (e.p_min_mw != null) g.p_min_mw = e.p_min_mw;
        if (e.p_max_mw != null) g.p_max_mw = e.p_max_mw;
        if (e.offer_price != null) g.offer_price = e.offer_price;
        break;
      }
      case "add_bus":
        buses.set(e.bus_id, {
          bus_id: e.bus_id,
          load_mw: e.load_mw,
          name: e.name ?? null,
          bus_type: 1,
          shunt_mw: 0,
          area: e.area ?? 1,
          base_kv: 0,
          x: e.x ?? null,
          y: e.y ?? null,
        });
        added.buses.add(e.bus_id);
        break;
      case "add_generator":
        generators.set(e.generator_id, {
          generator_id: e.generator_id,
          bus_id: e.bus_id,
          p_min_mw: e.p_min_mw ?? 0,
          p_max_mw: e.p_max_mw,
          offer_price: e.offer_price,
          cost_c2: 0,
          cost_c0: 0,
          p_mw: 0,
          in_service: e.in_service ?? true,
        });
        added.generators.add(e.generator_id);
        break;
      case "add_branch": {
        if (!e.branch_id) break; // the UI always assigns IDs
        branches.set(e.branch_id, {
          branch_id: e.branch_id,
          from_bus: e.from_bus,
          to_bus: e.to_bus,
          reactance_pu: e.reactance_pu,
          limit_mw: e.limit_mw ?? null,
          in_service: true,
          resistance_pu: 0,
          tap_ratio: 1,
          phase_shift_deg: 0,
        });
        added.branches.add(e.branch_id);
        break;
      }
    }
  }
  const gensByBus = new Map<number, Generator[]>();
  for (const g of generators.values()) {
    const list = gensByBus.get(g.bus_id) ?? [];
    list.push(g);
    gensByBus.set(g.bus_id, list);
  }
  return { buses, generators, branches, gensByBus, added };
}

// ------------------------------------------------------------------ new-element defaults

const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function nextBusId(net: EffectiveNetwork): number {
  return Math.max(0, ...net.buses.keys()) + 1;
}

function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let n = used.size + 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** A new line between two buses, with the case's typical reactance and rating. */
export function newBranch(net: EffectiveNetwork, from: number, to: number): EditOf<"add_branch"> {
  const all = [...net.branches.values()];
  const x = median(all.map((b) => Math.abs(b.reactance_pu)).filter((v) => v > 0));
  const limit = median(all.map((b) => b.limit_mw).filter((v): v is number => v != null));
  return {
    op: "add_branch",
    branch_id: nextId("L", net.branches.keys()),
    from_bus: from,
    to_bus: to,
    reactance_pu: Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : 0.1,
    ...(Number.isFinite(limit) ? { limit_mw: Math.round(limit) } : {}),
  };
}

/** A new generator offering at the case's median price. */
export function newGenerator(net: EffectiveNetwork, busId: number): EditOf<"add_generator"> {
  // ignore zero-capacity units (synchronous condensers) that would drag the median to $0
  const offer = median([...net.generators.values()].filter((g) => g.p_max_mw > 0).map((g) => g.offer_price));
  return {
    op: "add_generator",
    generator_id: nextId("G", net.generators.keys()),
    bus_id: busId,
    p_max_mw: 100,
    offer_price: Number.isFinite(offer) ? Math.round(offer * 100) / 100 : 20,
  };
}

// ------------------------------------------------------------------ text

export function describeEdit(e: Edit): string {
  switch (e.op) {
    case "set_branch_status":
      return `${e.in_service ? "Restore" : "Trip"} line ${e.branch_id}`;
    case "set_branch_params": {
      const parts: string[] = [];
      if (e.unlimited) parts.push("limit → unlimited");
      else if (e.limit_mw != null) parts.push(`limit → ${fmt(e.limit_mw)} MW`);
      if (e.reactance_pu != null) parts.push(`x → ${e.reactance_pu} pu`);
      return `Line ${e.branch_id}: ${parts.join(", ")}`;
    }
    case "set_load":
      return `Bus ${e.bus_id} load → ${fmt(e.load_mw)} MW`;
    case "scale_load":
      return `Scale ${e.area == null ? "all" : `area ${e.area}`} load ×${e.factor}`;
    case "set_generator": {
      const parts: string[] = [];
      if (e.in_service != null) parts.push(e.in_service ? "in service" : "offline");
      if (e.p_max_mw != null) parts.push(`Pmax → ${fmt(e.p_max_mw)} MW`);
      if (e.p_min_mw != null) parts.push(`Pmin → ${fmt(e.p_min_mw)} MW`);
      if (e.offer_price != null) parts.push(`offer → $${e.offer_price}/MWh`);
      return `${e.generator_id}: ${parts.join(", ")}`;
    }
    case "add_branch":
      return `Add line ${e.branch_id ?? ""} ${e.from_bus}–${e.to_bus} (x ${e.reactance_pu} pu, ${
        e.limit_mw == null ? "unlimited" : `${fmt(e.limit_mw)} MW`
      })`;
    case "add_bus":
      return `Add bus ${e.bus_id}${e.load_mw ? ` with ${fmt(e.load_mw)} MW load` : ""}`;
    case "add_generator":
      return `Add ${e.generator_id} at bus ${e.bus_id}: ${fmt(e.p_max_mw)} MW at $${e.offer_price}/MWh${
        e.in_service === false ? ", offline" : ""
      }`;
  }
}

export const fmt = (v: number, digits = 1) =>
  // tiny solver noise like -1e-9 would otherwise print as "-0"
  (Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
