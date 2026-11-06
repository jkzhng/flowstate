import type {
  CaseData,
  CaseSummary,
  CompareResponse,
  ContingencyResponse,
  Positions,
  SavedScenario,
  Scenario,
} from "./types";

const BASE = "/api";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public kind?: string,
    public editIndex?: number | null,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.detail;
    if (detail && typeof detail === "object" && "message" in detail) {
      throw new ApiError(detail.message, res.status, detail.kind, detail.edit_index);
    }
    const message = Array.isArray(detail)
      ? detail.map((d: { msg: string }) => d.msg).join("; ")
      : String(detail ?? res.statusText);
    throw new ApiError(message, res.status);
  }
  return body as T;
}

const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body), signal });

export const api = {
  cases: () => request<CaseSummary[]>("/cases"),
  case: (id: string) => request<CaseData>(`/cases/${id}`),
  saveLayout: (id: string, positions: Positions) =>
    request(`/cases/${id}/layout`, { method: "PUT", body: JSON.stringify({ positions }) }),
  compare: (scenario: Scenario, signal?: AbortSignal) =>
    post<CompareResponse>("/compare", { scenario, top_n: 8 }, signal),
  contingency: (scenario: Scenario, signal?: AbortSignal) =>
    post<ContingencyResponse>("/contingency", { scenario }, signal),
  scenarios: (baseCase: string) => request<SavedScenario[]>(`/scenarios?base_case=${encodeURIComponent(baseCase)}`),
  saveScenario: (scenario: Scenario) => post<SavedScenario>("/scenarios", scenario),
  deleteScenario: (id: string) => request<void>(`/scenarios/${id}`, { method: "DELETE" }),
};
