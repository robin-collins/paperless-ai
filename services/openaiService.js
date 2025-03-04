const OpenAI = require('openai');
const config = require('../config/config');
const tiktoken = require('tiktoken');
const paperlessService = require('./paperlessService');
const fs = require('fs').promises;
const path = require('path');
const { RateLimitHandler, RateLimitTracker, ThrottleManager, ApiCallTracker } = require('./rateLimitUtils');

class OpenAIService {
  constructor() {
    this.client = null;
    this.tokenizer = null;
    this.rateLimitHandler = new RateLimitHandler();
    this.rateLimitTracker = new RateLimitTracker();
    this.throttleManager = new ThrottleManager();
    this.apiCallTracker = new ApiCallTracker();
  }

  initialize() {
    if (!this.client && config.aiProvider === 'ollama') {
      this.client = new OpenAI({
        baseURL: config.ollama.apiUrl + '/v1',
        apiKey: 'ollama'
      });
    } else if (!this.client && config.aiProvider === 'custom') {
      this.client = new OpenAI({
        baseURL: config.custom.apiUrl,
        apiKey: config.custom.apiKey
      });
    } else if (!this.client && config.aiProvider === 'openai') {
    if (!this.client && config.openai.apiKey) {
      this.client = new OpenAI({
        apiKey: config.openai.apiKey
      });
    }
    }}

  // Calculate tokens for a given text
  async calculateTokens(text) {
    if (!this.tokenizer) {
      // Use the appropriate model encoding
      this.tokenizer = await tiktoken.encoding_for_model(process.env.OPENAI_MODEL || "gpt-4o-mini");
    }
    return this.tokenizer.encode(text).length;
  }

  // Calculate tokens for a given text
  async calculateTotalPromptTokens(systemPrompt, additionalPrompts = []) {
    let totalTokens = 0;
    
    // Count tokens for system prompt
    totalTokens += await this.calculateTokens(systemPrompt);
    
    // Count tokens for additional prompts
    for (const prompt of additionalPrompts) {
      if (prompt) { // Only count if prompt exists
        totalTokens += await this.calculateTokens(prompt);
      }
    }
    
    // Add tokens for message formatting (approximately 4 tokens per message)
    const messageCount = 1 + additionalPrompts.filter(p => p).length; // Count system + valid additional prompts
    totalTokens += messageCount * 4;
    
    return totalTokens;
  }

  // Truncate text to fit within token limit
  async truncateToTokenLimit(text, maxTokens) {
    const tokens = await this.calculateTokens(text);
    if (tokens <= maxTokens) return text;

    // Simple truncation strategy - could be made more sophisticated
    const ratio = maxTokens / tokens;
    return text.slice(0, Math.floor(text.length * ratio));
  }

  async analyzeDocument(content, existingTags = [], existingCorrespondentList = [], id, customPrompt = null) {
    const cachePath = path.join('./public/images', `${id}.png`);
    try {
      this.initialize();
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
      
      if (!this.client) {
        throw new Error('OpenAI client not initialized');
      }

      // Handle thumbnail caching
      try {
        await fs.access(cachePath);
        console.log('[DEBUG] Thumbnail already cached');
      } catch (err) {
        console.log('Thumbnail not cached, fetching from Paperless');
        
        const thumbnailData = await paperlessService.getThumbnailImage(id);
        
        if (!thumbnailData) {
          console.warn('Thumbnail nicht gefunden');
        }
  
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, thumbnailData);
      }
      
      // Format existing tags
      const existingTagsList = existingTags
        .map(tag => tag.name)
        .join(', ');

      let systemPrompt = '';
      let promptTags = '';
      const model = process.env.OPENAI_MODEL;
      
      // Parse CUSTOM_FIELDS from environment variable
      let customFieldsObj;
      try {
        customFieldsObj = JSON.parse(process.env.CUSTOM_FIELDS);
      } catch (error) {
        console.error('Failed to parse CUSTOM_FIELDS:', error);
        customFieldsObj = { custom_fields: [] };
      }

      // Generate custom fields template for the prompt
      const customFieldsTemplate = {};

      customFieldsObj.custom_fields.forEach((field, index) => {
        customFieldsTemplate[index] = {
          field_name: field.value,
          value: "Fill in the value based on your analysis"
        };
      });

      // Convert template to string for replacement and wrap in custom_fields
      const customFieldsStr = '"custom_fields": ' + JSON.stringify(customFieldsTemplate, null, 2)
        .split('\n')
        .map(line => '    ' + line)  // Add proper indentation
        .join('\n');

      // Get system prompt and model
      if(process.env.USE_EXISTING_DATA === 'yes') {
        systemPrompt = `
        Prexisting tags: ${existingTagsList}\n\n
        Prexisiting correspondent: ${existingCorrespondentList}\n\n
        ` + process.env.SYSTEM_PROMPT + '\n\n' + config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
        promptTags = '';
      } else {
        config.mustHavePrompt = config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
        systemPrompt = process.env.SYSTEM_PROMPT + '\n\n' + config.mustHavePrompt;
        promptTags = '';
      }

      if (process.env.USE_PROMPT_TAGS === 'yes') {
        promptTags = process.env.PROMPT_TAGS;
        systemPrompt = `
        Take these tags and try to match one or more to the document content.\n\n
        ` + config.specialPromptPreDefinedTags;
      }

      if (customPrompt) {
        console.log('[DEBUG] Replace system prompt with custom prompt via WebHook');
        systemPrompt = customPrompt + '\n\n' + config.mustHavePrompt;
      }
      
      // Rest of the function remains the same
      const totalPromptTokens = await this.calculateTotalPromptTokens(
        systemPrompt,
        process.env.USE_PROMPT_TAGS === 'yes' ? [promptTags] : []
      );
      
      const maxTokens = 128000;
      const reservedTokens = totalPromptTokens + 1000;
      const availableTokens = maxTokens - reservedTokens;
      
      const truncatedContent = await this.truncateToTokenLimit(content, availableTokens);
      
      await this.writePromptToFile(systemPrompt, truncatedContent);

      // Implement rate limit handling with original functionality
      return await this.throttleManager.enqueueRequest(async () => {
        return await this.rateLimitHandler.retryWithBackoff(async () => {
          try {
            console.log(`[OpenAI] Sending request to model ${model}`);
            
            // Prepare request info for tracking
            const requestInfo = {
              url: '/chat/completions',
              method: 'POST',
              model: model
            };
            
            let responseInfo = null;
            let error = null;
            
            try {
              const response = await this.client.chat.completions.create({
                model: model,
                messages: [
                  {
                    role: "system",
                    content: systemPrompt
                  },
                  {
                    role: "user",
                    content: truncatedContent
                  }
                ],
                temperature: 0.3,
              });
              
              responseInfo = response;
              
              // Extract and track rate limit headers
              if (response.headers) {
                console.log('[DEBUG] OpenAI API response headers:', JSON.stringify(response.headers));
                this.rateLimitTracker.updateFromHeaders(response.headers);
                
                // Store rate limit information in responseInfo for the ApiCallTracker
                responseInfo.headers = {
                  ...response.headers,
                  // Add standardized rate limit headers if they don't exist 
                  // but other OpenAI-specific headers are present
                  'x-ratelimit-remaining-requests': 
                    response.headers['x-ratelimit-remaining-requests'] || 
                    response.headers['x-ratelimit-remaining'] ||
                    null,
                  'x-ratelimit-remaining-tokens': 
                    response.headers['x-ratelimit-remaining-tokens'] || 
                    null,
                  'x-response-time': response.headers['x-response-time'] || 
                    response.latency || 
                    null
                };
                
                // Store the original headers as-is for debugging
                responseInfo.rawHeaders = { ...response.headers };
              }
              
              if (!response?.choices?.[0]?.message?.content) {
                throw new Error('Invalid API response structure');
              }
              
              console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
              console.log(`[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`);
              
              const usage = response.usage;
              const mappedUsage = {
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens
              };

              let jsonContent = response.choices[0].message.content;
              jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

              let parsedResponse;
              try {
                parsedResponse = JSON.parse(jsonContent);
                //write to file and append to the file (txt)
                fs.appendFile('./logs/response.txt', jsonContent, (err) => {
                  if (err) throw err;
                });
              } catch (error) {
                console.error('Failed to parse JSON response:', error);
                throw new Error('Invalid JSON response from API');
              }

              if (!parsedResponse || !Array.isArray(parsedResponse.tags) || typeof parsedResponse.correspondent !== 'string') {
                throw new Error('Invalid response structure: missing tags array or correspondent string');
              }

              return { 
                document: parsedResponse, 
                metrics: mappedUsage,
                truncated: truncatedContent.length < content.length
              };
            } catch (e) {
              error = e;
              throw e;
            } finally {
              // Track the API call
              this.apiCallTracker.trackApiCall(requestInfo, responseInfo, error);
            }
          } catch (error) {
            // Enhanced error logging for rate limits
            if (error?.response?.status === 429 || error?.status === 429) {
              console.error('[Rate Limit] OpenAI API error:', {
                message: error.message,
                headers: error.response?.headers,
                currentLimits: this.rateLimitTracker.limits
              });
            } else {
              console.error('[ERROR] OpenAI API request failed:', error.message);
            }
            throw error; // Rethrow to be handled by the rate limit handler
          }
        });
      });
    } catch (error) {
      console.error('Failed to analyze document:', error);
      return { 
        document: { tags: [], correspondent: null },
        metrics: null,
        error: error.message 
      };
    }
  }

  async writePromptToFile(systemPrompt, truncatedContent) {
    const filePath = './logs/prompt.txt';
    const maxSize = 10 * 1024 * 1024;
  
    try {
      const stats = await fs.stat(filePath);
      if (stats.size > maxSize) {
        await fs.unlink(filePath); // Delete the file if is biger 10MB
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[WARNING] Error checking file size:', error);
      }
    }
  
    try {
      await fs.appendFile(filePath, systemPrompt + truncatedContent + '\n\n');
    } catch (error) {
      console.error('[ERROR] Error writing to file:', error);
    }
  }

  async analyzePlayground(content, prompt) {
    try {
      this.initialize();
      
      if (!this.client) {
        throw new Error('OpenAI client not initialized');
      }

      const model = process.env.OPENAI_MODEL;
      console.log(`Using model: ${model}`);

      // Calculate tokens for content
      const contentTokens = await this.calculateTokens(content);
      const promptTokens = await this.calculateTokens(prompt);
      const totalTokens = contentTokens + promptTokens;
      
      console.log(`Content tokens: ${contentTokens}, Prompt tokens: ${promptTokens}, Total: ${totalTokens}`);
      
      // Check if we need to truncate
      let truncatedContent = content;
      const maxTokens = 128000 - 1000; // Reserve 1000 tokens for the response
      
      if (totalTokens > maxTokens) {
        console.log(`Total tokens (${totalTokens}) exceeds max limit (${maxTokens}), truncating...`);
        const availableContentTokens = maxTokens - promptTokens;
        truncatedContent = await this.truncateToTokenLimit(content, availableContentTokens);
        console.log(`Truncated content to ${await this.calculateTokens(truncatedContent)} tokens`);
      }

      // Use throttle manager and rate limit handler for playground requests too
      return await this.throttleManager.enqueueRequest(async () => {
        return await this.rateLimitHandler.retryWithBackoff(async () => {
          try {
            console.log('Sending request to OpenAI API...');
            
            const response = await this.client.chat.completions.create({
              model: model,
              messages: [
                {
                  role: "system",
                  content: prompt
                },
                {
                  role: "user",
                  content: truncatedContent
                }
              ],
              temperature: 0.3,
            });
            
            // Extract and track rate limit headers
            if (response.headers) {
              this.rateLimitTracker.updateFromHeaders(response.headers);
            }
            
            if (!response?.choices?.[0]?.message?.content) {
              throw new Error('Invalid API response structure');
            }
            
            console.log(`Response received, ${response.usage.total_tokens} tokens used`);
            
            return {
              content: response.choices[0].message.content,
              usage: {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens
              },
              truncated: truncatedContent.length < content.length
            };
          } catch (error) {
            // Enhanced error logging for rate limits
            if (error?.response?.status === 429 || error?.status === 429) {
              console.error('[Rate Limit] OpenAI API playground error:', {
                message: error.message,
                headers: error.response?.headers,
                currentLimits: this.rateLimitTracker.limits
              });
            } else {
              console.error('OpenAI API playground request failed:', error.message);
            }
            throw error; // Rethrow to be handled by the rate limit handler
          }
        });
      });
    } catch (error) {
      console.error('Failed to analyze in playground:', error);
      return { 
        content: null,
        usage: null,
        error: error.message
      };
    }
  }
}

module.exports = new OpenAIService();