import { bandColor, diverging, loadingBand, median, symmetricExtent, type Theme } from "./colors";
import { fmt, type EffectiveNetwork } from "./edits";
import type { CompareResponse, LabelOptions, ViewMode } from "./types";

export interface NodeStyle {
  color: string;
  size: number;
  shape: "ellipse" | "round-rectangle";
  noLmp: boolean;
  label: string;
}

export interface EdgeStyle {
  color: string;
  width: number;
  arrowT: "triangle" | "none";
  arrowS: "triangle" | "none";
  out: boolean;
  label: string;
}

export interface Encoding {
  nodes: Map<number, NodeStyle>;
  edges: Map<string, EdgeStyle>;
  legend:
    | { view: "values"; lmpCenter: number; lmpExtent: number }
    | { view: "delta"; lmpExtent: number; flowExtent: number };
}

const MIN_W = 1.5;
const MAX_EXTRA_W = 5;

export function encode(
  net: EffectiveNetwork,
  result: CompareResponse | null,
  view: ViewMode,
  theme: Theme,
  labels: LabelOptions,
): Encoding {
  const nodes = new Map<number, NodeStyle>();
  const edges = new Map<string, EdgeStyle>();
  const scenario = result?.scenario;

  // ---- nodes
  const buses = [...net.buses.values()];
  const lmps = scenario ? buses.map((b) => scenario.lmps[String(b.bus_id)]) : [];
  const lmpCenter = median(lmps);
  const lmpExtent = symmetricExtent(lmps.map((v) => (v == null ? null : v - lmpCenter)), 0.5);
  const lmpDelta = new Map(result?.diff.lmps.map((d) => [d.bus_id, d.delta]) ?? []);
  const deltaExtent = symmetricExtent([...lmpDelta.values()], 0.1);

  for (const bus of buses) {
    const gens = net.gensByBus.get(bus.bus_id) ?? [];
    const hasGen = gens.some((g) => g.in_service && g.p_max_mw > 0);
    const lmp = scenario?.lmps[String(bus.bus_id)] ?? null;
    let color = theme.divMid;
    if (scenario && lmp != null) {
      if (view === "values") color = diverging((lmp - lmpCenter) / lmpExtent, theme);
      else color = diverging((lmpDelta.get(bus.bus_id) ?? 0) / deltaExtent, theme);
    }
    nodes.set(bus.bus_id, {
      color: lmp == null && scenario ? theme.surface : color,
      size: hasGen ? 17 : 13,
      shape: hasGen ? "round-rectangle" : "ellipse",
      noLmp: scenario != null && lmp == null,
      label: labels.buses ? busLabel(bus.bus_id, bus.load_mw, gens.length ? gens : null, scenario) : String(bus.bus_id),
    });
  }

  // ---- edges
  const flows = new Map(scenario?.line_flows.map((f) => [f.branch_id, f]) ?? []);
  const flowDelta = new Map(result?.diff.flows.map((d) => [d.branch_id, d.delta_abs_mw ?? 0]) ?? []);
  const maxFlow = symmetricExtent([...flows.values()].map((f) => f.flow_mw), 1);
  const flowExtent = symmetricExtent([...flowDelta.values()], 1);

  for (const br of net.branches.values()) {
    const f = flows.get(br.branch_id);
    const out = !br.in_service;
    const flow = f?.flow_mw ?? 0;
    const forward = flow > 1e-6;
    const reverse = flow < -1e-6;

    let color = theme.lineNeutral;
    let width = MIN_W;
    if (f && view === "values") {
      color = out ? theme.muted : bandColor(loadingBand(f.loading_percent), theme);
      width = MIN_W + MAX_EXTRA_W * Math.sqrt(Math.abs(flow) / maxFlow);
    } else if (f && view === "delta") {
      const d = flowDelta.get(br.branch_id) ?? 0;
      color = diverging(d / flowExtent, theme);
      width = MIN_W + MAX_EXTRA_W * Math.sqrt(Math.abs(d) / flowExtent);
    }
    edges.set(br.branch_id, {
      color,
      width: out ? MIN_W : width,
      arrowT: !out && forward ? "triangle" : "none",
      arrowS: !out && reverse ? "triangle" : "none",
      out,
      label: labels.lines ? lineLabel(br.branch_id, out, f && !out ? flow : null, view === "delta" ? flowDelta.get(br.branch_id) : undefined) : "",
    });
  }

  return {
    nodes,
    edges,
    legend:
      view === "values"
        ? { view, lmpCenter, lmpExtent }
        : { view, lmpExtent: deltaExtent, flowExtent },
  };
}

function busLabel(
  busId: number,
  loadMw: number,
  gens: { generator_id: string; in_service: boolean }[] | null,
  scenario: CompareResponse["scenario"] | undefined,
): string {
  const lines = [String(busId)];
  if (Math.abs(loadMw) > 0.05) lines.push(`load ${fmt(loadMw, 0)} MW`);
  if (gens) {
    const gen = scenario
      ? gens.reduce((sum, g) => sum + (scenario.generation_mw[g.generator_id] ?? 0), 0)
      : null;
    lines.push(gen == null ? "gen —" : `gen ${fmt(gen, 0)} MW`);
  }
  return lines.join(String.fromCharCode(10)); // one label line each: ID, load, generation
}

function lineLabel(branchId: string, out: boolean, flowMw: number | null, deltaMw: number | undefined): string {
  if (out) return `${branchId} · out`;
  if (flowMw == null) return branchId;
  let text = `${branchId} · ${fmt(Math.abs(flowMw), 0)} MW`;
  if (deltaMw != null && Math.abs(deltaMw) >= 0.5) text += ` (${deltaMw > 0 ? "+" : "−"}${fmt(Math.abs(deltaMw), 0)})`;
  return text;
}
