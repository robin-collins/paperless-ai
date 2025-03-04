// services/rateLimitUtils.js
// Rate limit handling utilities

class RateLimitHandler {
  constructor() {
    this.baseDelay = 1000; // 1 second
    this.maxDelay = 60000; // 60 seconds
    this.maxAttempts = 6;
  }

  calculateDelay(attempt) {
    // Exponential backoff with random jitter
    const exponentialDelay = Math.min(
      this.maxDelay,
      this.baseDelay * Math.pow(2, attempt)
    );
    // Add random jitter (±25% of the delay)
    return exponentialDelay * (0.75 + Math.random() * 0.5);
  }

  async retryWithBackoff(operation) {
    let attempt = 0;
    while (attempt < this.maxAttempts) {
      try {
        return await operation();
      } catch (error) {
        if (error?.response?.status === 429 || error?.status === 429) {
          attempt++;
          if (attempt === this.maxAttempts) {
            throw error;
          }

          // Get retry-after from headers or use calculated delay
          const retryAfter = parseInt(error?.response?.headers?.['retry-after']) * 1000;
          const delay = retryAfter || this.calculateDelay(attempt);
          
          console.log(`[Rate Limited] Attempt ${attempt}/${this.maxAttempts}. Waiting ${delay/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
  }
}

class RateLimitTracker {
  constructor() {
    this.limits = {
      remainingRequests: 1000, // Default values since actual limits may not be available
      remainingTokens: 100000,
      resetAt: null,
      lastUpdated: null,
      totalTokensUsed: 0,
      requestsMade: 0
    };
    console.log('[DEBUG] RateLimitTracker initialized with default values');
  }

  updateFromHeaders(headers) {
    console.log('[DEBUG] Updating rate limits from headers:', JSON.stringify(headers));
    
    // Support multiple header naming conventions from different APIs
    const remainingRequests = 
      headers['x-ratelimit-remaining-requests'] || 
      headers['x-ratelimit-remaining'] || 
      headers['x-ms-ratelimit-remaining-requests'];
    
    const remainingTokens = 
      headers['x-ratelimit-remaining-tokens'] || 
      headers['x-ms-ratelimit-remaining-tokens'] || 
      headers['x-ratelimit-tokens-remaining'];
    
    const resetSeconds = 
      headers['x-ratelimit-reset'] || 
      headers['x-ratelimit-reset-seconds'] ||
      headers['x-ms-ratelimit-reset'];
    
    // Check for token usage information (our custom headers from usage data)
    const usageTokensTotal = headers['x-usage-tokens-total'];
    
    if (remainingRequests !== undefined) {
      this.limits.remainingRequests = parseInt(remainingRequests, 10);
      console.log(`[DEBUG] Updated remainingRequests: ${this.limits.remainingRequests}`);
    } else {
      // If no remaining requests info, decrement our default counter
      this.limits.requestsMade += 1;
      this.limits.remainingRequests = Math.max(0, 1000 - this.limits.requestsMade);
      console.log(`[DEBUG] No request limit info, using estimate: ${this.limits.remainingRequests}`);
    }
    
    if (remainingTokens !== undefined) {
      this.limits.remainingTokens = parseInt(remainingTokens, 10);
      console.log(`[DEBUG] Updated remainingTokens: ${this.limits.remainingTokens}`);
    } else if (usageTokensTotal !== undefined) {
      // If we have usage data but not limits, use it to estimate
      const tokensUsed = parseInt(usageTokensTotal, 10);
      this.limits.totalTokensUsed = (this.limits.totalTokensUsed || 0) + tokensUsed;
      this.limits.remainingTokens = Math.max(0, 100000 - this.limits.totalTokensUsed);
      console.log(`[DEBUG] Updated token usage: ${this.limits.totalTokensUsed}, remaining: ${this.limits.remainingTokens}`);
    }
    
    if (resetSeconds !== undefined) {
      const resetTime = new Date();
      resetTime.setSeconds(resetTime.getSeconds() + parseInt(resetSeconds, 10));
      this.limits.resetAt = resetTime;
      console.log(`[DEBUG] Updated resetAt: ${this.limits.resetAt}`);
    } else {
      // Default reset time: 1 hour from now
      this.limits.resetAt = new Date(Date.now() + 3600000);
      console.log(`[DEBUG] Using default resetAt: ${this.limits.resetAt}`);
    }
    
    this.limits.lastUpdated = new Date();
    console.log(`[DEBUG] Rate limits updated at: ${this.limits.lastUpdated}`);
  }

  // Update limits directly with known values (useful when headers aren't available)
  updateLimits(limits) {
    this.limits = {
      ...this.limits,
      ...limits
    };
    console.log(`[DEBUG] Directly updated rate limits:`, JSON.stringify(this.limits));
  }

  shouldThrottle() {
    return this.limits.remainingRequests !== null && this.limits.remainingRequests < 10;
  }
}

class ApiCallTracker {
  constructor(maxHistorySize = 50) {
    this.calls = [];
    this.maxHistorySize = maxHistorySize;
    console.log('[DEBUG] ApiCallTracker initialized with maxHistorySize:', maxHistorySize);
  }

  trackApiCall(request, response, error = null) {
    console.log('[DEBUG] Tracking API call:', {
      endpoint: request?.url || 'unknown',
      method: request?.method || 'unknown',
      hasResponse: !!response,
      hasError: !!error
    });
    
    // Extract response status and headers safely
    let status = response?.status;
    
    // Handle different response structures
    if (status === undefined) {
      if (error?.response?.status) {
        status = error.response.status;
      } else if (error) {
        status = 'error';
      } else if (response?.choices && response?.usage) {
        // Looks like a successful completion response
        status = 200;
      } else {
        status = 'unknown';
      }
    }
    
    const headers = response?.headers || error?.response?.headers || {};
    
    // Extract rate limit information from headers
    const remainingRequests = 
      headers['x-ratelimit-remaining-requests'] || 
      headers['x-ratelimit-remaining'] || 
      headers['x-ms-ratelimit-remaining-requests'] || 
      null;
    
    const remainingTokens = 
      headers['x-ratelimit-remaining-tokens'] || 
      headers['x-ms-ratelimit-remaining-tokens'] || 
      headers['x-ratelimit-tokens-remaining'] || 
      headers['x-usage-tokens-total'] || // Also check for our custom usage header
      null;
    
    // Calculate latency if possible
    let latency = headers['x-response-time'] || null;
    if (response?.created_at && response?.created) {
      const startTime = new Date(response.created_at).getTime();
      const endTime = new Date(response.created).getTime();
      if (!isNaN(startTime) && !isNaN(endTime)) {
        latency = endTime - startTime;
      }
    }
    
    const call = {
      timestamp: new Date(),
      endpoint: request?.url || 'unknown',
      method: request?.method || 'unknown',
      status: status,
      latency: latency,
      rateLimit: {
        remainingRequests: remainingRequests !== null ? parseInt(remainingRequests, 10) : null,
        remainingTokens: remainingTokens !== null ? parseInt(remainingTokens, 10) : null,
      },
      errorMessage: error ? error.message : null,
      fullHeaders: headers // Store the complete headers object for debugging
    };
    
    console.log('[DEBUG] API call details:', JSON.stringify(call));
    
    this.calls.unshift(call);  // Add to beginning of array
    
    // Trim history if needed
    if (this.calls.length > this.maxHistorySize) {
      this.calls = this.calls.slice(0, this.maxHistorySize);
    }
    
    return call;
  }
  
  getRecentCalls() {
    return this.calls;
  }
  
  // Get statistics about recent calls
  getCallStats() {
    if (this.calls.length === 0) return null;
    
    const stats = {
      totalCalls: this.calls.length,
      successCalls: 0,
      errorCalls: 0,
      rateLimitedCalls: 0,
      avgLatency: null
    };
    
    let latencySum = 0;
    let latencyCount = 0;
    
    this.calls.forEach(call => {
      if (call.status >= 200 && call.status < 300) stats.successCalls++;
      if (call.status >= 400 || call.status === 'error') stats.errorCalls++;
      if (call.status === 429) stats.rateLimitedCalls++;
      
      if (call.latency) {
        latencySum += call.latency;
        latencyCount++;
      }
    });
    
    if (latencyCount > 0) {
      stats.avgLatency = latencySum / latencyCount;
    }
    
    return stats;
  }
}

class ThrottleManager {
  constructor() {
    this.requestQueue = [];
    this.isProcessing = false;
    this.minRequestGap = 100; // Minimum 100ms between requests
  }

  async enqueueRequest(operation) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ operation, resolve, reject });
      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  }

  async processQueue() {
    if (this.isProcessing || this.requestQueue.length === 0) return;
    
    this.isProcessing = true;
    while (this.requestQueue.length > 0) {
      const { operation, resolve, reject } = this.requestQueue.shift();
      try {
        const result = await operation();
        resolve(result);
      } catch (error) {
        reject(error);
      }
      await new Promise(resolve => setTimeout(resolve, this.minRequestGap));
    }
    this.isProcessing = false;
  }
}

// Export the utility classes
module.exports = {
  RateLimitHandler,
  RateLimitTracker,
  ThrottleManager,
  ApiCallTracker
};