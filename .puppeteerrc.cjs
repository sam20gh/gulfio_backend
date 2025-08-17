const {join} = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Changes the cache location for Puppeteer.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
  // Download Chrome browser when installing
  browserRevision: '137.0.7151.70',
  // Skip download if Chrome is already installed
  skipDownload: false,
};
