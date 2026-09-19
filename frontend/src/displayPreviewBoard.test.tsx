import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { defaultArrowSettings } from './arrowSettings';
import { DisplayBoardPreview, type DisplayPreview } from './DisplayPreviewBoard';

const base: DisplayPreview = {
  orientation: 'auto',
  coordinatesOnSquares: true,
  basis: 'next',
  arrows: defaultArrowSettings,
};
const html = (props: Partial<DisplayPreview> = {}) =>
  renderToStaticMarkup(createElement(DisplayBoardPreview, { ...base, ...props }));

it('is a pure mirror: values in, no controls or copy out', () => {
  for (const markup of [html(), html({ orientation: 'black' }), html({ basis: 'past' })]) {
    // Decorative only — the settings controls own every accessible name.
    expect(markup).toContain('aria-hidden="true"');
    // No way to write back: no inputs, buttons, selects, or links.
    expect(markup).not.toMatch(/<(input|button|select|textarea|a)[\s>]/);
    // The board says nothing: reflection is visual only.
    expect(markup).not.toContain('preview-caption');
  }
});

it('mounts the slice window for either basis', () => {
  // Basis differences live in the Chessground mount (effects), so static
  // markup only pins the window both states share.
  expect(html()).toContain('display-slice-window');
  expect(html({ basis: 'past' })).toContain('display-slice-window');
  expect(html({ arrows: { ...defaultArrowSettings, actual: { color: '#000000', width: 64 } } }))
    .toContain('display-slice-window');
});
