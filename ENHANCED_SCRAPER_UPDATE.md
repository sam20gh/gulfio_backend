# Enhanced Scraper with Bot Protection & Hero Images

## 🚀 Updates Made to scrape.js

### 1. **Bot Protection Detection & Handling**

#### **Source-Level Bot Protection**
- **Detection**: Checks for 403 Forbidden responses from axios requests
- **Automatic Fallback**: Switches to Puppeteer when bot protection is detected
- **Proactive Handling**: Uses Puppeteer upfront for known protected sites

```javascript
// Keywords that trigger Puppeteer usage:
- 'gulfi news' (existing)
- 'timeout' (new - handles TimeOut Dubai)
- 'bot-protection' (new - manual flag)
```

#### **Article-Level Bot Protection**
- **Smart Fallback**: If individual articles return 403, switches to Puppeteer
- **Error Recovery**: Gracefully handles failures and continues with next article
- **Enhanced Headers**: Uses realistic browser headers for better compatibility

### 2. **Hero Background Image Extraction**

#### **New Feature**: `.page-header` Background Detection
```javascript
// When no body images found, checks for hero backgrounds
if (images.length === 0) {
  const style = $$('.page-header').attr('style') || '';
  const m = style.match(/background-image:\s*url\(["']?([^"')]+)["']?\)/i);
  if (m) images.unshift(m[1]);
}
```

#### **Enhanced Image Fallback Chain**
1. **Primary**: Images from `imageSelector` 
2. **Hero**: Background images from `.page-header`
3. **Meta**: Open Graph/Twitter Card images
4. **Normalized**: All images processed for quality and security

### 3. **Better Error Handling & Logging**

#### **Enhanced Logging**
- 🔒 Bot protection detection messages
- 🤖 Puppeteer usage notifications  
- 📸 Hero background image discovery
- ⚠️ Graceful error handling with context

#### **Improved Reliability**
- **Timeout Handling**: 10-second timeouts for all requests
- **Skip Problematic Articles**: Continue scraping even if some articles fail
- **Fallback Chain**: Multiple retry mechanisms

## 🎯 **TimeOut Dubai Solution**

### **Before**: 
- ❌ Test failed during initialization
- 403 Forbidden errors
- No clear error messages

### **After**:
- ✅ Automatic bot protection detection
- 🤖 Puppeteer fallback for protected sites  
- 📸 Enhanced image extraction
- 🔍 Clear logging of what's happening

### **Usage for TimeOut Dubai**:
1. **Option 1**: Update source name to include "timeout" → automatic Puppeteer
2. **Option 2**: Manual flag by including "bot-protection" in name
3. **Option 3**: Automatic detection when 403 is encountered

## 🔧 **Technical Improvements**

### **Request Headers**
Now uses realistic browser headers:
```javascript
'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...'
'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
'Accept-Language': 'en-US,en;q=0.5'
// ... more realistic headers
```

### **Enhanced Image Discovery**
- **CSS Background Parsing**: Extracts images from inline styles
- **Hero Section Support**: Specifically looks for `.page-header` backgrounds  
- **Better Normalization**: Improved URL cleaning and validation

## 🚀 **Benefits**

1. **Higher Success Rate**: Handles bot-protected sites automatically
2. **Better Image Extraction**: Finds hero images that were previously missed
3. **More Reliable**: Graceful error handling and fallback mechanisms
4. **Better Debugging**: Clear logging shows exactly what's happening
5. **TimeOut Dubai Ready**: Now works with protected WordPress sites

## 📊 **Expected Results**

### **For TimeOut Dubai**:
- Should now successfully extract articles from `/news` page
- Hero images from `.page-header` will be captured
- CSS selectors should work correctly once bot protection is bypassed

### **For All Sources**:
- More robust scraping with automatic bot protection handling
- Better image discovery, especially for WordPress/magazine sites
- Clearer error reporting for debugging new sources

The enhanced scraper is now deployed and ready to handle bot-protected sites like TimeOut Dubai while providing better image extraction for all sources.
