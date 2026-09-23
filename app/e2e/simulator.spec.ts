import { expect, test } from '@playwright/test'

// Avoid sending automated map browsing traffic to the public OSM tile service.
test.beforeEach(async ({ page }) => {
  await page.route('**://tile.openstreetmap.org/**', (route) => route.abort())
  await page.route('**://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Большие перемены. Пять решений.' })).toBeVisible()
})

test('example, server score, honest analysis, improvement and reset', async ({ page }) => {
  await expect(page.getByTestId('city-score')).toContainText('52,56')
  await page.screenshot({ path: 'test-results/desktop.png', animations: 'disabled' })
  await page.getByRole('button', { name: 'Загрузить пример сценария' }).click()
  await expect(page.getByTestId('city-score')).toContainText('56,54')
  await expect(page.getByTestId('remaining-budget')).toHaveText('5из 100 ед.')
  await expect(page.getByTestId('decision-count')).toHaveText('5/ 5')
  await page.getByRole('button', { name: 'Разобрать с ИИ' }).click()
  await expect(page.getByRole('heading', { name: 'Разбор по правилам модели' })).toBeVisible()
  await expect(
    page.getByText('ИИ не подключён. Показано объяснение по правилам модели.'),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Применить', exact: true }).first().click()
  await expect(page.getByTestId('city-score')).not.toContainText('56,54')
  await expect(page.getByRole('heading', { name: 'Разбор по правилам модели' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Итоги сценария' })).toBeVisible()
  await page.getByRole('button', { name: 'Начать заново' }).click()
  await expect(page.getByTestId('remaining-budget')).toHaveText('100из 100 ед.')
  await expect(page.getByTestId('city-score')).toContainText('52,56')
  await expect(page.getByRole('button', { name: 'Разобрать с ИИ' })).toBeDisabled()
})

test('budget, duplicates and district conflicts are blocked while choosing', async ({ page }) => {
  await page.getByRole('button', { name: 'Добавить M3', exact: true }).click()
  await page.getByRole('button', { name: 'Добавить M5', exact: true }).click()
  await page.getByRole('button', { name: 'Добавить M7', exact: true }).click()
  await page.getByRole('button', { name: 'Добавить M10', exact: true }).click()
  await expect(page.getByTestId('remaining-budget')).toHaveText('9из 100 ед.')
  await expect(page.getByRole('button', { name: 'Добавить M12', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Добавить M3', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Разобрать с ИИ' })).toBeDisabled()
  await page.getByRole('button', { name: 'Начать заново' }).click()
  await page.getByRole('button', { name: 'Добавить M4', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Добавить M7', exact: true })).toBeDisabled()
  await page.getByLabel('Район для новых мер').selectOption('esil')
  await expect(page.getByRole('button', { name: 'Добавить M7', exact: true })).toBeEnabled()
})

test('mobile layout and rules modal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Как это работает' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy()
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true })
})
