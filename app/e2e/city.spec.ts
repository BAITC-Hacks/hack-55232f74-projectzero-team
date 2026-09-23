import { expect, test } from '@playwright/test'

// Software WebGL in CI is slower than a desktop GPU.
test.setTimeout(90_000)

test.beforeEach(async ({ page }) => {
  await page.route('**://tile.openstreetmap.org/**', (route) => route.abort())
  await page.route('**://fonts.googleapis.com/**', (route) => route.abort())
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Живая симуляция города' })).toBeVisible({
    timeout: 20_000,
  })
})

test('3D rendering, traffic layers, simulation clock and shared decisions', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.locator('canvas[data-renderer="webgl"]')).toBeVisible()
  await expect(page.getByTestId('city-score')).toHaveText('52,56')
  await page.getByRole('button', { name: 'Пауза симуляции', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Продолжить симуляцию', exact: true }),
  ).toBeVisible()
  // Let the HUD publish the last fixed simulation step before checking pause.
  await page.waitForTimeout(450)
  const paused = await page.getByTestId('city-viewport').getAttribute('data-sim-time')
  await page.waitForTimeout(450)
  await expect(page.getByTestId('city-viewport')).toHaveAttribute('data-sim-time', paused!)
  await page.screenshot({ path: 'test-results/city-desktop.png' })
  await page.getByRole('button', { name: 'Слой Трафик', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Слой Трафик', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: 'Закрыть панель города' }).click()
  await page.screenshot({ path: 'test-results/city-traffic.png' })
  await page.getByRole('button', { name: 'Панель Транспорт', exact: true }).click()
  await page.getByRole('button', { name: 'Построить M1', exact: true }).click()
  await expect(page.getByTestId('remaining-budget')).toHaveText('82 / 100')
  await expect(page.getByRole('button', { name: 'Построить M3', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Слой Транспорт', exact: true }).click()
  await page.screenshot({ path: 'test-results/city-transit.png' })
  await page.getByRole('button', { name: 'Сравнить: без решений', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Вернуть мой сценарий' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: 'Аналитика и карта', exact: true }).click()
  await expect(page.getByTestId('remaining-budget')).toHaveText('82из 100 ед.')
  await expect(page.getByRole('button', { name: 'Удалить M1', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '3D-город', exact: true }).click()
  await expect(page.getByTestId('decision-count')).toHaveText('1 / 5')
  await page.getByRole('button', { name: 'Скорость 6x', exact: true }).click()
  await expect
    .poll(async () => Number(await page.getByTestId('city-viewport').getAttribute('data-sim-time')))
    .toBeGreaterThan(92)
  await page.getByLabel('Время суток для трафика').selectOption('day')
  await expect(page.getByTestId('simulation-clock')).toContainText('13:')
  expect(errors).toEqual([])
})

test('mobile game keeps construction and budget reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Построить M1', exact: true }).click()
  await expect(page.getByTestId('remaining-budget')).toHaveText('82 / 100')
  await page.getByRole('button', { name: 'Открыть план города', exact: true }).click()
  await page.getByRole('button', { name: 'Загрузить контрольный пример' }).click()
  await expect(page.getByTestId('city-score')).toHaveText('56,54')
  await expect(page.getByTestId('remaining-budget')).toHaveText('5 / 100')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/city-mobile.png' })
  await page.getByRole('button', { name: 'Аналитика и карта', exact: true }).click()
  await expect(page.getByRole('button', { name: '3D-город', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: '3D-город', exact: true }).click()
  await expect(page.getByTestId('city-score')).toHaveText('56,54')
})

test('without WebGL the fallback still simulates and accepts projects', async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...args: unknown[]
    ) {
      if (type.includes('webgl')) return null
      return getContext.apply(this, [type, ...args] as Parameters<typeof getContext>)
    } as typeof getContext
  })
  await page.reload()
  await expect(page.getByText('Режим совместимости 2D · WebGL недоступен')).toBeVisible()
  await page.getByRole('button', { name: 'Построить M2', exact: true }).click()
  await expect(page.getByTestId('remaining-budget')).toHaveText('78 / 100')
  await expect
    .poll(async () => Number(await page.getByTestId('city-viewport').getAttribute('data-sim-time')))
    .toBeGreaterThan(90)
})
