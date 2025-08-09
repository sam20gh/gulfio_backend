# Scraper Duplicate Article Fix - Complete Solution

## Issues Identified and Fixed

### 1. **Critical Bug: Wrong URL for Gulfi News**
- **Problem**: The scraper was fetching content from `source.url` (main page) instead of individual article `link` URLs for Gulfi News sources.
- **Fix**: Changed `fetchWithPuppeteer(source.url, { returnPage: true })` to `fetchWithPuppeteer(link, { returnPage: true })`
- **Impact**: This was causing the scraper to extract wrong content and fail duplicate detection.

### 2. **Improved URL Normalization**
- **Problem**: URLs with slight variations (trailing slashes, query parameters) were treated as different articles.
- **Fix**: Added `normalizeUrl()` function that:
  - Removes query parameters and fragments
  - Standardizes trailing slash handling
  - Uses consistent URL format for duplicate checks
- **Impact**: Prevents duplicate articles with slightly different URLs.

### 3. **Enhanced Duplicate Detection**
- **Problem**: Only checking URL for duplicates was insufficient.
- **Fix**: Added multiple layers of duplicate detection:
  - URL-based check (original + normalized URL)
  - Title-based check (within same source)
  - Database constraints at model level
- **Impact**: Comprehensive duplicate prevention.

### 4. **Database Schema Improvements**
- **Problem**: No database-level constraints to prevent duplicates.
- **Fix**: Added to Article model:
  - Unique constraint on URL field
  - Compound unique index on title + sourceId
  - Performance indexes for common queries
- **Impact**: Database-level duplicate prevention and better query performance.

### 5. **Error Handling Improvements**
- **Problem**: Poor error handling for Puppeteer failures.
- **Fix**: Added fallback to axios if Puppeteer fails for Gulfi News.
- **Impact**: More robust scraping with graceful degradation.

### 6. **Code Quality Fixes**
- **Problem**: Inconsistent variable naming and global variable misuse.
- **Fix**: 
  - Consistent use of `pageHtml` variable
  - Removed unreliable `globalThis.lastFetchedHtml`
  - Better error logging with normalized URLs
- **Impact**: More maintainable and reliable code.

## Files Modified

1. **`/scraper/scrape.js`**
   - Fixed main scraping logic
   - Added URL normalization
   - Enhanced duplicate detection
   - Improved error handling

2. **`/models/Article.js`**
   - Added unique constraints
   - Added performance indexes
   - Enhanced schema for duplicate prevention

3. **`/scripts/remove-duplicates.js`** (New)
   - Script to clean existing duplicates
   - Handles both URL and title duplicates
   - Keeps most recent articles

4. **`/cleanup-duplicates.sh`** (New)
   - Easy-to-use shell script for cleanup
   - Interactive confirmation for safety

## How to Use

### 1. Clean Existing Duplicates
```bash
cd /Users/sam/Desktop/gulfio/backend
./cleanup-duplicates.sh
```

### 2. Test the Fixed Scraper
```bash
# The scraper should now prevent duplicates automatically
node -e "require('./scraper/scrape')('daily')"
```

### 3. Monitor for Issues
The enhanced logging will show:
- Duplicate detection in action
- URL normalization working
- Any remaining issues

## Expected Results

- **No more duplicate articles** being added to database
- **Better performance** due to database indexes  
- **More reliable scraping** with improved error handling
- **Cleaner data** with normalized URLs
- **Comprehensive logging** for monitoring and debugging

## Testing Recommendations

1. Run the duplicate cleanup script first
2. Test scraper with a small frequency (like 'daily')
3. Monitor logs for duplicate detection messages
4. Check database for any new duplicates after running
5. Verify that legitimate new articles are still being added

The scraper should now be robust against duplicate articles while maintaining all existing functionality.
