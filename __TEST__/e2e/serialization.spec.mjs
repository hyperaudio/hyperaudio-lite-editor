// Canonical export serialization: the HTML / interactive-transcript exports
// must emit clean, consistently formatted markup — one span per line, two-space
// indents, data-m before data-d, speaker class kept, runtime noise dropped —
// instead of raw contenteditable innerHTML.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('#hypertranscript [data-m]');
});

test('serializeTranscriptHtml emits canonical one-span-per-line markup', async ({ page }) => {
  const html = await page.evaluate(() =>
    window.serializeTranscriptHtml(document.querySelector('#hypertranscript')));
  const lines = html.split('\n');

  expect(lines[0]).toBe('<article>');
  expect(lines[1]).toBe('  <section>');
  expect(lines[2]).toBe('    <p>');
  expect(lines[lines.length - 2]).toBe('  </section>');
  expect(lines[lines.length - 1]).toBe('</article>');

  const spanLines = lines.filter((l) => l.includes('<span'));
  expect(spanLines.length).toBeGreaterThan(50);
  for (const l of spanLines) {
    expect(l).toMatch(/^      <span data-m="\d+"( data-d="\d+")?/);   // 6-space indent, m before d
    expect((l.match(/<span/g) || []).length).toBe(1);                 // one span per line
    expect(l).not.toMatch(/class="(?!speaker)/);                      // no runtime classes
  }
  // the speaker label keeps its semantic class, after data-m/data-d
  expect(html).toMatch(/<span data-m="\d+" data-d="0" class="speaker">\[Monika\] <\/span>/);
});

test('the HTML download reflects canonical serialization after the sanitise tick', async ({ page }) => {
  await page.evaluate(() => {
    document.querySelector('#hypertranscript').focus();
    document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  });
  await page.waitForTimeout(1400); // past the 1s debounce
  const href = await page.evaluate(() =>
    decodeURIComponent(document.querySelector('#download-html').getAttribute('href').replace('data:text/html,', '')));
  expect(href.split('\n')[0]).toBe('<article>');
  expect(href).toMatch(/\n      <span data-m="\d+" data-d="\d+">/);
  expect(href).not.toMatch(/class="unread"|class="read"/);
});

test('HTML→JSON→HTML round trip preserves every word, incl. zero-duration and no-data-d (#408)', async ({ page }) => {
  const r = await page.evaluate(() => {
    const html = `<article><section>
      <p><span data-m="1000" data-d="0" class="speaker">[A] </span>
         <span data-m="1000" data-d="500">one </span>
         <span data-m="1600">nodur </span>
         <span data-m="2000" data-d="0">zerolast </span></p>
      <p><span data-m="5000" data-d="0" class="speaker">[B] </span>
         <span data-m="5000" data-d="400">two </span></p>
    </section></article>`;
    const json = htmlToJSON(html);
    const back = jsonToHTML(json);
    return { jsonWords: json.words.map((w) => w.text), back };
  });
  expect(r.jsonWords).toEqual(['one', 'nodur', 'zerolast', 'two']);
  for (const w of ['one ', 'nodur ', 'zerolast ', 'two ']) {
    expect(r.back).toContain(`>${w}</span>`);
  }
});

test('strikethrough survives serialization; word text is escaped', async ({ page }) => {
  const html = await page.evaluate(() => {
    const t = document.querySelector('#hypertranscript');
    const spans = [...t.querySelectorAll('span[data-m]')].filter((s) => !s.classList.contains('speaker'));
    spans[1].style.textDecoration = 'line-through';
    spans[2].textContent = '<inaudible> ';
    return window.serializeTranscriptHtml(t);
  });
  expect(html).toMatch(/style="text-decoration: line-through;">/);
  expect(html).toMatch(/&lt;inaudible&gt; /);
  expect(html).not.toMatch(/<inaudible>/);
});
