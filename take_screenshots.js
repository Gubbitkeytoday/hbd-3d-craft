import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

async function run() {
    const dir = './screenshots';
    if (!fs.existsSync(dir)){
        fs.mkdirSync(dir);
    }

    console.log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // 1. Creator Dashboard
    console.log('Capturing Creator Dashboard...');
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for 3D canvas
    await page.screenshot({ path: path.join(dir, '1_creator_dashboard.png') });
    console.log('Saved 1_creator_dashboard.png');

    // 2. Envelope Gate (Receiver view)
    console.log('Capturing Envelope Gate...');
    await page.goto('http://localhost:5173/#/view/Senpai', { waitUntil: 'domcontentloaded' });
    await new Promise(resolve => setTimeout(resolve, 2000));
    await page.screenshot({ path: path.join(dir, '2_envelope_gate.png') });
    console.log('Saved 2_envelope_gate.png');

    // 3. Receiver Cake View (Click Open Surprise)
    console.log('Opening envelope and capturing Cake View...');
    try {
        await page.click('#btn-open-envelope');
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for reveal animations
        await page.screenshot({ path: path.join(dir, '3_receiver_cake_view.png') });
        console.log('Saved 3_receiver_cake_view.png');
    } catch (err) {
        console.error('Failed to click open envelope:', err);
    }

    await browser.close();
    console.log('Screenshots completed successfully!');
}

run().catch(console.error);
