import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { QualityBadge, qualityGlyphs } from './ReviewCharts';

it('renders the Allowed mate badge with glyph, class, and label', () => {
  expect(qualityGlyphs['Allowed mate']).toBe('💀');
  expect(qualityGlyphs['Excellent']).toBe('!!');
  expect(qualityGlyphs['Alien']).toBe('👽');
  expect(qualityGlyphs).not.toHaveProperty('Miss');
  expect(Object.keys(qualityGlyphs)).toHaveLength(10);
  const html = renderToStaticMarkup(
    createElement(QualityBadge, { quality: { label: 'Allowed mate', accuracy: 0, loss: 2 } }),
  );
  expect(html).toContain('quality-allowed-mate');
  expect(html).toContain('💀');
  expect(html).toContain('aria-label="Allowed mate"');
  const alien = renderToStaticMarkup(
    createElement(QualityBadge, { quality: { label: 'Alien', accuracy: 100, loss: 0 } }),
  );
  expect(alien).toContain('quality-alien');
  expect(alien).toContain('👽');
  expect(alien).toContain('aria-label="Alien"');
});

it('ships Allowed mate styles and a seamless reel loop for all ten verdicts', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const styles = readFileSync(resolve(root, 'styles.css'), 'utf8');
  const overview = readFileSync(resolve(root, 'review-overview.css'), 'utf8');
  expect(styles).toContain('.quality-allowed-mate');
  expect(styles).toContain('.quality-excellent');
  expect(styles).toContain('.quality-alien');
  expect(styles).not.toContain('.quality-miss');
  expect(styles).toContain('#7f1d1d');
  expect(styles).toContain('calc(-22px * 10)');
  expect(overview).toContain('.chart-dot-allowed-mate');
  expect(overview).toContain('.chart-dot-alien');
});
