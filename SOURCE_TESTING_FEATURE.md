# Source Testing Implementation

## Overview
Added a test functionality to the news source management system that allows admins to test scraping selectors and configuration for individual news sources before they go live.

## Features Added

### Backend Changes
1. **New Test Scraper** (`/backend/scraper/testSingleSource.js`)
   - Extracts core scraping logic for testing a single source
   - Tests up to 3 articles to validate selectors
   - Provides detailed feedback on extraction results
   - Includes error handling and step-by-step reporting

2. **New API Endpoint** (`/routes/scrape.js`)
   - `POST /api/scrape/test/:sourceId` - Test a specific source by ID
   - Requires admin API key authentication
   - Returns detailed test results including extracted content

### Frontend Changes
1. **Enhanced Source List** (`/src/components/SourceList.jsx`)
   - Added test button (🐛 icon) next to Edit/Delete buttons
   - New test results dialog with comprehensive reporting
   - Loading states during test execution
   - Color-coded results (success/warning indicators)

## How to Use

### Testing a Source
1. Go to the "Manage News Sources" page
2. Find the source you want to test
3. Click the bug report icon (🐛) in the Actions column
4. Wait for the test to complete (up to 60 seconds)
5. Review the detailed results in the popup dialog

### Test Results Include
- **Source Configuration**: Shows all selectors being used
- **Process Steps**: Step-by-step execution log  
- **Extracted Articles**: Up to 3 test articles with:
  - Title extraction (with character count)
  - Content extraction (with character count)
  - Image extraction (with count)
  - Success indicators via colored chips
- **Error Details**: Any errors encountered during testing

## Technical Details

### API Endpoint
```
POST /api/scrape/test/:sourceId
Headers: x-api-key: [ADMIN_API_KEY]
```

### Response Format
```json
{
  "message": "✅ Test completed successfully",
  "results": {
    "success": true,
    "source": {
      "name": "Source Name",
      "url": "https://example.com",
      "selectors": { ... }
    },
    "steps": ["Step 1", "Step 2", ...],
    "articles": [
      {
        "url": "article-url",
        "title": "Extracted Title",
        "content": "Extracted Content",
        "images": ["image1.jpg"],
        "titleLength": 50,
        "contentLength": 500,
        "imageCount": 1
      }
    ],
    "errors": []
  }
}
```

### Test Validation
- **Title Success**: ≥10 characters extracted
- **Content Success**: ≥100 characters extracted  
- **Images Success**: ≥1 image found
- **Overall Success**: At least one article with valid title extraction

## Benefits
1. **Validation**: Test selectors before adding sources to production
2. **Debugging**: Identify issues with CSS selectors or site structure
3. **Quality Assurance**: Ensure content extraction works as expected
4. **Time Saving**: Catch problems early without affecting live scraping

## Security
- Requires admin API key for authentication
- Same security model as other admin operations
- Test results are not persisted to database
