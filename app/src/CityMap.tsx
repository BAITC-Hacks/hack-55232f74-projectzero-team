import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Tooltip, ZoomControl, useMap } from 'react-leaflet'
import { Compass, Layers3 } from 'lucide-react'
import type { CityResult, Config, Decision } from './types'

function Focus({ district, config }: { district: string; config: Config }) {
  const map = useMap()
  useEffect(() => {
    const center = config.districts.find((d) => d.id === district)?.center
    if (center) map.panTo(center, { animate: true, duration: 0.6 })
  }, [district, config, map])
  return null
}

export function CityMap({
  config,
  city,
  selected,
  onSelect,
  decisions,
  layer,
  setLayer,
}: {
  config: Config
  city: CityResult
  selected: string
  onSelect: (id: string) => void
  decisions: Decision[]
  layer: string
  setLayer: (id: string) => void
}) {
  const [tileError, setTileError] = useState(false)
  const measureById = new Map(config.measures.map((m) => [m.id, m]))
  return (
    <section className="map-card" aria-label="Карта районов Астаны">
      <div className="map-toolbar">
        <div>
          <span className="eyebrow">ГОРОД РЕШЕНИЙ</span>
          <h2>
            Астана <span>Казахстан</span>
          </h2>
        </div>
        <span className="map-live">
          <span /> Учебная модель
        </span>
      </div>
      <div className="map-frame">
        <MapContainer
          center={[51.15, 71.415]}
          zoom={11}
          minZoom={10}
          maxZoom={16}
          zoomControl={false}
          scrollWheelZoom={false}
          attributionControl
        >
          <TileLayer
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
            eventHandlers={{
              tileerror: () => setTileError(true),
              tileload: () => setTileError(false),
            }}
          />
          <ZoomControl position="bottomright" />
          <Focus district={selected} config={config} />
          {config.districts.map((d) => {
            const result = city.districts.find((r) => r.id === d.id)!
            const value = layer === 'overall' ? result.score : result.category_scores[layer]
            const count = decisions.filter(
              (item) =>
                item.district_id === d.id || measureById.get(item.measure_id)?.scope === 'city',
            ).length
            const color = value < 50 ? '#d87553' : value < 60 ? '#c49743' : '#268b6d'
            return (
              <CircleMarker
                key={d.id}
                center={d.center}
                radius={selected === d.id ? 17 : 12}
                pathOptions={{
                  color: selected === d.id ? '#183c35' : '#ffffff',
                  weight: 3,
                  fillColor: color,
                  fillOpacity: 0.95,
                }}
                eventHandlers={{ click: () => onSelect(d.id) }}
              >
                <Tooltip
                  permanent
                  direction="top"
                  offset={[0, -15]}
                  className={selected === d.id ? 'district-tip selected' : 'district-tip'}
                >
                  <strong>{d.name}</strong>
                  <span>
                    {value.toFixed(1)}
                    {count > 0 ? ` · ${count} мер` : ''}
                  </span>
                </Tooltip>
              </CircleMarker>
            )
          })}
        </MapContainer>
        <div className="map-layer">
          <Layers3 size={16} />
          <select aria-label="Слой карты" value={layer} onChange={(e) => setLayer(e.target.value)}>
            <option value="overall">Качество жизни</option>
            {config.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="north">
          <Compass size={25} />
          <span>N</span>
        </div>
        <div className="map-legend">
          <i className="dot weak" /> &lt; 50 <i className="dot medium" /> 50–60{' '}
          <i className="dot good" /> ≥ 60
        </div>
        {tileError && (
          <div className="tile-warning" role="status">
            Подложка карты недоступна. Районы можно выбрать в списке ниже.
          </div>
        )}
      </div>
      <div className="district-tabs">
        {config.districts.map((d) => (
          <button
            key={d.id}
            className={selected === d.id ? 'active' : ''}
            onClick={() => onSelect(d.id)}
          >
            {d.name}
            <span>{city.districts.find((r) => r.id === d.id)!.score.toFixed(1)}</span>
          </button>
        ))}
      </div>
      <p className="map-note">
        Метки районов условные, не административные границы. Показатели и эффекты синтетические.
      </p>
    </section>
  )
}
