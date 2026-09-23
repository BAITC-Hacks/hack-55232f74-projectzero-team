import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowRight,
  BarChart3,
  BusFront,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Compass,
  Eye,
  Focus,
  GraduationCap,
  Layers3,
  Leaf,
  Map,
  MapPin,
  Minus,
  Moon,
  Pause,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Sun,
  TrafficCone,
  Wallet,
  Wrench,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CityResult, Config, Decision } from '../types'
import { unavailableReason } from '../rules'
import { CityRenderer } from './CityRenderer'
import type { CityLayer } from './CityRenderer'
import { TrafficEngine } from './engine'
import type { Period, TrafficSnapshot } from './engine'
import { districtAreas, pointOnEdge, roads } from './network'
import './game.css'

const categoryIcons: Record<string, LucideIcon> = {
  transport: BusFront,
  ecology: Leaf,
  social: GraduationCap,
  safety: ShieldCheck,
  services: Wrench,
}
const fmt = (value: number, digits = 0) =>
  value.toLocaleString('ru-RU', { maximumFractionDigits: digits })
const layers: { id: CityLayer; name: string; icon: LucideIcon }[] = [
  { id: 'city', name: 'Город', icon: Map },
  { id: 'traffic', name: 'Трафик', icon: TrafficCone },
  { id: 'transit', name: 'Транспорт', icon: BusFront },
  { id: 'districts', name: 'Районы', icon: Layers3 },
]

type Props = {
  config: Config
  decisions: Decision[]
  district: string
  city: CityResult
  hasResult: boolean
  busy: boolean
  analyzing: boolean
  error: string
  onDecisions: (decisions: Decision[]) => void
  onDistrict: (district: string) => void
  onAnalytics: () => void
  onAnalyze: () => void
}

export default function GameView({
  config,
  decisions,
  district,
  city,
  hasResult,
  busy,
  analyzing,
  error,
  onDecisions,
  onDistrict,
  onAnalytics,
  onAnalyze,
}: Props) {
  const [layer, setLayer] = useState<CityLayer>('city')
  const [speed, setSpeed] = useState(1)
  const [period, setPeriod] = useState<Period>('morning')
  const [night, setNight] = useState(false)
  const [revision, setRevision] = useState(0)
  const [compare, setCompare] = useState(false)
  const [panel, setPanel] = useState<string | null>('transport')
  const [selectedRoad, setSelectedRoad] = useState<string | null>(null)
  const [fallback, setFallback] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<CityRenderer | null>(null)
  const callbacks = useRef({ onDistrict })
  callbacks.current = { onDistrict }
  const engines = useMemo(
    () => ({
      current: new TrafficEngine(config, decisions, period),
      baseline: new TrafficEngine(config, [], period),
    }),
    [config, decisions, period, revision],
  )
  const [snapshot, setSnapshot] = useState<TrafficSnapshot>(() => engines.current.snapshot())
  const [baseline, setBaseline] = useState<TrafficSnapshot>(() => engines.baseline.snapshot())
  const stateRef = useRef({
    engines,
    layer,
    speed,
    night,
    district,
    compare,
    decisions,
    selectedRoad,
  })
  stateRef.current = { engines, layer, speed, night, district, compare, decisions, selectedRoad }

  useEffect(() => {
    let renderer: CityRenderer | null = null
    try {
      renderer = new CityRenderer(containerRef.current!, config, (id, road) => {
        callbacks.current.onDistrict(id)
        setSelectedRoad(road || null)
      })
      rendererRef.current = renderer
    } catch {
      // The simulation and controls work even on devices without WebGL2.
      setFallback(true)
    }
    let frame = 0,
      last = performance.now(),
      lastHud = 0
    let currentSnapshot = stateRef.current.engines.current.snapshot()
    let baselineSnapshot = stateRef.current.engines.baseline.snapshot()
    let lastEngines = stateRef.current.engines
    const animate = (now: number) => {
      const state = stateRef.current
      const seconds = Math.min((now - last) / 1000, 0.25)
      last = now
      if (!document.hidden) {
        state.engines.current.advance(seconds * state.speed * 4)
        state.engines.baseline.advance(seconds * state.speed * 4)
      }
      if (now - lastHud > 350 || state.engines !== lastEngines) {
        currentSnapshot = state.engines.current.snapshot()
        baselineSnapshot = state.engines.baseline.snapshot()
        setSnapshot(currentSnapshot)
        setBaseline(baselineSnapshot)
        lastHud = now
        lastEngines = state.engines
      }
      renderer?.setOptions(state.layer, state.district, state.night, state.selectedRoad)
      renderer?.draw(
        state.compare ? state.engines.baseline : state.engines.current,
        state.compare ? baselineSnapshot : currentSnapshot,
        state.compare ? [] : state.decisions,
      )
      frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    return () => {
      cancelAnimationFrame(frame)
      renderer?.dispose()
      rendererRef.current = null
    }
  }, [config])

  const display = compare ? baseline : snapshot
  const spent = decisions.reduce(
    (total, d) => total + config.measures.find((m) => m.id === d.measure_id)!.cost,
    0,
  )
  const selected = config.districts.find((d) => d.id === district)!
  const busyRoads = [...display.roads].sort((a, b) => b.congestion - a.congestion)
  const road = display.roads.find((r) => r.id === selectedRoad) || busyRoads[0]
  const districtStops = display.stops.filter((s) => s.district === district)
  const currentWaiting = districtStops.reduce((total, s) => total + s.waiting, 0)
  const active = config.categories.find((c) => c.id === panel)
  const visibleMeasures =
    panel === 'all' ? config.measures : config.measures.filter((m) => m.category === panel)

  return (
    <section className={`city-game ${night ? 'night' : ''}`} aria-label="Живая симуляция города">
      <div
        className="city-viewport"
        ref={containerRef}
        data-testid="city-viewport"
        data-sim-time={display.elapsed.toFixed(1)}
      />
      {error && (
        <div className="game-error" role="alert">
          {error}
        </div>
      )}
      {fallback && (
        <FallbackMap
          engine={compare ? engines.baseline : engines.current}
          snapshot={display}
          onSelect={onDistrict}
        />
      )}

      <div className="game-topbar">
        <div className="city-title">
          <span className="live-square" />
          <div>
            <h1>
              Астана <span>/ CITY LAB</span>
            </h1>
            <p>Учебная 3D-модель · условная дорожная сеть</p>
          </div>
        </div>
        <div className="game-resources">
          <div>
            <Wallet size={16} />
            <span>
              <small>БЮДЖЕТ</small>
              <strong data-testid="remaining-budget">
                {config.budget - spent}
                <em> / {config.budget}</em>
              </strong>
            </span>
          </div>
          <div>
            <BarChart3 size={16} />
            <span>
              <small>{hasResult ? 'ИТОГОВЫЙ SCORE' : 'БАЗОВЫЙ SCORE'}</small>
              <strong data-testid="city-score">{fmt(city.score, 2)}</strong>
            </span>
          </div>
          <button onClick={() => setPanel(panel === 'plan' ? null : 'plan')}>
            <Check size={16} />
            <span>
              <small>РЕШЕНИЯ</small>
              <strong data-testid="decision-count">
                {decisions.length}
                <em> / 5</em>
              </strong>
            </span>
          </button>
        </div>
      </div>

      <div className="game-left-rail">
        <div className="layer-switch" aria-label="Слои симуляции">
          {layers.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={layer === item.id ? 'active' : ''}
                onClick={() => setLayer(item.id)}
                title={item.name}
                aria-label={`Слой ${item.name}`}
                aria-pressed={layer === item.id}
              >
                <Icon size={19} />
                <span>{item.name}</span>
              </button>
            )
          })}
        </div>
        <div className="traffic-hud">
          <div className="hud-caption">
            <Activity size={13} />
            {compare ? 'БЕЗ МЕР' : 'ЖИВОЙ ТРАФИК'}
            <i />
          </div>
          <div className="flow-value">
            <strong data-testid="traffic-flow">
              {display.flow}
              <small>%</small>
            </strong>
            <span>
              машин
              <br />в движении
            </span>
          </div>
          <div className="flow-meter">
            <i
              style={{
                width: `${display.flow}%`,
                background: display.flow < 45 ? '#f6996f' : '#5ecbb1',
              }}
            />
          </div>
          <div className="traffic-hud-row">
            <span>Средняя скорость</span>
            <b data-testid="traffic-speed">
              {fmt(display.averageSpeed, 1)} <small>км/ч</small>
            </b>
          </div>
          <div className="traffic-hud-row">
            <span>Машин на дорогах</span>
            <b>{display.cars}</b>
          </div>
          <div className="traffic-hud-row">
            <span>Ждут въезда</span>
            <b>{display.pending}</b>
          </div>
          <div className="traffic-hud-row transit-stat">
            <span>
              <BusFront size={12} /> Ожидают транспорт
            </span>
            <b data-testid="waiting-passengers">{display.waiting}</b>
          </div>
          <div className="traffic-hud-row">
            <span>Ожидание сейчас</span>
            <b>
              {fmt(display.averageWait / 60, 1)} <small>мин</small>
            </b>
          </div>
          <div className="traffic-hud-row">
            <span>Спрос на транспорт</span>
            <b>
              {fmt(display.passengerDemand)} <small>чел/мин</small>
            </b>
          </div>
        </div>
        <button
          className={`compare-toggle ${compare ? 'active' : ''}`}
          onClick={() => setCompare(!compare)}
          aria-pressed={compare}
        >
          <Eye size={15} />
          {compare ? 'Вернуть мой сценарий' : 'Сравнить: без решений'}
        </button>
        {decisions.length > 0 && (
          <div className="impact-note">
            <span>ПЛАН / БАЗА В ТОТ ЖЕ МОМЕНТ</span>
            <b>
              {snapshot.waiting - baseline.waiting > 0 ? '+' : ''}
              {snapshot.waiting - baseline.waiting} <small>ожидающих</small>
            </b>
            <p>
              Меры применены на горизонте модели. При изменении плана трафик запускается заново.
            </p>
          </div>
        )}
      </div>

      <div className="camera-controls">
        <button aria-label="Приблизить город" onClick={() => rendererRef.current?.zoom(true)}>
          <Plus size={18} />
        </button>
        <button aria-label="Отдалить город" onClick={() => rendererRef.current?.zoom(false)}>
          <Minus size={18} />
        </button>
        <button aria-label="Показать весь город" onClick={() => rendererRef.current?.resetCamera()}>
          <Focus size={18} />
        </button>
        <button aria-label="Переключить освещение" onClick={() => setNight(!night)}>
          {night ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>

      {panel && (
        <aside className="game-panel" aria-label="Управление городом">
          <div className="game-panel-heading">
            <div>
              <span>ПЛАН РАЗВИТИЯ</span>
              <h2>{panel === 'plan' ? 'Ваши решения' : active?.name || 'Все инициативы'}</h2>
            </div>
            <button aria-label="Закрыть панель города" onClick={() => setPanel(null)}>
              <X size={19} />
            </button>
          </div>
          <div className="game-district-select">
            <MapPin size={16} />
            <select
              aria-label="Район для новых мер в городе"
              value={district}
              onChange={(e) => onDistrict(e.target.value)}
            >
              {config.districts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button
              title="Приблизить район"
              onClick={() => rendererRef.current?.focusDistrict(district)}
            >
              <Focus size={16} />
            </button>
          </div>
          {panel === 'plan' ? (
            <div className="game-plan-list">
              {Array.from({ length: 5 }, (_, i) => {
                const decision = decisions[i]
                const measure =
                  decision && config.measures.find((m) => m.id === decision.measure_id)!
                return (
                  <div key={i}>
                    <span>{String(i + 1).padStart(2, '0')}</span>
                    <div>
                      <strong>{measure?.name || 'Свободное решение'}</strong>
                      <small>
                        {decision
                          ? `${config.districts.find((d) => d.id === decision.district_id)?.name || 'Весь город'} · ${measure!.cost} ед.`
                          : 'Добавьте инициативу из панели ниже'}
                      </small>
                    </div>
                    {decision && (
                      <button
                        aria-label={`Удалить ${decision.measure_id} из города`}
                        onClick={() => onDecisions(decisions.filter((_, j) => i !== j))}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                )
              })}
              <button className="game-text-button" onClick={() => onDecisions([])}>
                <RotateCcw size={14} /> Очистить план
              </button>
              <button className="game-text-button" onClick={() => onDecisions(config.example)}>
                Загрузить контрольный пример <ArrowRight size={14} />
              </button>
            </div>
          ) : (
            <>
              <p className="game-panel-description">
                {panel === 'transport'
                  ? 'Разгрузите мосты, ускорьте автобусы и сократите очереди на остановках.'
                  : selected.profile}
              </p>
              <div className="game-measures">
                {visibleMeasures.map((measure) => {
                  const Icon = categoryIcons[measure.category]
                  const reason = unavailableReason(measure, district, decisions, config)
                  const chosen = decisions.some((d) => d.measure_id === measure.id)
                  return (
                    <article key={measure.id} className={chosen ? 'selected' : ''}>
                      <div className="game-measure-title">
                        <span>
                          <Icon size={19} />
                        </span>
                        <h3>{measure.name}</h3>
                        <b>
                          {measure.cost}
                          <small>ед.</small>
                        </b>
                      </div>
                      <div className="game-measure-info">
                        <span>{measure.scope === 'city' ? 'Весь город' : selected.name}</span>
                        <span>Лаг {measure.lag} кв.</span>
                        <span>{measure.id}</span>
                      </div>
                      <div className="game-effect-tags">
                        {Object.entries(measure.effects).map(([id, value]) => (
                          <span key={id} title={config.metrics.find((m) => m.id === id)?.name}>
                            {id} {value > 0 ? '+' : ''}
                            {fmt((value * (config.horizon - measure.lag)) / config.horizon, 2)}
                          </span>
                        ))}
                      </div>
                      {measure.category === 'transport' && (
                        <p className="transport-effect">
                          {measure.id === 'M1'
                            ? 'Выделенные полосы и дополнительный автобус на затронутых маршрутах.'
                            : measure.id === 'M2'
                              ? 'Короткие циклы светофоров и меньше потерь на перекрёстках.'
                              : 'Региональный маршрут ЛРТ с вместительными составами.'}
                        </p>
                      )}
                      <button
                        disabled={Boolean(reason)}
                        aria-label={`Построить ${measure.id}`}
                        onClick={() =>
                          onDecisions([
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
                            <Check size={15} /> В плане
                          </>
                        ) : (
                          <>
                            <Plus size={15} /> Включить в план
                          </>
                        )}
                      </button>
                      {reason && !chosen && <small className="game-blocked">{reason}</small>}
                    </article>
                  )
                })}
              </div>
            </>
          )}
          <div className="game-panel-footer">
            <span>
              {decisions.length}/5 решений · {spent}/100 ед.
            </span>
            <button disabled={!hasResult || busy || analyzing} onClick={onAnalyze}>
              <Sparkles size={15} />
              {analyzing ? 'Анализ…' : 'Разобрать с ИИ'}
              <ArrowRight size={14} />
            </button>
            <button className="game-open-analytics" onClick={onAnalytics}>
              Точный расчёт и карта Астаны <ChevronRight size={13} />
            </button>
          </div>
        </aside>
      )}

      {!panel && (
        <aside className="road-inspector">
          <span className="hud-caption">
            {selectedRoad ? 'ВЫБРАННАЯ ДОРОГА' : 'САМОЕ НАГРУЖЕННОЕ МЕСТО'}
          </span>
          <h3>{road.name}</h3>
          <div>
            <span>{road.vehicles} машин</span>
            <span>{road.stopped} в очереди</span>
            <span>{fmt(road.speed, 1)} км/ч</span>
          </div>
          <p>
            {selected.name}: {currentWaiting} ожидают на остановках
          </p>
          <button onClick={() => setPanel('transport')}>
            Улучшить транспорт <ArrowRight size={14} />
          </button>
        </aside>
      )}

      <div className="game-map-legend">
        {layer === 'traffic' ? (
          <>
            <i className="legend-green" /> Свободно <i className="legend-yellow" /> Замедление{' '}
            <i className="legend-red" /> Пробка
          </>
        ) : layer === 'transit' ? (
          <>
            <i className="legend-cyan" /> Маршрут ОТ{' '}
            <span>Высота столбика = очередь на остановке</span>
          </>
        ) : (
          <>
            <Compass size={14} /> ЛКМ: вращать · ПКМ: двигать · Колесо: масштаб
          </>
        )}
      </div>
      <div className="game-bottom">
        <div className="simulation-controls">
          <div className="simulation-clock">
            <Clock3 size={16} />
            <strong data-testid="simulation-clock">{display.time}</strong>
            <small>УСЛОВНОЕ ВРЕМЯ</small>
          </div>
          <button
            className={speed === 0 ? 'paused' : ''}
            aria-label={speed === 0 ? 'Продолжить симуляцию' : 'Пауза симуляции'}
            onClick={() => setSpeed(speed === 0 ? 1 : 0)}
          >
            {speed === 0 ? <Play size={17} /> : <Pause size={17} />}
          </button>
          {[1, 3, 6].map((value) => (
            <button
              key={value}
              className={speed === value ? 'active' : ''}
              onClick={() => setSpeed(value)}
              aria-label={`Скорость ${value}x`}
            >
              {value}×
            </button>
          ))}
          <button aria-label="Перезапустить трафик" onClick={() => setRevision(revision + 1)}>
            <RotateCcw size={15} />
          </button>
          <label className="period-select">
            <select
              aria-label="Время суток для трафика"
              value={period}
              onChange={(e) => setPeriod(e.target.value as Period)}
            >
              <option value="morning">Утренний час пик</option>
              <option value="day">Спокойный день</option>
              <option value="evening">Вечерний час пик</option>
            </select>
            <ChevronDown size={13} />
          </label>
        </div>
        <div className="construction-toolbar">
          {config.categories.map((c) => {
            const Icon = categoryIcons[c.id]
            const count = decisions.filter(
              (d) => config.measures.find((m) => m.id === d.measure_id)!.category === c.id,
            ).length
            return (
              <button
                key={c.id}
                className={panel === c.id ? 'active' : ''}
                onClick={() => setPanel(panel === c.id ? null : c.id)}
                aria-label={`Панель ${c.name}`}
              >
                <span className="tool-icon" style={{ color: c.color }}>
                  <Icon size={23} />
                  {count > 0 && <b>{count}</b>}
                </span>
                <span>{c.name}</span>
              </button>
            )
          })}
          <span className="toolbar-divider" />
          <button
            className={panel === 'plan' ? 'active' : ''}
            onClick={() => setPanel(panel === 'plan' ? null : 'plan')}
            aria-label="Открыть план города"
          >
            <span className="tool-icon">
              <Check size={23} />
            </span>
            <span>Мой план</span>
          </button>
          <button onClick={onAnalytics} aria-label="Открыть аналитику">
            <span className="tool-icon">
              <BarChart3 size={23} />
            </span>
            <span>Аналитика</span>
          </button>
        </div>
      </div>
      <div className="simulation-disclaimer">
        Транспортные потоки — отдельная учебная модель. Официальный Score рассчитывается по правилам
        задания.
      </div>
    </section>
  )
}

function FallbackMap({
  engine,
  snapshot,
  onSelect,
}: {
  engine: TrafficEngine
  snapshot: TrafficSnapshot
  onSelect: (id: string) => void
}) {
  return (
    <div className="traffic-fallback">
      <span>Режим совместимости 2D · WebGL недоступен</span>
      <svg viewBox="-450 -340 900 680" aria-label="Схема транспортных потоков">
        <rect x="-450" y="-340" width="900" height="680" fill="#a9b996" />
        <path d="M-450 0 Q-150 -30 0 0 T450 0" fill="none" stroke="#7cb7ba" strokeWidth="45" />
        {roads.map((r) => {
          const reading = snapshot.roads.find((item) => item.id === r.id)!
          return (
            <line
              key={r.id}
              x1={r.a.x}
              y1={r.a.z}
              x2={r.b.x}
              y2={r.b.z}
              stroke={reading.congestion > 0.5 ? '#e49d64' : '#55646a'}
              strokeWidth={8}
            />
          )
        })}
        {engine.vehicles.map((v) => {
          const p = pointOnEdge(v.path[v.segment], v.position, engine.isPriority(v))
          return (
            <rect
              key={v.id}
              x={p.x - 1.5}
              y={p.z - 2}
              width={v.kind === 'car' ? 3 : 5}
              height={v.kind === 'car' ? 4 : 8}
              fill={v.kind === 'car' ? '#f3f0df' : '#20c3ba'}
            />
          )
        })}
        {districtAreas.map((d) => (
          <g key={d.id} onClick={() => onSelect(d.id)}>
            <text x={d.x} y={d.z - 20} textAnchor="middle" fill="#233f49" fontSize="15">
              {d.name}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}
