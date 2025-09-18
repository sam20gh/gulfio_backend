# RSS Testing Support - testSingleSource.js

## Overview

The `testSingleSource.js` function has been updated to support testing both HTML scraping sources and RSS feed sources. It automatically detects the source type and uses the appropriate testing method.

## Features

### Automatic Source Type Detection
- **HTML Sources**: Uses traditional web scraping with CSS selectors
- **RSS Sources**: Parses XML feeds using xml2js library
- **Automatic Routing**: Detects `source.type === 'rss'` and routes to RSS testing function

### RSS Testing Capabilities

#### Feed Support
- **RSS 2.0**: Full support for standard RSS feeds
- **Atom Feeds**: Basic support for Atom format feeds
- **Media Extensions**: Supports media:content, media:thumbnail tags

#### Data Extraction
- **Title**: Extracts from title field, handles CDATA
- **Content**: Extracts from description, content:encoded, or content fields
- **Images**: Multiple image sources (media tags, enclosures, embedded in content)
- **URLs**: Article links from link or guid fields
- **Publication Date**: From pubDate, dc:date, published, or updated fields

#### Image Processing
- **Media Tags**: Extracts from media:content and media:thumbnail
- **Enclosures**: Handles image enclosures
- **Content Images**: Finds images embedded in content HTML
- **Normalization**: Uses same image cleaning/normalization as HTML scraper

## Usage

### Command Line Testing

```bash
# Test any source (HTML or RSS) by ID
npm run test-source [source-id]

# Or directly
node test-source-types.js [source-id]
```

### Programmatic Usage

```javascript
const testSingleSource = require('./scraper/testSingleSource');

// Test any source - function automatically detects type
const results = await testSingleSource(sourceId);

// Results structure is the same for both HTML and RSS
console.log(results.success);     // Boolean
console.log(results.articles);   // Array of extracted articles
console.log(results.errors);     // Array of any errors
console.log(results.steps);      // Array of processing steps
```

## Sample Output

### RSS Source Test Results

```
🧪 Starting test scrape for source ID: 507f1f77bcf86cd799439011
🎯 Testing source: BNA RSS Feed
🔗 URL: https://www.bna.bh/en/GenerateRssFeed.aspx?categoryId=153
📊 Type: rss
📡 RSS source detected, using RSS testing function...
📡 Testing RSS feed: BNA RSS Feed
📥 Fetching RSS feed...
✅ RSS feed fetched (45632 bytes)
🔍 Parsing XML content...
✅ RSS feed parsed successfully
✅ Found 20 items in feed
🧪 Testing RSS item 1
📊 RSS Item 1 - Title: "Economic reforms boost investor confidence...", Content: 1243 chars, Images: 2
🧪 Testing RSS item 2
📊 RSS Item 2 - Title: "New infrastructure projects announced...", Content: 987 chars, Images: 1
```

### Test Results Object Structure

```javascript
{
  source: {
    name: "BNA RSS Feed",
    url: "https://www.bna.bh/en/GenerateRssFeed.aspx?categoryId=153",
    type: "rss"
  },
  steps: [
    "Fetching RSS feed...",
    "✅ RSS feed fetched (45632 bytes)",
    "Parsing XML content...",
    "✅ RSS feed parsed successfully",
    "✅ Found 20 items in feed",
    "Processing first 3 items...",
    "✅ Completed processing 3 RSS items"
  ],
  articles: [
    {
      url: "https://www.bna.bh/en/news/12345",
      title: "Economic reforms boost investor confidence",
      content: "Full text content extracted from RSS...",
      htmlContent: "<p>Original HTML content with tags...</p>",
      images: ["https://www.bna.bh/images/article1.jpg"],
      pubDate: "2025-09-18T10:30:00Z",
      contentLength: 1243,
      titleLength: 42,
      imageCount: 1
    }
  ],
  errors: [],
  success: true
}
```

## RSS vs HTML Differences

| Feature | HTML Sources | RSS Sources |
|---------|-------------|-------------|
| **Content Access** | Requires fetching article pages | Content in feed XML |
| **Images** | CSS selectors | Media tags + content parsing |
| **Performance** | Slower (multiple page requests) | Faster (single feed request) |
| **Content Quality** | Full article content | May be truncated |
| **Selectors** | Required for extraction | Not used (XML structure) |

## Error Handling

### Common RSS Errors
- **Invalid XML**: Feed not properly formatted
- **Network Issues**: Feed URL unreachable
- **Empty Feed**: No items in RSS feed
- **Missing Content**: Items without required fields

### Error Messages
```
RSS parsing failed: Invalid XML structure
No items found in RSS feed
Error processing RSS item 1: Missing required fields
```

## Testing Best Practices

### For RSS Sources
1. **Feed Validation**: Ensure RSS feed is valid XML
2. **Content Check**: Verify items have title and content
3. **Image Support**: Test if feed includes media extensions
4. **Date Format**: Check publication date formats

### For HTML Sources
1. **Selector Validation**: Ensure CSS selectors work
2. **Bot Protection**: Check for CloudFlare/anti-bot measures
3. **SPA Detection**: Test if site needs JavaScript rendering
4. **Content Quality**: Verify extracted content is meaningful

## Integration with Frontend

The testing function integrates seamlessly with admin panels:

```javascript
// Frontend can call the same testing endpoint for both types
const response = await fetch('/api/test-source', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sourceId })
});

const testResults = await response.json();

// Display results based on source type
if (testResults.source.type === 'rss') {
  displayRSSResults(testResults);
} else {
  displayHTMLResults(testResults);
}
```

## Files Modified

1. **`scraper/testSingleSource.js`**
   - Added xml2js import
   - Added `testRSSSource()` function
   - Added type detection in main function
   - Enhanced result structure

2. **`test-source-types.js`**
   - New command-line testing utility
   - Supports both HTML and RSS sources
   - Detailed result display

3. **`package.json`**
   - Added `test-source` npm script

## Dependencies

- **xml2js**: For RSS XML parsing
- **axios**: For HTTP requests
- **cheerio**: For HTML parsing (HTML sources)
- **mongoose**: For database access

All dependencies are already installed in the project.
