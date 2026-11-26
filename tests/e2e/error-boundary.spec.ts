import { expect, test } from '@playwright/test';
import { HARNESS } from './helpers';

// Uses the test-only harness fixture (harness/main.tsx), which injects a render failure.
test('error boundary: failure is contained, retry recovers, focus moves to the region (Codex 7.5)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(HARNESS);
  await expect(page.getByText('Fixture content rendered (0)')).toBeVisible();
  await page.getByRole('button', { name: 'Break view' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('This part of the interface stopped working');
  await expect(page.getByText('Surrounding content')).toBeVisible(); // contained
  await page.getByRole('button', { name: 'Heal view' }).click();
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Fixture content rendered (1)')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Fixture region' })).toBeFocused();
  expect(errors.filter((m) => !m.includes('injected render failure'))).toEqual([]);
});
