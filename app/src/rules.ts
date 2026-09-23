import type { Config, Decision, Measure } from './types'

// UI feedback only; the Python validator is authoritative for every API call.
export function unavailableReason(measure: Measure, district: string, decisions: Decision[], config: Config): string | null {
  if (decisions.some(d => d.measure_id === measure.id)) return 'Уже в плане'
  if (decisions.length >= config.decision_count) return 'Все пять решений выбраны'
  const selected = decisions.map(d => config.measures.find(m => m.id === d.measure_id)!)
  if (selected.reduce((s, m) => s + m.cost, 0) + measure.cost > config.budget) return 'Недостаточно бюджета'
  if (selected.filter(m => m.category === measure.category).length >= config.max_per_category) return 'В этом направлении уже две меры'
  for (const conflict of config.incompatibilities) {
    if (!conflict.pair.includes(measure.id)) continue
    const other = decisions.find(d => conflict.pair.includes(d.measure_id))
    if (other && (conflict.scope === 'city' || other.district_id === district)) return conflict.reason
  }
  return null
}
