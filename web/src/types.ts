// Mirrors the FastAPI responses in src/api/app.py

export interface CaseSummary {
  id: string;
  file: string;
  n_buses: number;
  n_generators: number;
  n_branches: number;
}

export interface Bus {
  bus_id: number;
  load_mw: number;
  name: string | null;
  bus_type: number;
  shunt_mw: number;
  area: number;
  base_kv: number;
  x?: number | null;
  y?: number | null;
}

export interface Generator {
  generator_id: string;
  bus_id: number;
  p_min_mw: number;
  p_max_mw: number;
  offer_price: number;
  cost_c2: number;
  cost_c0: number;
  p_mw: number;
  in_service: boolean;
}

export interface Branch {
  branch_id: string;
  from_bus: number;
  to_bus: number;
  reactance_pu: number;
  limit_mw: number | null; // null = unlimited
  in_service: boolean;
  resistance_pu: number;
  tap_ratio: number;
  phase_shift_deg: number;
}

export type Positions = Record<string, { x: number; y: number }>;

export interface CaseData {
  id: string;
  name: string;
  base_mva: number;
  reference_bus_id: number;
  buses: Bus[];
  generators: Generator[];
  branches: Branch[];
  layout: Positions | null;
}

export interface LineFlow {
  branch_id: string;
  from_bus: number;
  to_bus: number;
  in_service: boolean;
  flow_mw: number;
  limit_mw: number | null;
  loading_percent: number | null;
  is_overloaded: boolean;
}

export interface BindingConstraint {
  branch_id: string;
  from_bus: number;
  to_bus: number;
  direction: "forward" | "reverse";
  flow_mw: number;
  limit_mw: number;
  shadow_price: number;
}

export interface OpfResult {
  status: string;
  total_cost: number;
  generation_mw: Record<string, number>;
  line_flows: LineFlow[];
  lmps: Record<string, number | null>;
  lmp_energy: Record<string, number | null>;
  lmp_congestion: Record<string, number | null>;
  binding_constraints: BindingConstraint[];
  n_islands: number;
}

export interface FlowDelta {
  branch_id: string;
  before_mw: number | null;
  after_mw: number;
  delta_mw: number | null;
  delta_abs_mw: number | null; // change in |flow|
  before_loading_percent: number | null;
  after_loading_percent: number | null;
  added: boolean;
}

export interface LmpDelta {
  bus_id: number;
  before: number | null;
  after: number | null;
  delta: number | null;
}

export interface Diff {
  flows: FlowDelta[];
  lmps: LmpDelta[];
  top_flow_changes: FlowDelta[];
  top_lmp_changes: LmpDelta[];
  total_cost_delta: number;
  newly_binding: string[];
  no_longer_binding: string[];
}

export interface CompareResponse {
  base: OpfResult;
  scenario: OpfResult;
  diff: Diff;
}

export type Edit =
  | { op: "set_branch_status"; branch_id: string; in_service: boolean }
  | { op: "set_branch_params"; branch_id: string; reactance_pu?: number; limit_mw?: number; unlimited?: boolean }
  | { op: "add_branch"; from_bus: number; to_bus: number; reactance_pu: number; limit_mw?: number; branch_id?: string }
  | {
      op: "add_bus";
      bus_id: number;
      load_mw: number;
      area?: number;
      name?: string;
      x?: number;
      y?: number;
    }
  | {
      op: "add_generator";
      generator_id: string;
      bus_id: number;
      p_max_mw: number;
      p_min_mw?: number;
      offer_price: number;
      in_service?: boolean;
    }
  | { op: "set_load"; bus_id: number; load_mw: number }
  | { op: "scale_load"; factor: number; area?: number }
  | {
      op: "set_generator";
      generator_id: string;
      in_service?: boolean;
      p_min_mw?: number;
      p_max_mw?: number;
      offer_price?: number;
    };

export interface Scenario {
  base_case: string;
  edits: Edit[];
  name?: string | null;
}

export interface SavedScenario {
  id: string;
  created_at: string;
  updated_at: string;
  scenario: Scenario;
}

export interface Contingency {
  outage_branch_id: string;
  max_loading_percent: number | null;
  worst_branch_id: string | null;
  overloads: { branch_id: string; flow_mw: number; limit_mw: number; loading_percent: number }[];
}

export interface ContingencyResponse {
  contingencies: Contingency[];
  islanding_outages: string[];
  n_violating: number;
  overload_threshold_percent: number;
}

export type Selection = { kind: "bus"; id: number } | { kind: "branch"; id: string } | null;

export type ViewMode = "values" | "delta";

export type Tool = "select" | "add-bus" | "add-line";

export interface LabelOptions {
  buses: boolean;
  lines: boolean;
}
