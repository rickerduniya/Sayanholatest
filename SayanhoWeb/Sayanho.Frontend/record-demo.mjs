import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
    const videoDir = path.resolve(process.cwd(), '..', 'demo-videos');
    await fs.mkdir(videoDir, { recursive: true });

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1366, height: 768 },
        recordVideo: { dir: videoDir, size: { width: 1366, height: 768 } }
    });

    const page = await context.newPage();
    const video = page.video();
    page.setDefaultTimeout(60_000);

    await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Open Designer/i }).click();
    await page.waitForURL('**/design', { timeout: 60_000 });

    await page.locator('button[title="Fit to Content"]').waitFor({ state: 'visible' });

    await page.getByText('File', { exact: true }).click();
    await page.getByText('Load Project', { exact: true }).click();

    await page.getByText('Open Diagram', { exact: true }).waitFor({ state: 'visible' });
    await page.locator('div:has-text("Open Diagram")').locator('button.flex-1.text-left').first().click();
    await page.getByText('Open Diagram', { exact: true }).waitFor({ state: 'hidden' });

    await page.locator('button[title="Fit to Content"]').click();
    await sleep(750);

    await page.locator('button[title="Toggle Current Values"]').click();
    await sleep(750);

    await page.getByText('Tools', { exact: true }).click();
    await page.getByText('Network Monitor', { exact: true }).click();
    await page.getByText('Network Monitor', { exact: true }).waitFor({ state: 'visible' });
    await sleep(1500);
    await page.locator('div:has-text("Network Monitor") button').last().click();
    await sleep(750);

    await page.locator('button[title="Auto Rating"]').click();
    await page.getByText(/Auto-Rating (Complete|Failed)/).waitFor({ state: 'visible', timeout: 120_000 });
    await sleep(2500);
    await page.getByRole('button', { name: 'Close' }).click();
    await sleep(750);

    await page.getByRole('button', { name: 'Layout' }).click();
    await page.locator('button[title="Add Floor Plan"]').waitFor({ state: 'visible' });
    await page.locator('button[title="Add Floor Plan"]').click();
    await page.getByPlaceholder('e.g. Ground Floor, First Floor').fill('Demo Plan');
    await page.getByRole('button', { name: 'Create Blank Plan' }).click();
    await sleep(750);

    const layoutSearch = page.getByPlaceholder('Search components...');
    await layoutSearch.fill('Power Source');
    await page.getByRole('button', { name: /Power Source/i }).click();
    await page.locator('.konvajs-content').first().click({ position: { x: 520, y: 200 } });
    await sleep(500);

    await layoutSearch.fill('Main Switch');
    await page.getByRole('button', { name: /Main Switch/i }).click();
    await page.locator('.konvajs-content').first().click({ position: { x: 520, y: 320 } });
    await sleep(500);

    await layoutSearch.fill('SPN DB');
    await page.getByRole('button', { name: /SPN DB/i }).click();
    await page.locator('.konvajs-content').first().click({ position: { x: 520, y: 440 } });
    await sleep(500);

    await layoutSearch.fill('Point Switch Board');
    await page.getByRole('button', { name: /Point Switch Board/i }).click();
    await page.locator('.konvajs-content').first().click({ position: { x: 760, y: 540 } });
    await sleep(500);

    await layoutSearch.fill('Tube Light');
    await page.getByRole('button', { name: /Tube Light/i }).click();
    await page.locator('.konvajs-content').first().click({ position: { x: 900, y: 540 } });
    await sleep(1500);

    await page.locator('button[title="Magic Wiring"]').click();
    await sleep(900);
    await page.locator('button[title="Magic Wiring"]').click();
    await sleep(900);

    await page.getByRole('button', { name: 'SLD' }).click();
    await page.getByRole('button', { name: /Unplaced/i }).click();
    await sleep(1500);

    const firstUnplaced = page.locator('div:has-text("Drag to canvas")').first();
    if (await firstUnplaced.count()) {
        await firstUnplaced.dragTo(page.locator('.konvajs-content').first(), { targetPosition: { x: 640, y: 420 } });
        await sleep(1000);
    }

    await context.close();
    await browser.close();

    if (!video) return;
    const rawPath = await video.path();
    const target = path.resolve(videoDir, 'sayanho-demo.webm');
    try {
        await fs.rm(target, { force: true });
    } catch {
    }
    await fs.rename(rawPath, target);
    process.stdout.write(`Saved demo video: ${target}\n`);
};

run().catch((e) => {
    process.stderr.write(`${e?.stack || e}\n`);
    process.exit(1);
});
