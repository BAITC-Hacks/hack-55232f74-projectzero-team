import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Building2,
  BusFront,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  GraduationCap,
  Leaf,
  MapPin,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Wallet,
  Wrench,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { CityMap } from './CityMap'
import { request } from './api'
import { unavailableReason } from './rules'
import type { Config, Decision, Explanation, Result, Simulation } from './types'

const GameView = lazy(() => import('./traffic/GameView'))

const icons: Record<string, LucideIcon> = {
  transport: BusFront,
  ecology: Leaf,
  social: GraduationCap,
  safety: ShieldCheck,
  services: Wrench,
}
const number = (n: number, digits = 2) =>
  n.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const signed = (n: number) => `${n >= 0 ? '+' : ''}${number(n)}`

export default function App() {
  const [config, setConfig] = useState<Config | null>(null)
  const [loadError, setLoadError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    request<Config>('config', undefined, controller.signal)
      .then(setConfig)
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(error.message)
      })
    return () => controller.abort()
  }, [])
  if (!config)
    return (
      <div className="loading-screen">
        <Building2 size={44} />
        <h1>Аким на 5 часов</h1>
        <p>{loadError || 'Готовим город к вашим решениям…'}</p>
        {loadError && (
          <button className="primary" onClick={() => window.location.reload()}>
            Повторить загрузку
          </button>
        )}
      </div>
    )
  return <Simulator config={config} />
}

function Simulator({ config }: { config: Config }) {
  const [view, setView] = useState<'city' | 'analytics'>('city')
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [district, setDistrict] = useState('nura')
  const [category, setCategory] = useState('all')
  const [layer, setLayer] = useState('overall')
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [analysis, setAnalysis] = useState<Explanation | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const analysisController = useRef<AbortController | null>(null)
  const reportRef = useRef<HTMLElement>(null)
  const city = result || config.baseline
  const spent = decisions.reduce(
    (sum, decision) => sum + config.measures.find((m) => m.id === decision.measure_id)!.cost,
    0,
  )
  const selectedDistrict = config.districts.find((d) => d.id === district)!
  const districtResult = city.districts.find((d) => d.id === district)!

  function update(next: Decision[]) {
    analysisController.current?.abort()
    setAnalyzing(false)
    setAnalysis(null)
    setResult(null)
    setError('')
    setDecisions(next)
  }

  useEffect(() => {
    if (decisions.length !== config.decision_count) {
      setBusy(false)
      return
    }
    const controller = new AbortController()
    setBusy(true)
    request<Simulation>('simulate', { decisions }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return
        setResult(response.result)
        setError(response.errors.join(' '))
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [decisions, config.decision_count])

  useEffect(() => () => analysisController.current?.abort(), [])

  async function analyze() {
    if (!result) return
    const controller = new AbortController()
    analysisController.current?.abort()
    analysisController.current = controller
    setAnalyzing(true)
    setError('')
    try {
      const explanation = await request<Explanation>('analyze', { decisions }, controller.signal)
      if (!controller.signal.aborted) {
        setAnalysis(explanation)
        setTimeout(
          () => reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
          100,
        )
      }
    } catch (err) {
      if (!controller.signal.aborted)
        setError(err instanceof Error ? err.message : 'Не удалось получить объяснение.')
    } finally {
      if (!controller.signal.aborted) setAnalyzing(false)
    }
  }

  function exportResult() {
    const blob = new Blob(
      [JSON.stringify({ dataset_version: config.version, decisions, result, analysis }, null, 2)],
      { type: 'application/json' },
    )
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'astana-scenario.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <>
      <header className={`header ${view === 'city' ? 'game-header' : ''}`}>
        <a className="brand" href="/" aria-label="Аким на 5 часов — главная">
          <span className="brand-symbol">
            <Building2 size={25} />
          </span>
          <span>
            Аким <em>на 5 часов</em>
            <small>PROJECTZERO · ASTANA INNOVATIONS</small>
          </span>
        </a>
        <nav>
          <button
            className={`view-switch ${view === 'city' ? 'nav-active' : ''}`}
            onClick={() => setView('city')}
          >
            <Building2 size={17} /> 3D-город
          </button>
          <button
            className={`view-switch ${view === 'analytics' ? 'nav-active' : ''}`}
            onClick={() => setView('analytics')}
          >
            <BarChart3 size={17} /> Аналитика и карта
          </button>
          <button onClick={() => setRulesOpen(true)}>
            <CircleHelp size={17} /> Как это работает
          </button>
        </nav>
        <span className="header-badge">
          <span /> HACKALEM AI
        </span>
      </header>
      {view === 'city' ? (
        <Suspense
          fallback={
            <div className="loading-screen">
              <Building2 size={44} />
              <p>Строим трёхмерный город…</p>
            </div>
          }
        >
          <GameView
            config={config}
            decisions={decisions}
            district={district}
            city={city}
            hasResult={Boolean(result)}
            busy={busy}
            analyzing={analyzing}
            error={error}
            onDecisions={update}
            onDistrict={setDistrict}
            onAnalytics={() => setView('analytics')}
            onAnalyze={() => {
              setView('analytics')
              void analyze()
            }}
          />
        </Suspense>
      ) : (
        <main className="page">
          <section className="intro">
            <div>
              <div className="eyebrow">
                <span className="tiny-line" /> ВАШ ГОРОД. ВАШИ РЕШЕНИЯ.
              </div>
              <h1>
                Большие перемены.
                <br />
                <span>Пять решений.</span>
              </h1>
              <p>Распределите бюджет и сделайте Астану лучше для каждого района.</p>
            </div>
            <div className="intro-aside">
              <span className="pill">
                <Clock3 size={15} /> Горизонт: 2 условных года
              </span>
              <p>
                У каждого решения есть цена.
                <br />У каждого района — свой приоритет.
              </p>
              <button className="text-button" onClick={() => update(config.example)}>
                Загрузить пример сценария <ArrowUpRight size={17} />
              </button>
            </div>
          </section>
          <section className="stats" aria-label="Показатели сценария">
            <div className="stat score-stat">
              <div className="stat-label">
                <BarChart3 size={17} /> Astana Quality of Life
              </div>
              <div className="stat-value" data-testid="city-score">
                {number(city.score)}
                <span>/ 100</span>
                {result && <b className="growth">{signed(result.score_delta)}</b>}
              </div>
              <small>{result ? 'Итог после пяти решений' : 'Базовый Score · до решений'}</small>
            </div>
            <div className="stat">
              <div className="stat-label">
                <Wallet size={17} /> Осталось бюджета
              </div>
              <div className="stat-value" data-testid="remaining-budget">
                {config.budget - spent}
                <span>из {config.budget} ед.</span>
              </div>
              <div className="budget-track">
                <span style={{ width: `${(spent / config.budget) * 100}%` }} />
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">
                <Check size={17} /> Принято решений
              </div>
              <div className="stat-value" data-testid="decision-count">
                {decisions.length}
                <span>/ {config.decision_count}</span>
              </div>
              <div className="decision-dots">
                {Array.from({ length: 5 }, (_, i) => (
                  <span key={i} className={i < decisions.length ? 'filled' : ''} />
                ))}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">
                <ShieldCheck size={17} /> Критические показатели
              </div>
              <div className="stat-value">
                {city.critical.length}
                <span>ниже {config.critical_threshold}</span>
              </div>
              <small>
                {result && !city.critical.length
                  ? 'Все критические дефициты устранены'
                  : 'Каждый отнимает один балл Score'}
              </small>
            </div>
          </section>

          <div className="workspace">
            <div className="main-column">
              <CityMap
                config={config}
                city={city}
                selected={district}
                onSelect={setDistrict}
                decisions={decisions}
                layer={layer}
                setLayer={setLayer}
              />
              <section className="district-card">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">РАЙОН В ФОКУСЕ</span>
                    <h2>
                      <MapPin size={19} /> {selectedDistrict.name}
                    </h2>
                  </div>
                  <span className="population">
                    {Math.round(selectedDistrict.population_share * 100)}% населения
                  </span>
                </div>
                <p className="district-profile">{selectedDistrict.profile}</p>
                <div className="indicator-grid">
                  {config.metrics.map((metric) => {
                    const value = districtResult.indicators[metric.id]
                    const delta = districtResult.deltas[metric.id]
                    return (
                      <div className="indicator" key={metric.id}>
                        <div>
                          <span title={metric.name}>{metric.name}</span>
                          <strong className={value < 40 ? 'critical-text' : ''}>
                            {number(value, value % 1 ? 1 : 0)}
                            {delta !== 0 && (
                              <em>
                                {delta > 0 ? '+' : ''}
                                {number(delta, 1)}
                              </em>
                            )}
                          </strong>
                        </div>
                        <div className="indicator-track">
                          <span
                            style={{
                              width: `${value}%`,
                              background:
                                value < 40
                                  ? '#d87553'
                                  : config.categories.find((c) => c.id === metric.category)!.color,
                            }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
                <small className="muted">
                  {result
                    ? 'Показатели после реализации выбранного сценария.'
                    : 'Исходные показатели. Итог появится после выбора пяти мер.'}
                </small>
              </section>

              <section className="catalog" aria-label="Каталог мероприятий">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">ОТ ИДЕИ К ДЕЙСТВИЮ</span>
                    <h2>Инвестиции в город</h2>
                  </div>
                  <span className="count-badge">14 инициатив</span>
                </div>
                <div className="category-tabs">
                  <button
                    className={category === 'all' ? 'active' : ''}
                    onClick={() => setCategory('all')}
                  >
                    Все
                  </button>
                  {config.categories.map((c) => {
                    const Icon = icons[c.id]
                    return (
                      <button
                        key={c.id}
                        className={category === c.id ? 'active' : ''}
                        onClick={() => setCategory(c.id)}
                      >
                        <Icon size={15} />
                        {c.name}
                      </button>
                    )
                  })}
                </div>
                <div className="target-picker">
                  <MapPin size={17} />
                  <label htmlFor="target-district">Район для новых мер</label>
                  <select
                    id="target-district"
                    value={district}
                    onChange={(e) => setDistrict(e.target.value)}
                  >
                    {config.districts.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <small>Городские меры действуют везде</small>
                </div>
                <div className="measure-grid">
                  {config.measures
                    .filter((m) => category === 'all' || m.category === category)
                    .map((measure) => {
                      const cat = config.categories.find((c) => c.id === measure.category)!
                      const Icon = icons[measure.category]
                      const chosen = decisions.some((d) => d.measure_id === measure.id)
                      const reason = unavailableReason(measure, district, decisions, config)
                      const factor = (config.horizon - measure.lag) / config.horizon
                      return (
                        <article
                          className={`measure-card ${chosen ? 'chosen' : ''}`}
                          key={measure.id}
                          data-testid={`measure-${measure.id}`}
                        >
                          <div className="measure-top">
                            <span
                              className="category-icon"
                              style={{ color: cat.color, background: `${cat.color}16` }}
                            >
                              <Icon size={20} />
                            </span>
                            <span className="measure-category">{cat.name}</span>
                            <span className="measure-id">{measure.id}</span>
                          </div>
                          <h3>{measure.name}</h3>
                          <div className="measure-meta">
                            <span>
                              <MapPin size={13} />
                              {measure.scope === 'city' ? 'Весь город' : selectedDistrict.name}
                            </span>
                            <span>
                              <Clock3 size={13} />
                              Лаг {measure.lag} кв.
                            </span>
                          </div>
                          <div className="effects">
                            {Object.entries(measure.effects).map(([id, value]) => (
                              <span
                                key={id}
                                className={value < 0 ? 'negative' : ''}
                                title={`${config.metrics.find((m) => m.id === id)!.name}: полный эффект ${value > 0 ? '+' : ''}${value}; с лагом ${value * factor}`}
                              >
                                {id} {value > 0 ? '+' : ''}
                                {number(value * factor, 2)}
                              </span>
                            ))}
                          </div>
                          <div className="measure-bottom">
                            <strong>
                              {measure.cost}
                              <small> ед.</small>
                            </strong>
                            <button
                              aria-label={`Добавить ${measure.id}`}
                              disabled={Boolean(reason)}
                              title={reason || 'Добавить в план'}
                              onClick={() =>
                                update([
                                  ...decisions,
                                  {
                                    measure_id: measure.id,
                                    district_id: measure.scope === 'city' ? null : district,
                                  },
                                ])
                              }
                            >
                              {chosen ? (
                                <>
                                  <Check size={16} /> В плане
                                </>
                              ) : (
                                <>
                                  <Plus size={16} /> Выбрать
                                </>
                              )}
                            </button>
                          </div>
                          {reason && !chosen && <p className="blocked-reason">{reason}</p>}
                        </article>
                      )
                    })}
                </div>
                <p className="catalog-note">
                  На карточках показан эффект за 8 кварталов с учётом лага. Дополнительные синергии
                  учитываются при расчёте.
                </p>
              </section>
            </div>

            <aside className="plan-column">
              <section className="plan-card">
                <div className="plan-heading">
                  <span className="eyebrow">ВАША СТРАТЕГИЯ</span>
                  <h2>
                    План развития <span>{decisions.length}/5</span>
                  </h2>
                  <p>
                    Выберите пять инициатив.
                    <br />
                    Максимум две из одного направления.
                  </p>
                </div>
                <ol className="plan-list">
                  {Array.from({ length: 5 }, (_, index) => {
                    const decision = decisions[index]
                    const measure =
                      decision && config.measures.find((m) => m.id === decision.measure_id)!
                    const cat = measure && config.categories.find((c) => c.id === measure.category)!
                    return (
                      <li key={index} className={measure ? 'occupied' : ''}>
                        <span
                          className="slot-number"
                          style={
                            cat ? { color: cat.color, background: `${cat.color}18` } : undefined
                          }
                        >
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        {measure ? (
                          <>
                            <div>
                              <strong>{measure.name}</strong>
                              <small>
                                {decision.district_id
                                  ? config.districts.find((d) => d.id === decision.district_id)!
                                      .name
                                  : 'Весь город'}{' '}
                                · {measure.cost} ед.
                              </small>
                            </div>
                            <button
                              className="icon-button"
                              aria-label={`Удалить ${measure.id}`}
                              onClick={() => update(decisions.filter((_, i) => i !== index))}
                            >
                              <X size={16} />
                            </button>
                          </>
                        ) : (
                          <div>
                            <strong>Новое решение</strong>
                            <small>Выберите инициативу в каталоге</small>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ol>
                <div className="plan-total">
                  <span>Инвестиции в город</span>
                  <strong>
                    {spent} <small>/ {config.budget}</small>
                  </strong>
                </div>
                <div className="plan-actions">
                  <button
                    className="primary"
                    disabled={!result || busy || analyzing}
                    onClick={analyze}
                  >
                    <Sparkles size={18} />
                    {analyzing
                      ? 'Анализируем сценарий…'
                      : busy
                        ? 'Считаем результат…'
                        : 'Разобрать с ИИ'}
                    {!analyzing && <ArrowRight size={17} />}
                  </button>
                  <small>
                    {decisions.length < 5
                      ? `Осталось принять решений: ${5 - decisions.length}`
                      : result
                        ? 'Score рассчитан. Получите объяснение решений.'
                        : 'Проверяем правила сценария'}
                  </small>
                  {decisions.length > 0 && (
                    <button className="reset-button" onClick={() => update([])}>
                      <RotateCcw size={14} /> Начать заново
                    </button>
                  )}
                </div>
                {error && (
                  <div className="error-box" role="alert">
                    {error}
                    <button onClick={() => update([...decisions])}>Повторить расчёт</button>
                  </div>
                )}
              </section>
              <div className="strategy-note">
                <span className="note-icon">
                  <Leaf size={20} />
                </span>
                <div>
                  <strong>Город сильнее, когда растёт каждый район</strong>
                  <p>Часть оценки зависит от самого слабого района. Обратите внимание на Нуру.</p>
                </div>
              </div>
              <button className="method-button" onClick={() => setRulesOpen(true)}>
                <CircleHelp size={17} /> Как считается оценка <ChevronRight size={16} />
              </button>
              {result && (
                <div className="contribution-card">
                  <h3>Вклад в Score</h3>
                  <p>С учётом синергий и штрафов</p>
                  {result.contributions.map((c) => (
                    <div key={c.measure_id}>
                      <span>{c.measure_id}</span>
                      <span className="contribution-track">
                        <i
                          style={{
                            width: `${Math.max(3, (Math.abs(c.score_delta) / Math.max(...result.contributions.map((x) => Math.abs(x.score_delta)))) * 100)}%`,
                          }}
                        />
                      </span>
                      <strong>{signed(c.score_delta)}</strong>
                    </div>
                  ))}
                  <small>Метод Шепли: сумма вкладов равна изменению Score.</small>
                </div>
              )}
            </aside>
          </div>

          {result && (
            <section className="results-section" aria-label="Итоги сценария">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">ПОСЛЕ ВАШИХ РЕШЕНИЙ</span>
                  <h2>Что изменилось в городе</h2>
                </div>
                <button className="secondary" onClick={exportResult}>
                  <ArrowDownToLine size={16} /> Скачать расчёт
                </button>
              </div>
              <div className="result-districts">
                {result.districts.map((d) => {
                  const before = config.baseline.districts.find((b) => b.id === d.id)!
                  return (
                    <div key={d.id}>
                      <span>{d.name}</span>
                      <strong>{number(d.score)}</strong>
                      <small>
                        {number(before.score)} → {number(d.score)}
                      </small>
                      <b>{signed(d.score - before.score)}</b>
                    </div>
                  )
                })}
              </div>
              {result.synergies.length > 0 && (
                <div className="synergy-banner">
                  <Sparkles size={18} />
                  Сработали синергии:{' '}
                  {result.synergies
                    .map(
                      (s) =>
                        `${s.pair.join(' + ')} (${config.districts.find((d) => d.id === s.district_id)!.name})`,
                    )
                    .join('; ')}
                </div>
              )}
              {result.suggestions.length > 0 && (
                <div className="suggestions">
                  <h3>Попробуйте улучшить план</h3>
                  <p>
                    Проверенные замены одной меры. Все варианты укладываются в бюджет и правила;
                    глобальный оптимум не гарантируется.
                  </p>
                  {result.suggestions.map((s) => (
                    <div className="suggestion" key={s.id}>
                      <div>
                        <span>
                          {config.measures.find((m) => m.id === s.remove.measure_id)!.name} ·{' '}
                          {config.districts.find((d) => d.id === s.remove.district_id)?.name ||
                            'город'}
                        </span>
                        <strong>
                          <ArrowRight size={15} />
                          {config.measures.find((m) => m.id === s.add.measure_id)!.name} ·{' '}
                          {config.districts.find((d) => d.id === s.add.district_id)?.name ||
                            'город'}
                        </strong>
                      </div>
                      <div>
                        <b>{signed(s.score_delta)} Score</b>
                        <small>Бюджет {s.spent}/100</small>
                      </div>
                      <button className="secondary" onClick={() => update(s.decisions)}>
                        Применить
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {analysis && (
            <section className="analysis-section" ref={reportRef}>
              <div className="section-heading">
                <div>
                  <span className="eyebrow">ОБЪЯСНЕНИЕ РЕШЕНИЙ</span>
                  <h2>
                    <Sparkles size={23} />
                    {analysis.mode === 'llm' ? 'Взгляд ИИ-аналитика' : 'Разбор по правилам модели'}
                  </h2>
                </div>
                <span className={`mode-badge ${analysis.mode}`}>
                  {analysis.mode === 'llm' ? 'ИИ подключён' : 'Без LLM'}
                </span>
              </div>
              <p className="analysis-notice" role="status">
                {analysis.notice}
              </p>
              <p className="analysis-summary">{analysis.report.summary}</p>
              <div className="analysis-columns">
                {(['strengths', 'risks'] as const).map((key) => (
                  <div key={key}>
                    <h3>{key === 'strengths' ? 'Сильные стороны' : 'Риски и компромиссы'}</h3>
                    {analysis.report[key].map((item, i) => (
                      <article key={i}>
                        <p>{item.text}</p>
                        {item.fact_ids.map((id) => (
                          <small key={id}>{analysis.facts[id]}</small>
                        ))}
                      </article>
                    ))}
                  </div>
                ))}
              </div>
              {analysis.report.recommendation_ids.length > 0 && (
                <div className="analyst-recommendations">
                  <h3>Рекомендации</h3>
                  {analysis.report.recommendation_ids.map((id) => (
                    <p key={id}>{analysis.facts[id]}</p>
                  ))}
                </div>
              )}
            </section>
          )}

          <footer>
            <span>
              <Building2 size={17} /> PROJECTZERO
            </span>
            <p>Аким на 5 часов · Синтетическая модель города · {config.version}</p>
            <span>Сделано для HackAlem AI</span>
          </footer>
        </main>
      )}
      {rulesOpen && <RulesModal config={config} onClose={() => setRulesOpen(false)} />}
    </>
  )
}

function RulesModal({ config, onClose }: { config: Config; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialogRef}
      className="rules-modal"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="section-heading">
        <h2>Как устроен симулятор</h2>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть правила">
          <X />
        </button>
      </div>
      <p>Каждая команда начинает с одного датасета и бюджета {config.budget} единиц.</p>
      <ul>
        <li>Выберите ровно пять разных мер, максимум две из одного направления.</li>
        <li>Для районной меры выберите район. Городская действует во всех пяти районах.</li>
        <li>Бюджет превышать нельзя. Остаток не сгорает и не добавляет баллов.</li>
        <li>Лаг уменьшает эффект: полный эффект × (8 − лаг) / 8.</li>
        <li>Синергии добавляются целиком; затем показатели ограничиваются диапазоном 0–100.</li>
      </ul>
      <div className="formula">Score = 0,7 × Dсреднее + 0,3 × Dминимум − Nкрит</div>
      <p>
        D — сумма показателей с весами. Среднее учитывает долю населения. Nкрит — число показателей
        строго ниже 40.
      </p>
      <h3>Несовместимости</h3>
      <ul>
        {config.incompatibilities.map((c) => (
          <li key={c.pair.join('-')}>
            {c.pair.join(' + ')}: {c.reason}
          </li>
        ))}
      </ul>
      <p className="muted">
        Карта показывает реальную Астану, а сценарий использует пять условных районов из задания.
        Данные и последствия синтетические. ИИ объясняет результат, числа считает сервер.
      </p>
      <button className="primary" onClick={onClose}>
        Понятно, к решениям <ArrowRight size={16} />
      </button>
    </dialog>
  )
}
