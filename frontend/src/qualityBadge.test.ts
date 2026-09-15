import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { QualityBadge, qualityGlyphs, qualitySlug } from './ReviewCharts';

it('renders the Allowed mate badge with glyph, class, and label', () => {
  expect(qualityGlyphs['Allowed mate']).toBe('💀');
  expect(Object.keys(qualityGlyphs)).toHaveLength(9);
  const html = renderToStaticMarkup(
    createElement(QualityBadge, { quality: { label: 'Allowed mate', accuracy: 0, loss: 2 } }),
  );
  expect(html).toContain('quality-allowed-mate');
  expect(html).toContain('💀');
  expect(html).toContain('aria-label="Allowed mate"');
});

it('ships Allowed mate styles and a seamless reel loop for all nine verdicts', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const styles = readFileSync(resolve(root, 'styles.css'), 'utf8');
  const overview = readFileSync(resolve(root, 'review-overview.css'), 'utf8');
  expect(styles).toContain('.quality-allowed-mate');
  expect(styles).toContain('#7f1d1d');
  expect(styles).toContain('calc(-22px * 9)');
  expect(overview).toContain('.chart-dot-allowed-mate');
  // Chart dots derive from the label slug, so Allowed mate lands on its styled rule.
  expect(`chart-dot-${qualitySlug('Allowed mate')}`).toBe('chart-dot-allowed-mate');
});
