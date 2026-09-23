export type Decision = { measure_id: string; district_id: string | null }
export type Category = { id: string; name: string; color: string }
export type Metric = { id: string; name: string; category: string; weight: number }
export type Measure = { id: string; category: string; name: string; scope: 'city' | 'district'; cost: number; lag: number; effects: Record<string, number> }
export type District = { id: string; name: string; population_share: number; center: [number, number]; profile: string; indicators: Record<string, number> }
export type DistrictResult = { id: string; name: string; score: number; indicators: Record<string, number>; deltas: Record<string, number>; category_scores: Record<string, number> }
export type CityResult = { score: number; average: number; minimum: number; weakest_district_id: string; critical: {district_id: string; metric_id: string; value: number}[]; districts: DistrictResult[]; synergies: {pair: string[]; effects: Record<string, number>; district_id: string}[] }
export type Suggestion = { id: string; remove: Decision; add: Decision; score: number; score_delta: number; spent: number; decisions: Decision[] }
export type Result = CityResult & {baseline_score: number; score_delta: number; spent: number; remaining: number; decisions: Decision[]; contributions: (Decision & {score_delta: number})[]; suggestions: Suggestion[]; dataset_version: string}
export type Simulation = { valid: boolean; score: number | null; errors: string[]; result: Result | null }
export type Config = {
  version: string; budget: number; horizon: number; decision_count: number; max_per_category: number; critical_threshold: number;
  categories: Category[]; metrics: Metric[]; districts: District[]; measures: Measure[];
  incompatibilities: {pair: string[]; scope: 'city' | 'district'; reason: string}[];
  synergies: {pair: string[]; effects: Record<string, number>}[];
  baseline: CityResult; example: Decision[];
}
export type Explanation = {mode: 'rules' | 'llm'; notice: string; facts: Record<string, string>; report: {summary: string; strengths: {text: string; fact_ids: string[]}[]; risks: {text: string; fact_ids: string[]}[]; recommendation_ids: string[]}}
