import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9333');
const ctx = browser.contexts()[0];
const page = ctx.pages()[0];

const cmd = process.argv[2] || 'info';

if (cmd === 'shot') {
  const out = process.argv[3] || '/tmp/skaz.png';
  await page.screenshot({ path: out, fullPage: false });
  console.log('saved', out);
} else if (cmd === 'html') {
  const html = await page.evaluate(() => document.getElementById('root')?.innerHTML?.slice(0, 20000) ?? 'no root');
  console.log(html);
} else if (cmd === 'text') {
  const text = await page.evaluate(() => document.body.innerText);
  console.log(text);
} else if (cmd === 'a11y') {
  const snapshot = await page.accessibility.snapshot();
  console.log(JSON.stringify(snapshot, null, 1).slice(0, 20000));
} else if (cmd === 'info') {
  console.log('url', page.url());
  console.log('title', await page.title());
}

await browser.close();
