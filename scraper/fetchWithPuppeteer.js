const puppeteer = require('puppeteer');
const fs = require('fs');

async function findChrome() {
    const possiblePaths = [
        // Puppeteer's bundled Chrome (should be first priority)
        puppeteer.executablePath(),
        // Cloud Run / Container paths
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        // macOS paths (for local development)
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
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

    console.log('[Puppeteer] No Chrome executable found');
    console.log('[Puppeteer] Available Chrome processes:');
    try {
        const { exec } = require('child_process');
        exec('which google-chrome-stable || which google-chrome || which chromium || echo "No Chrome found"', (error, stdout) => {
            console.log('[Puppeteer] System Chrome search result:', stdout.trim());
        });
    } catch (e) {
        console.log('[Puppeteer] Could not search for Chrome');
    }

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
                '--disable-ipc-flooding-protection',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
                '--disable-extensions',
                '--disable-plugins',
                '--disable-sync',
                '--no-default-browser-check',
                '--memory-pressure-off',
                '--max_old_space_size=512',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-translate',
                '--disable-notifications',
                '--disable-speech-api',
                '--disable-file-system',
                '--disable-presentation-api',
                '--disable-permissions-api'
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
                try {
                    browser = await puppeteer.launch(launchOptions);
                } catch (retryError) {
                    console.error('[Puppeteer] Retry also failed:', retryError.message);
                    throw new Error(`Puppeteer failed to launch browser. Chrome installation issue: ${retryError.message}`);
                }
            } else {
                throw new Error(`Puppeteer failed to launch browser: ${launchError.message}`);
            }
        }
        const page = await browser.newPage();

        // Set user agent to avoid detection
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

        console.log(`[Puppeteer] Navigating to: ${url}`);

        try {
            // Reduced timeout for Cloud Run compatibility and added more robust waiting
            await page.goto(url, {
                waitUntil: 'domcontentloaded', // Changed from 'networkidle2' which can be unreliable
                timeout: 15000
            });

            // Wait a bit for dynamic content to load
            await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (navigationError) {
            console.log(`[Puppeteer] Navigation warning for ${url}:`, navigationError.message);
            // Try to get content even if navigation had issues
        }

        // Return early if the caller wants to interact before closing
        if (options.returnPage) {
            return { browser, page };
        }

        let html;
        try {
            // Check if page is still valid before extracting content
            if (page.isClosed()) {
                throw new Error('Page was closed during navigation');
            }

            html = await page.content();
        } catch (contentError) {
            console.log(`[Puppeteer] Content extraction error for ${url}:`, contentError.message);
            // Try to get basic HTML even if there's an error
            try {
                if (!page.isClosed()) {
                    html = await page.evaluate(() => document.documentElement.outerHTML);
                } else {
                    throw new Error('Page is closed');
                }
            } catch (fallbackError) {
                console.log(`[Puppeteer] Fallback content extraction also failed:`, fallbackError.message);
                html = '<html><body>Puppeteer content extraction failed</body></html>';
            }
        }

        // Safe browser cleanup
        try {
            if (!browser.process()?.killed) {
                await browser.close();
            }
        } catch (closeError) {
            console.log(`[Puppeteer] Browser cleanup warning:`, closeError.message);
        }

        console.log(`[Puppeteer] Successfully fetched content (${html.length} characters)`);
        return { html };
    } catch (error) {
        console.error(`[Puppeteer] Error:`, error.message);
        if (browser) {
            try {
                // Force close browser process if it exists
                if (!browser.process()?.killed) {
                    await browser.close();
                }
                console.log(`[Puppeteer] Browser cleaned up after error`);
            } catch (closeError) {
                console.error('[Puppeteer] Error closing browser:', closeError.message);
                // Force kill if browser is stuck
                try {
                    if (browser.process()?.kill) {
                        browser.process().kill('SIGKILL');
                        console.log('[Puppeteer] Browser process force killed');
                    }
                } catch (killError) {
                    console.error('[Puppeteer] Could not kill browser process:', killError.message);
                }
            }
        }
        throw error;
    }
}

module.exports = fetchWithPuppeteer;
