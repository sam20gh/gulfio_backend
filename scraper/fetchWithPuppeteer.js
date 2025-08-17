const puppeteer = require('puppeteer');
const fs = require('fs');

async function findChrome() {
    const possiblePaths = [
        // Puppeteer's bundled Chrome (should be first priority)
        puppeteer.executablePath(),
        // macOS paths
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        // Linux paths
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
    ];

    for (const path of possiblePaths) {
        try {
            if (path && fs.existsSync(path)) {
                console.log(`[Puppeteer] Found Chrome at: ${path}`);
                return path;
            }
        } catch (error) {
            // Continue to next path
            console.log(`[Puppeteer] Path check failed for ${path}:`, error.message);
        }
    }

    console.log('[Puppeteer] No Chrome executable found, using Puppeteer default');
    console.log('[Puppeteer] If this fails, run: npx puppeteer browsers install chrome');
    return undefined;
}

async function fetchWithPuppeteer(url, options = {}) {
    let browser;
    try {
        // Configure for Cloud Run and other serverless environments
        const launchOptions = {
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=TranslateUI',
                '--disable-ipc-flooding-protection'
            ]
        };

        // Try to find Chrome executable
        const chromePath = await findChrome();
        if (chromePath) {
            launchOptions.executablePath = chromePath;
        }

        console.log(`[Puppeteer] Launching browser with options:`, {
            headless: launchOptions.headless,
            executablePath: launchOptions.executablePath || 'default',
            args: launchOptions.args.length + ' args'
        });

        try {
            browser = await puppeteer.launch(launchOptions);
        } catch (launchError) {
            console.error('[Puppeteer] Failed to launch browser:', launchError.message);
            
            // If Chrome path was specified but failed, try without explicit path
            if (launchOptions.executablePath) {
                console.log('[Puppeteer] Retrying without explicit Chrome path...');
                delete launchOptions.executablePath;
                browser = await puppeteer.launch(launchOptions);
            } else {
                throw launchError;
            }
        }
        const page = await browser.newPage();

        // Set user agent to avoid detection
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

        console.log(`[Puppeteer] Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Return early if the caller wants to interact before closing
        if (options.returnPage) {
            return { browser, page };
        }

        const html = await page.content();
        await browser.close();
        console.log(`[Puppeteer] Successfully fetched content (${html.length} characters)`);
        return { html };
    } catch (error) {
        console.error(`[Puppeteer] Error:`, error.message);
        if (browser) {
            try {
                await browser.close();
            } catch (closeError) {
                console.error('[Puppeteer] Error closing browser:', closeError.message);
            }
        }
        throw error;
    }
}

module.exports = fetchWithPuppeteer;
