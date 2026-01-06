// viib-etch.js
// LLM interface with OpenAI library, tool calling, streaming, and hooks

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { OpenAI } = require('openai');

let baseDir = __dirname;
let chatsDir = path.join(__dirname, 'chats')

function ensureDirExists(dirPath) {
  if (!dirPath) return;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (e) {
    // If it already exists or can't be created, let later fs ops surface the error.
  }
}

function setBaseDir(dirPath) {
  if (typeof dirPath !== 'string' || dirPath.trim() === '') {
    throw new Error('baseDir must be a non-empty string');
  }
  baseDir = dirPath;
}

function getBaseDir() {
  return baseDir;
}

function setChatsDir(dirPath) {
  if (typeof dirPath !== 'string' || dirPath.trim() === '') {
    throw new Error('chatsDir must be a non-empty string');
  }
  chatsDir = dirPath;
}

function getChatsDir() {
  return chatsDir;
}

class ChatModel {
  constructor(config) {
    this.name = config.name;
    this.model = config.model;
    this.base_url = config.base_url || config.baseUrl || 'https://api.openai.com/v1';
    this.reasoning_effort = config.reasoning_effort;
    this.api_key_file = config.api_key_file;
    this.system_prompt = config.system_prompt || config.systemPrompt || null;
    this.system_prompt_file = config.system_prompt_file || config.systemPromptFile || null;
    this.tools = Array.isArray(config.tools) ? config.tools : null;
    
    // Load API key - prioritize file if specified, then config, then env var
    if (this.api_key_file) {
      try {
        const keyPath = path.resolve(this.api_key_file);
        this.api_key = fs.readFileSync(keyPath, 'utf8').trim();
      } catch (err) {
        throw new Error(`Failed to load API key from ${this.api_key_file}: ${err.message}`);
      }
    } else {
      this.api_key = config.api_key || process.env.OPENAI_API_KEY;
    }
    
    if (!this.api_key) {
      throw new Error(`API key not provided for model ${this.name}`);
    }
  }

  readSystemPromptFileFresh() {
    if (!this.system_prompt_file) return null;
    try {
      const promptPath = path.resolve(this.system_prompt_file);
      return fs.readFileSync(promptPath, 'utf8');
    } catch (err) {
      throw new Error(`Failed to load system prompt from ${this.system_prompt_file}: ${err.message}`);
    }
  }
  
  static loadModels(modelsFile = path.join(getBaseDir(), 'viib-etch-models.json')) {
    try {
      const filePath = path.resolve(modelsFile);
      const content = fs.readFileSync(filePath, 'utf8');
      const models = JSON.parse(content);
      return models.map(config => new ChatModel(config));
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`Models file not found: ${modelsFile}`);
      }
      throw new Error(`Failed to load models: ${err.message}`);
    }
  }
  
  static getModel(models, name) {
    const model = models.find(m => m.name === name);
    if (!model) {
      throw new Error(`Model not found: ${name}`);
    }
    return model;
  }
}

class ChatSession {
  constructor(data = {}) {
    this.id = data.id || this.generateId();
    this.title = data.title || null;
    this.model_name = data.model_name || null;
    this.messages = data.messages || [];
    this.data = data.data || {};
    this.persistent = data.persistent === true;
    this._model = null;
  }
  
  generateId() {
    const ts = String(Date.now());
    const hash10 = crypto.createHash('sha256').update(ts).digest().subarray(0, 10).toString('hex');
    return `${hash10}`;
  }
  
  static setChatsDir(dirPath) {
    setChatsDir(dirPath);
  }

  static getChatsDir() {
    return getChatsDir();
  }

  static getFileName(chatId) {
    return path.join(getChatsDir(), `chat.${chatId}.json`);
  }
  
  getFileName() {
    return ChatSession.getFileName(this.id);
  }

  enablePersistence(dirPath = null) {
    if (dirPath) setChatsDir(dirPath);
    this.persistent = true;
    this.save();
  }

  disablePersistence() {
    this.persistent = false;
  }

  attachModel(model) {
    if (!(model instanceof ChatModel)) {
      throw new Error('model must be an instance of ChatModel');
    }
    this._model = model;
    this.model_name = model.name;
  }
  
  static load(chatId) {
    try {
      const filePath = path.resolve(ChatSession.getFileName(chatId));
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      const session = new ChatSession(data);
      session.persistent = true;
      return session;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw new Error(`Failed to load chat ${chatId}: ${err.message}`);
    }
  }
  
  static listChatSessions() {
    const dir = getChatsDir();
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir);
    const chatSessions = [];
    
    for (const file of files) {
      if (file.startsWith('chat.') && file.endsWith('.json')) {
        // Extract chat ID from filename: chat.<id>.json
        const match = file.match(/^chat\.(.+)\.json$/);
        if (match) {
          const chatId = match[1];
          try {
            const session = ChatSession.load(chatId);
            if (session) {
              const absPath = path.resolve(path.join(dir, file));
              chatSessions.push({
                id: session.id,
                title: session.title,
                model_name: session.model_name,
                message_count: session.messages.length,
                created: fs.statSync(absPath).birthtime,
                modified: fs.statSync(absPath).mtime
              });
            }
          } catch (err) {
            // Skip invalid chat files
            console.warn(`Skipping invalid chat file ${file}: ${err.message}`);
          }
        }
      }
    }
    
    // Sort by modified time, most recent first
    chatSessions.sort((a, b) => b.modified - a.modified);
    
    return chatSessions;
  }
  
  save() {
    if (!this.persistent) return;
    ensureDirExists(getChatsDir());
    const fileName = this.getFileName();
    const filePath = path.resolve(fileName);
    const data = {
      id: this.id,
      title: this.title,
      model_name: this.model_name,
      messages: this.messages,
      data: this.data
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  addMessage(message) {
    this.messages.push(message);
    this.save();
    return message;
  }

  getMessagesForAPI() {
    // If a system prompt file is configured, always read it fresh and ensure it is the first message.
    // - If first message is system: replace it
    // - If first message is not system: add it
    if (this._model && this._model.system_prompt_file) {
      const freshPrompt = this._model.readSystemPromptFileFresh();
      const content = (freshPrompt === null || freshPrompt === undefined) ? '' : String(freshPrompt);
      if (this.messages.length === 0) {
        this.messages.unshift({ role: 'system', content });
      } else if (this.messages[0] && this.messages[0].role === 'system') {
        this.messages[0].content = content;
      } else {
        this.messages.unshift({ role: 'system', content });
      }
    } else if (this._model && this._model.system_prompt && (this.messages.length === 0 || this.messages[0].role !== 'system')) {
      // Back-compat: if system_prompt string exists, only add it if missing.
      this.messages.unshift({ role: 'system', content: this._model.system_prompt });
    }
    
    // Convert chat messages to OpenAI API format
    return this.messages.map(msg => {
      const apiMsg = { role: msg.role };
      
      if (msg.role === 'assistant' && typeof msg.content === 'object' && msg.content !== null) {
        // If content is structured, extract the main content
        if (msg.content.content !== undefined && msg.content.content !== null) {
          apiMsg.content = msg.content.content;
        } else {
          apiMsg.content = '';
        }
        
        // Include tool calls if present (ensure it's an array)
        if (msg.content.tool_call) {
          apiMsg.tool_calls = Array.isArray(msg.content.tool_call) 
            ? msg.content.tool_call 
            : [msg.content.tool_call];
        }
      } else if (msg.role === 'assistant') {
        // Handle assistant messages (string content). Never send null to API.
        apiMsg.content = (msg.content === null || msg.content === undefined) ? '' : String(msg.content);
        // Check for tool_calls at top level (non-streaming format)
        if (msg.tool_calls) {
          apiMsg.tool_calls = msg.tool_calls;
        } else if (msg.tool_call) {
          // Back-compat: some code may store tool calls as `tool_call`
          apiMsg.tool_calls = Array.isArray(msg.tool_call) ? msg.tool_call : [msg.tool_call];
        }
      } else if (msg.role === 'user' || msg.role === 'system') {
        apiMsg.content = (msg.content === null || msg.content === undefined) ? '' : String(msg.content);
      } else if (msg.role === 'tool') {
        apiMsg.content = (msg.content === null || msg.content === undefined) ? '' : String(msg.content);
        apiMsg.tool_call_id = msg.tool_call_id;
        apiMsg.name = msg.name;
      }
      
      return apiMsg;
    }).filter(msg => msg !== null && msg.role !== undefined);
  }
}

class ChatLLM {
  constructor(model_name, chat = null, tools = null, hooks = {}) {
    this.chat = chat || new ChatSession({ model_name: model_name });
    if (model_name && !this.chat.model_name) {
      this.chat.model_name = model_name;
    }
    this._model = null;
    this._client = null;
    this.tools = tools || null;
    this.hooks = {
      onRequestStart: hooks.onRequestStart || null,
      onRequestDone: hooks.onRequestDone || null,
      onReasoningStart: hooks.onReasoningStart || null,
      onReasoningData: hooks.onReasoningData || null,
      onReasoningDone: hooks.onReasoningDone || null,
      onResponseStart: hooks.onResponseStart || null,
      onResponseData: hooks.onResponseData || null,
      onResponseDone: hooks.onResponseDone || null,
      onToolCallStart: hooks.onToolCallStart || null,
      onToolCallData: hooks.onToolCallData || null,
      onToolCallEnd: hooks.onToolCallEnd || null,
      onTitle: hooks.onTitle || null
    };
  }
  
  static newChatSession(model_name, persistent = false, tools = null, hooks = {}) {
    if (typeof model_name !== 'string' || model_name.trim() === '') {
      throw new Error('model_name must be a non-empty string');
    }
    const chat = new ChatSession({ model_name: model_name });
    if (persistent) {
      chat.enablePersistence(typeof persistent === 'string' ? persistent : null);
    }

    // If caller didn't provide tools, default to model's configured tool-name list (if any),
    // resolving names -> tool definitions from viib-etch-tools.json.
    if (tools === null || tools === undefined) {
      try {
        const models = ChatModel.loadModels();
        const resolved = models.find(m => m.name === model_name);
        if (resolved && Array.isArray(resolved.tools) && resolved.tools.length > 0) {
          const { getToolDefinitions } = require(path.join(__dirname, 'viib-etch-tools'))
          const toolsPath = path.join(getBaseDir(), 'viib-etch-tools.json')
          tools = getToolDefinitions(toolsPath, resolved.tools)
        }
      } catch (e) {
        // Best-effort only; fall back to no tools.
      }
    }

    return new ChatLLM(model_name, chat, tools, hooks);
  }

  _ensureModelResolved() {
    // Ensures `_model` is available for request params (model id, reasoning_effort, etc.)
    if (!this._model) {
      const models = ChatModel.loadModels();
      const resolved = models.find(m => m.name === this.chat.model_name);
      if (!resolved) throw new Error(`Model not found: ${this.chat.model_name}`);
      this._model = resolved;
      // Keep chat._model in sync if caller uses it for inspection
      this.chat._model = resolved;
      // Reset client if model changes
      this._client = null;
    }
    return this._model;
  }

  getClient() {
    const model = this._ensureModelResolved();
    if (!this._client) {
      this._client = new OpenAI({
        apiKey: model.api_key,
        baseURL: model.base_url
      });
    }
    return this._client;
  }

  get client() {
    return this.getClient();
  }
  
  // Get the last assistant message's response_id and index (for /v1/responses API continuation)
  _getLastResponseId() {
    // Find the last assistant message with response_id and return both the id and its index
    for (let i = this.chat.messages.length - 1; i >= 0; i--) {
      const msg = this.chat.messages[i];
      if (msg.role === 'assistant' && msg.response_id) {
        return { response_id: msg.response_id, index: i };
      }
    }
    return null;
  }
  
  // Get messages to send for responses API - either all messages or only new ones after last response_id
  _getMessagesForResponsesAPI() {
    const toResponsesInput = (messages) => {
      const input = [];
      for (const msg of messages || []) {
        if (!msg || typeof msg !== 'object') continue;

        // Tool outputs must be sent as function_call_output items (NOT role:'tool')
        if (msg.role === 'tool') {
          if (!msg.tool_call_id) {
            throw new Error('tool message missing tool_call_id (required for responses API)');
          }
          input.push({
            type: 'function_call_output',
            call_id: msg.tool_call_id,
            output: (msg.content === null || msg.content === undefined) ? '' : String(msg.content),
          });
          continue;
        }

        // Assistant tool calls (if present) should be represented explicitly as function_call items
        // so a full-history "restart" can replay the tool call + its output.
        if (msg.role === 'assistant') {
          const content = (msg.content === null || msg.content === undefined) ? '' : String(msg.content);
          if (content) {
            input.push({ role: 'assistant', content });
          } else {
            // Keep assistant turn even if empty if it contains tool calls
            // (some models produce tool calls with empty textual content)
            if (msg.tool_calls || msg.tool_call) {
              input.push({ role: 'assistant', content: '' });
            }
          }

          const toolCalls = msg.tool_calls
            ? msg.tool_calls
            : (msg.tool_call ? (Array.isArray(msg.tool_call) ? msg.tool_call : [msg.tool_call]) : null);

          if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              const callId = tc?.id;
              const name = tc?.function?.name;
              const args = tc?.function?.arguments;
              if (!callId || !name) continue;
              input.push({
                type: 'function_call',
                call_id: String(callId),
                name: String(name),
                arguments: (args === null || args === undefined) ? '' : String(args),
              });
            }
          }
          continue;
        }

        // user/system/developer messages
        if (msg.role === 'user' || msg.role === 'system' || msg.role === 'developer') {
          input.push({
            role: msg.role,
            content: (msg.content === null || msg.content === undefined) ? '' : String(msg.content),
          });
          continue;
        }

        // If we ever see an unknown role, drop it (better than sending invalid role to API)
      }
      return input;
    };

    const lastResponseInfo = this._getLastResponseId();
    if (!lastResponseInfo) {
      // No previous response_id -> full-history send.
      // Apply system prompt file rules here via ChatSession (insert/replace first system message).
      this.chat.getMessagesForAPI();
      // No previous response_id - send all messages
      return { input: toResponsesInput(this.chat.messages), response_id: null };
    }
    
    // Get only messages after the last assistant message with response_id
    const messagesAfterLastResponse = this.chat.messages.slice(lastResponseInfo.index + 1);
    if (messagesAfterLastResponse.length === 0) {
      // No new messages - just use response_id
      return { input: null, response_id: lastResponseInfo.response_id };
    }

    return { input: toResponsesInput(messagesAfterLastResponse), response_id: lastResponseInfo.response_id };
  }

  // Normalize tool definitions for /v1/responses API.
  //
  // The OpenAI Node SDK (and /v1/responses) expects "function" tools in this shape:
  //   { type: 'function', name: string, description?: string, parameters: object|null, strict?: boolean|null }
  //
  // Whereas /v1/chat/completions uses:
  //   { type: 'function', function: { name, description, parameters, strict? } }
  //
  // We accept either and convert to the responses shape.
  _normalizeToolsForResponses(tools) {
    if (!tools) return null;
    if (!Array.isArray(tools)) {
      throw new Error('tools must be an array');
    }

    const coerceSchema = (schema) => {
      if (!schema || typeof schema !== 'object') return schema;
      if (Array.isArray(schema)) return schema.map(coerceSchema);

      // Clone so we don't mutate caller-owned objects.
      const out = { ...schema };

      // If this is an object schema, Responses strict validation requires additionalProperties: false.
      if (out.type === 'object' || out.properties) {
        if (out.additionalProperties === undefined) {
          out.additionalProperties = false;
        }
        if (out.properties && typeof out.properties === 'object') {
          const newProps = {};
          for (const [k, v] of Object.entries(out.properties)) {
            newProps[k] = coerceSchema(v);
          }
          out.properties = newProps;
        }
        if (out.patternProperties && typeof out.patternProperties === 'object') {
          const newProps = {};
          for (const [k, v] of Object.entries(out.patternProperties)) {
            newProps[k] = coerceSchema(v);
          }
          out.patternProperties = newProps;
        }
      }

      // Arrays
      if (out.items !== undefined) {
        out.items = coerceSchema(out.items);
      }

      // Composition keywords (best-effort)
      for (const key of ['anyOf', 'oneOf', 'allOf']) {
        if (Array.isArray(out[key])) {
          out[key] = out[key].map(coerceSchema);
        }
      }
      if (out.not) out.not = coerceSchema(out.not);

      return out;
    };

    return tools.map((tool) => {
      if (!tool || typeof tool !== 'object') {
        throw new Error('Each tool must be an object');
      }

      // Pass through non-function tools (web_search, file_search, etc.) as-is.
      if (tool.type !== 'function') {
        return tool;
      }

      // Already in /v1/responses shape
      if (typeof tool.name === 'string') {
        // Responses defaults strict=true, but many existing tool schemas in this repo
        // have optional properties; strict mode requires a fully-closed schema
        // (e.g., additionalProperties:false and required includes every property).
        // So we default to strict=false unless explicitly enabled.
        const strict = tool.strict ?? false;
        return {
          ...tool,
          type: 'function',
          name: tool.name,
          description: tool.description ?? null,
          parameters: strict ? coerceSchema(tool.parameters ?? null) : (tool.parameters ?? null),
          strict,
        };
      }

      // Convert from /v1/chat/completions function tool shape
      if (tool.function && typeof tool.function === 'object' && typeof tool.function.name === 'string') {
        const strict = tool.function.strict ?? tool.strict ?? false;
        const rawParams = tool.function.parameters ?? null;
        return {
          type: 'function',
          name: tool.function.name,
          description: tool.function.description ?? tool.description ?? null,
          parameters: strict ? coerceSchema(rawParams) : rawParams,
          strict,
        };
      }

      throw new Error(
        `Invalid function tool format. Expected {type:'function', name, parameters} or {type:'function', function:{name, parameters}}`,
      );
    });
  }

  _extractToolCallsFromResponsesOutput(outputItems) {
    if (!Array.isArray(outputItems)) return null;
    const toolCalls = [];
    for (const item of outputItems) {
      if (!item || typeof item !== 'object') continue;
      if (item.type !== 'function_call') continue;
      toolCalls.push({
        id: item.call_id || item.id || '',
        type: 'function',
        function: {
          name: item.name || '',
          arguments: item.arguments || '',
        },
      });
    }
    return toolCalls.length > 0 ? toolCalls : null;
  }

  _mergeUsage(acc, usage) {
    if (!usage) return acc;
    if (!acc) return { ...usage };

    // chat.completions usage shape
    if (typeof usage.prompt_tokens === 'number' || typeof acc.prompt_tokens === 'number') {
      return {
        ...acc,
        prompt_tokens: (acc.prompt_tokens || 0) + (usage.prompt_tokens || 0),
        completion_tokens: (acc.completion_tokens || 0) + (usage.completion_tokens || 0),
        total_tokens: (acc.total_tokens || 0) + (usage.total_tokens || 0),
      };
    }

    // /v1/responses usage shape
    if (typeof usage.input_tokens === 'number' || typeof acc.input_tokens === 'number') {
      return {
        ...acc,
        input_tokens: (acc.input_tokens || 0) + (usage.input_tokens || 0),
        output_tokens: (acc.output_tokens || 0) + (usage.output_tokens || 0),
        total_tokens: (acc.total_tokens || 0) + (usage.total_tokens || 0),
        input_tokens_details: usage.input_tokens_details || acc.input_tokens_details,
        output_tokens_details: usage.output_tokens_details || acc.output_tokens_details,
      };
    }

    // Fallback: keep last fields
    return { ...acc, ...usage };
  }
  
  // Check if model should use /v1/responses API (GPT and newer than GPT-4)
  _shouldUseResponsesAPI() {
    const model = this._ensureModelResolved();
    const modelName = model.model.toLowerCase();
    
    // Check if it's a GPT model
    if (!modelName.startsWith('gpt-')) {
      return false;
    }
    
    // Check if it's newer than GPT-4
    // Models like gpt-4o, gpt-4-turbo, gpt-5, etc. should use responses API
    // But gpt-4, gpt-4.1, gpt-4.1-mini, etc. should NOT use it
    if (modelName === 'gpt-4' || modelName.startsWith('gpt-4.')) {
      return false; // Exclude gpt-4, gpt-4.1, gpt-4.1-mini, etc.
    }
    
    // Extract version number - check for gpt-4o, gpt-4-turbo, or gpt-5+ patterns
    const parts = modelName.split('-');
    if (parts.length >= 2) {
      const version = parts[1];
      // Check for gpt-4o variants (gpt-4o, gpt-4o-mini, etc.)
      if (version.startsWith('4o')) {
        return true; // gpt-4o, gpt-4o-mini, etc.
      }
      // Check for gpt-4-turbo variants
      if (version.startsWith('4-turbo') || version === '4turbo') {
        return true; // gpt-4-turbo, etc.
      }
      // Check for gpt-5 or higher
      const versionNum = parseInt(version);
      if (versionNum > 4) {
        return true; // gpt-5, gpt-6, etc.
      }
    }
    
    return false;
  }
  
  async callHook(hookName, ...args) {
    const hook = this.hooks[hookName];
    if (hook && typeof hook === 'function') {
      try {
        await hook(...args);
      } catch (err) {
        console.error(`Error in hook ${hookName}:`, err);
      }
    }
  }
  
  async _generateTitle() {
    // Only generate title if not already set and we have messages
    if (this.chat.title && this.chat.title.trim() !== '') {
      return;
    }
    
    const userMessages = this.chat.messages.filter(msg => msg.role === 'user');
    const assistantMessages = this.chat.messages.filter(msg => msg.role === 'assistant');
    
    // Only generate title if we have at least one user message and one assistant response
    if (userMessages.length === 0 || assistantMessages.length === 0) {
      return;
    }
    
    try {
      const model = this._ensureModelResolved();
      const client = this.getClient();
      
      // Create a title generation request with the first exchange
      const titleMessages = [
        {
          role: 'system',
          content: 'Generate a concise, descriptive title (maximum 10 words) for this conversation based on the user\'s request and your response. Return only the title, nothing else.'
        },
        {
          role: 'user',
          content: userMessages[0].content || ''
        }
      ];
      
      // Include first assistant response if available
      if (assistantMessages[0] && assistantMessages[0].content) {
        titleMessages.push({
          role: 'assistant',
          content: String(assistantMessages[0].content).substring(0, 500) // Limit context
        });
      }
      
      // Use max_completion_tokens for newer models (GPT-5+), max_tokens for older models
      const modelName = model.model.toLowerCase();
      const useMaxCompletionTokens = modelName.startsWith('gpt-5') || modelName.startsWith('gpt-4o') || modelName.startsWith('gpt-4-turbo');
      
      const titleParams = {
        model: model.model,
        messages: titleMessages,
      };
      
      if (useMaxCompletionTokens) {
        titleParams.max_completion_tokens = 50;
      } else {
        titleParams.max_tokens = 50;
      }
      
      const response = await client.chat.completions.create(titleParams);
      
      const title = response.choices[0]?.message?.content?.trim();
      if (title) {
        // Clean up the title - remove quotes, extra whitespace, etc.
        const cleanTitle = title.replace(/^["']|["']$/g, '').trim();
        if (cleanTitle && cleanTitle.length > 0) {
          this.chat.title = cleanTitle.substring(0, 200); // Cap at 200 chars
          this.chat.save();
          // Call onTitle hook
          await this.callHook('onTitle', this.chat.title);
        }
      }
    } catch (err) {
      // Silently fail - title generation is best-effort
    }
  }

  async complete(options = {}) {
    const {
      tools = this.tools,
      stream = false,
      temperature = null,
      max_tokens = null,
      reasoning_effort = null,
      max_iterations = 100,
      timeout_ms = null,
      ...extraOptions
    } = options;

    const model = this._ensureModelResolved();
    const effectiveTools = tools !== null ? tools : this.tools;
    
     // Build base params (messages are injected per-iteration inside _completeNoStream/_completeStream)
     const params = {
       model: model.model,
       max_iterations: max_iterations,
       ...extraOptions
     };
 
     if (effectiveTools) {
       params.tools = effectiveTools;
       // Always auto when tools are present
       params.tool_choice = 'auto';
     }
 
     if (temperature !== null) {
       params.temperature = temperature;
     }
 
     if (max_tokens !== null) {
       params.max_tokens = max_tokens;
     }
 
     // reasoning_effort: explicit option wins; else model default (if not "off")
     const eff = (reasoning_effort !== null && reasoning_effort !== 'off')
       ? reasoning_effort
       : (model.reasoning_effort && model.reasoning_effort !== 'off' ? model.reasoning_effort : null);
     if (eff) {
       params.reasoning_effort = eff;
     }
    
    // Route to appropriate API method
    const useResponsesAPI = this._shouldUseResponsesAPI();
    // Request options (OpenAI SDK): support timeout via AbortController.
    // IMPORTANT: request options must NOT be included in the API body.
    let requestOptions = undefined;
    let timeoutId = null;
    if (timeout_ms !== null && timeout_ms !== undefined) {
      const ms = Number(timeout_ms);
      if (!Number.isFinite(ms) || ms <= 0) {
        throw new Error('timeout_ms must be a positive number (milliseconds)');
      }
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), ms);
      requestOptions = { signal: controller.signal };
    }

    try {
      const p = stream
        ? (useResponsesAPI
          ? this._completeStreamResponses(params, requestOptions)
          : this._completeStream(params, requestOptions))
        : (useResponsesAPI
          ? this._completeNoStreamResponses(params, requestOptions)
          : this._completeNoStream(params, requestOptions));

      // IMPORTANT: await so timeout cleanup happens after completion, not immediately.
      return await p;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
  
  // /v1/chat/completions API - non-streaming
  async _completeNoStream(params, requestOptions = undefined) {
    const max_iterations = params.max_iterations || 100;
    const tool_choice = params.tool_choice || 'auto';
    const tools = params.tools;
    delete params.max_iterations; // Remove from API params
    
    let iteration = 0;
    let lastResult = null;
    let accumulatedUsage = null;
    
    while (iteration < max_iterations) {
      // Build request parameters for this iteration
      const requestParams = {
        ...params,
        messages: this.chat.getMessagesForAPI()
      };
      
      if (tools) {
        requestParams.tools = tools;
        requestParams.tool_choice = iteration === 0 ? tool_choice : 'auto';
      }
      
      const requestStartTime = Date.now();
      await this.callHook('onRequestStart');
      const response = await this.client.chat.completions.create(requestParams, requestOptions);
      const requestDoneTime = Date.now();
      const requestElapsed = requestDoneTime - requestStartTime;
      await this.callHook('onRequestDone', requestElapsed);
      
      const choice = response.choices[0];
      const message = choice.message;

      // Accumulate usage
      if (response.usage) {
        accumulatedUsage = this._mergeUsage(accumulatedUsage, response.usage);
      }

      // Build structured assistant message
      const assistantMessage = {
        role: message.role || 'assistant',
         content: (message.content === null || message.content === undefined) ? '' : message.content,
        reasoning: null,
        tool_calls: null
      };
      
      let firstEventAfterRequestDone = true;
      
      // Check if there's reasoning in the response (for o1 models)
      if (message.reasoning) {
        const reasoningStartTime = Date.now();
        const sinceRequestDone = firstEventAfterRequestDone ? Date.now() - requestDoneTime : null;
        await this.callHook('onReasoningStart', sinceRequestDone);
        firstEventAfterRequestDone = false;
        await this.callHook('onReasoningData', message.reasoning);
        assistantMessage.reasoning = message.reasoning;
        const reasoningElapsed = Date.now() - reasoningStartTime;
        await this.callHook('onReasoningDone', message.reasoning, reasoningElapsed);
      }
      
      // Handle tool calls
      if (message.tool_calls && message.tool_calls.length > 0) {
        assistantMessage.tool_calls = message.tool_calls;
      }
      
      // Handle response content
      if (message.content) {
        const responseStartTime = Date.now();
        const sinceRequestDone = firstEventAfterRequestDone ? Date.now() - requestDoneTime : null;
        await this.callHook('onResponseStart', sinceRequestDone);
        firstEventAfterRequestDone = false;
        await this.callHook('onResponseData', message.content);
        const responseElapsed = Date.now() - responseStartTime;
        await this.callHook('onResponseDone', message.content, responseElapsed);
      }
      
      // Add message to chat
      this.chat.addMessage(assistantMessage);
      
      // Generate title if not already set
      if (assistantMessage.content) {
        await this._generateTitle();
      }
      
      lastResult = {
        message,
        content: message.content,
        tool_calls: message.tool_calls,
        reasoning: message.reasoning,
        usage: accumulatedUsage || response.usage,
        finish_reason: choice.finish_reason
      };
      
      // Automatically execute tool calls if present
      if (message.tool_calls && message.tool_calls.length > 0) {
        await this._executeToolCallsInternal({
          tool_calls: message.tool_calls
        });
        // Continue loop for next iteration
        iteration++;
      } else {
        // No tool calls, we're done
        return lastResult;
      }
    }
    
    // Max iterations reached
    return lastResult;
  }
  
  // /v1/responses API - non-streaming
  async _completeNoStreamResponses(params, requestOptions = undefined) {
    const max_iterations = params.max_iterations || 100;
    const tool_choice = params.tool_choice || 'auto';
    const tools = params.tools;
    delete params.max_iterations; // Remove from API params
    
    let iteration = 0;
    let lastResult = null;
    let accumulatedUsage = null;
    
    while (iteration < max_iterations) {
      // Build base request parameters
      const requestParams = { ...params };

      // /v1/responses expects function tools to have top-level `name` (not `function.name`).
      if (tools) {
        requestParams.tools = this._normalizeToolsForResponses(tools);
        requestParams.tool_choice = iteration === 0 ? tool_choice : 'auto';
      }
      
      // Transform reasoning_effort to reasoning.effort for responses API
      if (requestParams.reasoning_effort) {
        requestParams.reasoning = { effort: requestParams.reasoning_effort };
        delete requestParams.reasoning_effort;
      }
      
      // Get messages to send (either all or only new ones after last response_id)
      let messagesInfo = this._getMessagesForResponsesAPI();
      let response;
      let responseIdFromAPI = null;
      
      const requestStartTime = Date.now();
      await this.callHook('onRequestStart');
      
      try {
        // Prepare responses API parameters
        const responsesParams = { ...requestParams };
        
        // Try using previous_response_id for continuation if available
        if (messagesInfo.response_id) {
          responsesParams.previous_response_id = messagesInfo.response_id;
        }
        // Always include input if available, even if response_id is present (for new messages)
        if (messagesInfo.input && messagesInfo.input.length > 0) {
          responsesParams.input = messagesInfo.input;
        } else if (!messagesInfo.response_id) {
          // If no previous_response_id and no input, we need input (shouldn't happen, but safety check)
          throw new Error('Cannot create response without input or previous_response_id');
        }
        
        const originalResponse = await this.client.responses.create(responsesParams, requestOptions);
        
        // Store the response_id before transforming
        responseIdFromAPI = originalResponse.id;
        
        // Transform /v1/responses -> chat/completions-like shape
        const toolCalls = this._extractToolCallsFromResponsesOutput(originalResponse.output);
        response = {
          choices: [{
            message: {
              role: 'assistant',
              content: originalResponse.output_text ?? null,
              tool_calls: toolCalls,
            },
            finish_reason: null,
          }],
          usage: originalResponse.usage || null,
        };
      } catch (error) {
        // Check for tools format errors
        const errorMsg = error.message || '';
        if (error.status === 400 && errorMsg.includes('tools') && errorMsg.includes('name')) {
          // Tools format error - log details and re-throw
          console.error('Tools format error:', {
            tools: tools ? tools.map(t => ({
              type: t?.type,
              name: t?.name,
              functionName: t?.function?.name
            })) : null,
            error: errorMsg
          });
          throw new Error(
            `Tools format error: ${errorMsg}. For /v1/responses use {type:'function', name, description?, parameters, strict?} (or pass chat-style tools and we'll normalize).`,
          );
        }
        
        // If previous_response_id is invalid (404) or unknown parameter (400), retry with all messages
        const isResponseIdError = error.status === 404 || error.code === 'not_found' || 
            (error.response && error.response.status === 404) ||
            (errorMsg.includes('404') || errorMsg.includes('not found') || errorMsg.includes('not_found')) ||
            (error.status === 400 && errorMsg.includes('Unknown parameter') && (errorMsg.includes('previous_response_id') || errorMsg.includes('response_id')));
        
        if (isResponseIdError || (error.status === 400 && (errorMsg.includes('previous_response_id') || errorMsg.includes('response_id')))) {
          // Clear the stored response_id from the last assistant message
          const lastResponseInfo = this._getLastResponseId();
          if (lastResponseInfo) {
            // Remove response_id from the assistant message that has it
            const msgWithResponseId = this.chat.messages[lastResponseInfo.index];
            if (msgWithResponseId && msgWithResponseId.response_id) {
              delete msgWithResponseId.response_id;
              // Save the updated message
              if (this.chat.persistent) {
                this.chat.save();
              }
            }
          }
          
          // Get all messages for retry
          const allMessages = this._getMessagesForResponsesAPI().input;
          const retryParams = { ...requestParams };
            retryParams.input = allMessages;
          // Transform reasoning_effort to reasoning.effort for responses API
          if (retryParams.reasoning_effort) {
            retryParams.reasoning = { effort: retryParams.reasoning_effort };
            delete retryParams.reasoning_effort;
          }
          // Don't include response_id in retry
          
          const originalResponse = await this.client.responses.create(retryParams, requestOptions);
          responseIdFromAPI = originalResponse.id;
          
          const toolCalls = this._extractToolCallsFromResponsesOutput(originalResponse.output);
          response = {
            choices: [{
              message: {
                role: 'assistant',
                content: originalResponse.output_text ?? null,
                tool_calls: toolCalls,
              },
              finish_reason: null,
            }],
            usage: originalResponse.usage || null,
          };
        } else {
          // Re-throw other errors
          throw error;
        }
      }
      
      const requestDoneTime = Date.now();
      const requestElapsed = requestDoneTime - requestStartTime;
      await this.callHook('onRequestDone', requestElapsed);
      
      const choice = response.choices[0];
      const message = choice.message;

      // Accumulate usage
      if (response.usage) {
        accumulatedUsage = this._mergeUsage(accumulatedUsage, response.usage);
      }

      // Build structured assistant message
      const assistantMessage = {
        role: message.role || 'assistant',
         content: (message.content === null || message.content === undefined) ? '' : message.content,
        reasoning: null,
        tool_calls: null
      };
      
      // Store response_id in assistant message
      if (responseIdFromAPI) {
        assistantMessage.response_id = responseIdFromAPI;
      }
      
      let firstEventAfterRequestDone = true;
      
      // Check if there's reasoning in the response (for o1 models)
      if (message.reasoning) {
        const reasoningStartTime = Date.now();
        const sinceRequestDone = firstEventAfterRequestDone ? Date.now() - requestDoneTime : null;
        await this.callHook('onReasoningStart', sinceRequestDone);
        firstEventAfterRequestDone = false;
        await this.callHook('onReasoningData', message.reasoning);
        assistantMessage.reasoning = message.reasoning;
        const reasoningElapsed = Date.now() - reasoningStartTime;
        await this.callHook('onReasoningDone', message.reasoning, reasoningElapsed);
      }
      
      // Handle tool calls
      if (message.tool_calls && message.tool_calls.length > 0) {
        assistantMessage.tool_calls = message.tool_calls;
      }
      
      // Handle response content
      if (message.content) {
        const responseStartTime = Date.now();
        const sinceRequestDone = firstEventAfterRequestDone ? Date.now() - requestDoneTime : null;
        await this.callHook('onResponseStart', sinceRequestDone);
        firstEventAfterRequestDone = false;
        await this.callHook('onResponseData', message.content);
        const responseElapsed = Date.now() - responseStartTime;
        await this.callHook('onResponseDone', message.content, responseElapsed);
      }
      
      // Add message to chat (this will save the response_id with the message)
      this.chat.addMessage(assistantMessage);
      
      // Generate title if not already set
      if (assistantMessage.content) {
        await this._generateTitle();
      }
      
      lastResult = {
        message,
        content: message.content,
        tool_calls: message.tool_calls,
        reasoning: message.reasoning,
        usage: accumulatedUsage || response.usage,
        finish_reason: choice.finish_reason ?? null
      };
      
      // Automatically execute tool calls if present
      if (message.tool_calls && message.tool_calls.length > 0) {
        await this._executeToolCallsInternal({
          tool_calls: message.tool_calls
        });
        // Continue loop for next iteration
        iteration++;
      } else {
        // No tool calls, we're done
        return lastResult;
      }
    }
    
    // Max iterations reached
    return lastResult;
  }
  
  // /v1/chat/completions API - streaming
  async _completeStream(params, requestOptions = undefined) {
    const max_iterations = params.max_iterations || 100;
    const tool_choice = params.tool_choice || 'auto';
    const tools = params.tools;
    delete params.max_iterations; // Remove from API params
    
    let iteration = 0;
    let lastResult = null;
    
    while (iteration < max_iterations) {
      // Build request parameters for this iteration
      const requestParams = {
        ...params,
        messages: this.chat.getMessagesForAPI(),
        stream: true
      };
      
      if (tools) {
        requestParams.tools = tools;
        requestParams.tool_choice = iteration === 0 ? tool_choice : 'auto';
      }
      
      const requestStartTime = Date.now();
      await this.callHook('onRequestStart');
      const stream = await this.client.chat.completions.create(requestParams, requestOptions);
      const requestDoneTime = Date.now();
      const requestElapsed = requestDoneTime - requestStartTime;
      await this.callHook('onRequestDone', requestElapsed);
      
      let fullContent = '';
      let fullReasoning = '';
      const toolCalls = {};
      let hasStartedReasoning = false;
      let hasStartedResponse = false;
      let reasoningStartTime = null;
      let responseStartTime = null;
      let firstEventAfterRequestDone = true;
      
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        
        const delta = choice.delta;
        
        // Handle reasoning (for o1 models)
        if (delta.reasoning) {
          if (!hasStartedReasoning) {
            reasoningStartTime = Date.now();
            const sinceRequestDone = firstEventAfterRequestDone ? Date.now() - requestDoneTime : null;
            await this.callHook('onReasoningStart', sinceRequestDone);
            firstEventAfterRequestDone = false;
            hasStartedReasoning = true;
          }
          fullReasoning += delta.reasoning;
          await this.callHook('onReasoningData', delta.reasoning);
        }
        
        // Handle content
        if (delta.content) {
          if (!hasStartedResponse) {
            responseStartTime = Date.now();
            const sinceRequestDone = firstEventAfterRequestDone ? Date.now() - requestDoneTime : null;
            await this.callHook('onResponseStart', sinceRequestDone);
            firstEventAfterRequestDone = false;
            hasStartedResponse = true;
          }
          fullContent += delta.content;
          await this.callHook('onResponseData', delta.content);
        }
        
      // Handle tool calls (accumulate only; hooks are fired around tool execution)
      if (delta.tool_calls) {
        for (const toolCallDelta of delta.tool_calls) {
          const index = toolCallDelta.index;
          
          if (!toolCalls[index]) {
            toolCalls[index] = {
              id: toolCallDelta.id || '',
              type: 'function',
              function: {
                name: toolCallDelta.function?.name || '',
                arguments: toolCallDelta.function?.arguments || ''
              }
            };
          } else {
            // Update ID if provided
            if (toolCallDelta.id) {
              toolCalls[index].id = toolCallDelta.id;
            }
            
            // Update name if provided
            if (toolCallDelta.function?.name) {
              toolCalls[index].function.name = toolCallDelta.function.name;
            }
            
            // Append to tool call arguments, but check for duplicate complete JSON
            if (toolCallDelta.function?.arguments) {
              const newArgs = toolCallDelta.function.arguments;
              const existingArgs = toolCalls[index].function.arguments;
              
              // Check if we're about to append duplicate complete JSON
              // This can happen if the API sends the same complete JSON string multiple times
              if (existingArgs && newArgs) {
                // Try to parse existing args as JSON to see if it's already complete
                try {
                  JSON.parse(existingArgs);
                  // If existing args is valid JSON, check if new args is the same JSON
                  if (existingArgs === newArgs) {
                    continue; // Skip duplicate complete JSON
                  }
                  // If new args is also valid JSON and different, we might be getting a duplicate
                  try {
                    const newParsed = JSON.parse(newArgs);
                    const existingParsed = JSON.parse(existingArgs);
                    if (JSON.stringify(newParsed) === JSON.stringify(existingParsed)) {
                      continue; // Skip duplicate JSON object
                    }
                  } catch (e) {
                    // newArgs is not valid JSON alone, so it's a continuation - proceed with append
                  }
                } catch (e) {
                  // existingArgs is not yet valid JSON, so append to continue building it
                }
              }
              
              toolCalls[index].function.arguments += newArgs;
            }
          }
        }
      }
      }
      
       const toolCallsArray = Object.values(toolCalls).filter(tc => tc.id); // Only complete tool calls
      
      // End reasoning
      if (hasStartedReasoning && reasoningStartTime !== null) {
        const reasoningElapsed = Date.now() - reasoningStartTime;
        await this.callHook('onReasoningDone', fullReasoning, reasoningElapsed);
      }
      
      // End response
      if (hasStartedResponse && responseStartTime !== null) {
        const responseElapsed = Date.now() - responseStartTime;
        await this.callHook('onResponseDone', fullContent, responseElapsed);
      }
      
      // Build structured assistant message
       const assistantMessage = {
        role: 'assistant',
         content: fullContent || '',
        reasoning: fullReasoning || null,
         tool_calls: toolCallsArray.length > 0 ? toolCallsArray : null
      };
      
      // Add message to chat
      this.chat.addMessage(assistantMessage);
      
      // Generate title if not already set
      if (assistantMessage.content) {
        await this._generateTitle();
      }
      
      lastResult = assistantMessage;
      
      // Automatically execute tool calls if present
      if (toolCallsArray.length > 0) {
        // Convert tool_call format to tool_calls format for execution
        await this._executeToolCallsInternal({
          tool_calls: toolCallsArray
        });
        // Continue loop for next iteration
        iteration++;
      } else {
        // No tool calls, we're done
        return lastResult;
      }
    }
    
    // Max iterations reached
    return lastResult;
  }
  
  // /v1/responses API - streaming
  async _completeStreamResponses(params, requestOptions = undefined) {
    const max_iterations = params.max_iterations || 100;
    const tool_choice = params.tool_choice || 'auto';
    const tools = params.tools;
    delete params.max_iterations; // Remove from API params
    
    let iteration = 0;
    let lastResult = null;
    
    while (iteration < max_iterations) {
      // Build base request parameters
      const requestParams = { ...params };
      
      // /v1/responses expects function tools to have top-level `name` (not `function.name`).
      if (tools) {
        requestParams.tools = this._normalizeToolsForResponses(tools);
        requestParams.tool_choice = iteration === 0 ? tool_choice : 'auto';
      }
      
      // Transform reasoning_effort to reasoning.effort for responses API
      if (requestParams.reasoning_effort) {
        requestParams.reasoning = { effort: requestParams.reasoning_effort };
        delete requestParams.reasoning_effort;
      }
      
      // Get messages to send (either all or only new ones after last response_id)
      let messagesInfo = this._getMessagesForResponsesAPI();
      let stream;
      let responseIdToStore = null;
      
      const requestStartTime = Date.now();
      await this.callHook('onRequestStart');
      
      try {
        // Prepare responses API parameters
        const responsesParams = { ...requestParams };
        
        // For streaming, we need to ensure input is always provided if no response_id
        // The API might require input even when using response_id for continuation
        if (messagesInfo.response_id) {
          responsesParams.previous_response_id = messagesInfo.response_id;
          // When using response_id, only send input if there are new messages
          if (messagesInfo.input && messagesInfo.input.length > 0) {
            responsesParams.input = messagesInfo.input;
          }
        } else {
          // No response_id - must send input
          if (messagesInfo.input && messagesInfo.input.length > 0) {
            responsesParams.input = messagesInfo.input;
          } else {
            // This shouldn't happen - get all messages as fallback
            responsesParams.input = this.chat.getMessagesForAPI();
          }
        }
        
        const responsesStream = await this.client.responses.create({ ...responsesParams, stream: true }, requestOptions);

        // Transform ResponseStreamEvent -> chat.completions-like delta stream
        stream = (async function* () {
          const outputIndexToToolCallIndex = new Map();
          const toolCallIndexToId = new Map();
          const toolCallIndexToName = new Map();
          let nextToolCallIndex = 0;

          for await (const event of responsesStream) {
            if (!event || typeof event !== 'object') continue;

            if (event.type === 'response.created' && event.response?.id && !responseIdToStore) {
              responseIdToStore = event.response.id;
            }
            if (event.type === 'response.completed' && event.response?.id && !responseIdToStore) {
              responseIdToStore = event.response.id;
            }

            if (event.type === 'response.output_text.delta') {
              yield { choices: [{ delta: { content: event.delta } }] };
              continue;
            }

            if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
              const outputIndex = event.output_index;
              const idx = nextToolCallIndex++;
              outputIndexToToolCallIndex.set(outputIndex, idx);
              toolCallIndexToId.set(idx, event.item.call_id || event.item.id || '');
              toolCallIndexToName.set(idx, event.item.name || '');

              yield {
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: idx,
                      id: toolCallIndexToId.get(idx),
                      type: 'function',
                      function: { name: toolCallIndexToName.get(idx), arguments: '' },
                    }],
                  },
                }],
              };
              continue;
            }

            if (event.type === 'response.function_call_arguments.delta') {
              const idx = outputIndexToToolCallIndex.get(event.output_index);
              if (idx === undefined) continue;
              yield {
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: idx,
                      id: toolCallIndexToId.get(idx) || '',
                      type: 'function',
                      function: { name: toolCallIndexToName.get(idx) || '', arguments: event.delta },
                    }],
                  },
                }],
              };
              continue;
            }
          }
        })();
      } catch (error) {
        // Check for tools format errors
        const errorMsg = error.message || '';
        if (error.status === 400 && errorMsg.includes('tools') && errorMsg.includes('name')) {
          // Tools format error - log details and re-throw
          console.error('Tools format error:', {
            tools: tools ? tools.map(t => ({
              type: t?.type,
              name: t?.name,
              functionName: t?.function?.name
            })) : null,
            error: errorMsg
          });
          throw new Error(
            `Tools format error: ${errorMsg}. For /v1/responses use {type:'function', name, description?, parameters, strict?} (or pass chat-style tools and we'll normalize).`,
          );
        }
        
        // If previous_response_id is invalid (404) or unknown parameter (400), retry with all messages
        const isResponseIdError = error.status === 404 || error.code === 'not_found' || 
            (error.response && error.response.status === 404) ||
            (errorMsg.includes('404') || errorMsg.includes('not found') || errorMsg.includes('not_found')) ||
            (error.status === 400 && errorMsg.includes('Unknown parameter') && (errorMsg.includes('previous_response_id') || errorMsg.includes('response_id')));
        
        if (isResponseIdError || (error.status === 400 && (errorMsg.includes('previous_response_id') || errorMsg.includes('response_id')))) {
          // Clear the stored response_id from the last assistant message
          const lastResponseInfo = this._getLastResponseId();
          if (lastResponseInfo) {
            // Remove response_id from the assistant message that has it
            const msgWithResponseId = this.chat.messages[lastResponseInfo.index];
            if (msgWithResponseId && msgWithResponseId.response_id) {
              delete msgWithResponseId.response_id;
              // Save the updated message
              if (this.chat.persistent) {
                this.chat.save();
              }
            }
          }
          
          // Get all messages for retry
          const allMessages = this._getMessagesForResponsesAPI().input;
          const retryParams = { ...requestParams };
          retryParams.input = allMessages;
          // Transform reasoning_effort to reasoning.effort for responses API
          if (retryParams.reasoning_effort) {
            retryParams.reasoning = { effort: retryParams.reasoning_effort };
            delete retryParams.reasoning_effort;
          }
          // Don't include response_id in retry
          
          const responsesStream = await this.client.responses.create({ ...retryParams, stream: true }, requestOptions);

          stream = (async function* () {
            const outputIndexToToolCallIndex = new Map();
            const toolCallIndexToId = new Map();
            const toolCallIndexToName = new Map();
            let nextToolCallIndex = 0;

            for await (const event of responsesStream) {
              if (!event || typeof event !== 'object') continue;

              if (event.type === 'response.created' && event.response?.id && !responseIdToStore) {
                responseIdToStore = event.response.id;
              }
              if (event.type === 'response.completed' && event.response?.id && !responseIdToStore) {
                responseIdToStore = event.response.id;
              }

              if (event.type === 'response.output_text.delta') {
                yield { choices: [{ delta: { content: event.delta } }] };
                continue;
              }

              if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
                const outputIndex = event.output_index;
                const idx = nextToolCallIndex++;
                outputIndexToToolCallIndex.set(outputIndex, idx);
                toolCallIndexToId.set(idx, event.item.call_id || event.item.id || '');
                toolCallIndexToName.set(idx, event.item.name || '');

                yield {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        index: idx,
                        id: toolCallIndexToId.get(idx),
                        type: 'function',
                        function: { name: toolCallIndexToName.get(idx), arguments: '' },
                      }],
                    },
                  }],
                };
                continue;
              }

              if (event.type === 'response.function_call_arguments.delta') {
                const idx = outputIndexToToolCallIndex.get(event.output_index);
                if (idx === undefined) continue;
                yield {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        index: idx,
                        id: toolCallIndexToId.get(idx) || '',
                        type: 'function',
                        function: { name: toolCallIndexToName.get(idx) || '', arguments: event.delta },
                      }],
                    },
                  }],
                };
                continue;
              }
            }
          })();
        } else {
          // Re-throw other errors
          throw error;
        }
      }
      
      const requestDoneTime = Date.now();
      const requestElapsed = requestDoneTime - requestStartTime;
      await this.callHook('onRequestDone', requestElapsed);
      
      let fullContent = '';
      let fullReasoning = '';
      const toolCalls = {};
      let hasStartedReasoning = false;
      let hasStartedResponse = false;
      let reasoningStartTime = null;
      let responseStartTime = null;
      let firstEventAfterRequestDone = true;
      
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        
        const delta = choice.delta;
        
        // Handle reasoning (for o1 models)
        if (delta.reasoning) {
          if (!hasStartedReasoning) {
            reasoningStartTime = Date.now();
            const sinceRequestDone = firstEventAfterRequestDone ? Date.now() - requestDoneTime : null;
            await this.callHook('onReasoningStart', sinceRequestDone);
            firstEventAfterRequestDone = false;
            hasStartedReasoning = true;
          }
          fullReasoning += delta.reasoning;
          await this.callHook('onReasoningData', delta.reasoning);
        }
        
        // Handle content
        if (delta.content) {
          if (!hasStartedResponse) {
            responseStartTime = Date.now();
            const sinceRequestDone = firstEventAfterRequestDone ? Date.now() - requestDoneTime : null;
            await this.callHook('onResponseStart', sinceRequestDone);
            firstEventAfterRequestDone = false;
            hasStartedResponse = true;
          }
          fullContent += delta.content;
          await this.callHook('onResponseData', delta.content);
        }
        
      // Handle tool calls (accumulate only; hooks are fired around tool execution)
      if (delta.tool_calls) {
        for (const toolCallDelta of delta.tool_calls) {
          const index = toolCallDelta.index;
          
          if (!toolCalls[index]) {
            toolCalls[index] = {
              id: toolCallDelta.id || '',
              type: 'function',
              function: {
                name: toolCallDelta.function?.name || '',
                arguments: toolCallDelta.function?.arguments || ''
              }
            };
          } else {
            // Update ID if provided
            if (toolCallDelta.id) {
              toolCalls[index].id = toolCallDelta.id;
            }
            
            // Update name if provided
            if (toolCallDelta.function?.name) {
              toolCalls[index].function.name = toolCallDelta.function.name;
            }
            
            // Append to tool call arguments, but check for duplicate complete JSON
            if (toolCallDelta.function?.arguments) {
              const newArgs = toolCallDelta.function.arguments;
              const existingArgs = toolCalls[index].function.arguments;
              
              // Check if we're about to append duplicate complete JSON
              // This can happen if the API sends the same complete JSON string multiple times
              if (existingArgs && newArgs) {
                // Try to parse existing args as JSON to see if it's already complete
                try {
                  JSON.parse(existingArgs);
                  // If existing args is valid JSON, check if new args is the same JSON
                  if (existingArgs === newArgs) {
                    continue; // Skip duplicate complete JSON
                  }
                  // If new args is also valid JSON and different, we might be getting a duplicate
                  try {
                    const newParsed = JSON.parse(newArgs);
                    const existingParsed = JSON.parse(existingArgs);
                    if (JSON.stringify(newParsed) === JSON.stringify(existingParsed)) {
                      continue; // Skip duplicate JSON object
                    }
                  } catch (e) {
                    // newArgs is not valid JSON alone, so it's a continuation - proceed with append
                  }
                } catch (e) {
                  // existingArgs is not yet valid JSON, so append to continue building it
                }
              }
              
              toolCalls[index].function.arguments += newArgs;
            }
          }
        }
      }
      }
      
       const toolCallsArray = Object.values(toolCalls).filter(tc => tc.id); // Only complete tool calls
      
      // End reasoning
      if (hasStartedReasoning && reasoningStartTime !== null) {
        const reasoningElapsed = Date.now() - reasoningStartTime;
        await this.callHook('onReasoningDone', fullReasoning, reasoningElapsed);
      }
      
      // End response
      if (hasStartedResponse && responseStartTime !== null) {
        const responseElapsed = Date.now() - responseStartTime;
        await this.callHook('onResponseDone', fullContent, responseElapsed);
      }
      
      // Build structured assistant message
       const assistantMessage = {
        role: 'assistant',
         content: fullContent || '',
        reasoning: fullReasoning || null,
         tool_calls: toolCallsArray.length > 0 ? toolCallsArray : null
      };
      
      // Store response_id in assistant message (from streaming)
      if (responseIdToStore) {
        assistantMessage.response_id = responseIdToStore;
      }
      
      // Add message to chat (this will save the response_id with the message)
      this.chat.addMessage(assistantMessage);
      
      // Generate title if not already set
      if (assistantMessage.content) {
        await this._generateTitle();
      }
      
      lastResult = assistantMessage;
      
      // Automatically execute tool calls if present
      if (toolCallsArray.length > 0) {
        // Convert tool_call format to tool_calls format for execution
        await this._executeToolCallsInternal({
          tool_calls: toolCallsArray
        });
        // Continue loop for next iteration
        iteration++;
      } else {
        // No tool calls, we're done
        return lastResult;
      }
    }
    
    // Max iterations reached
    return lastResult;
  }
  
  async addUserMessage(content) {
    this.chat.addMessage({ role: 'user', content: content });
  }
  
  async addToolMessage(toolCallId, name = null, content = null) {
    const message = {
      role: 'tool',
      tool_call_id: toolCallId,
      content: (content === null || content === undefined) ? '' : String(content)
    };
    if (name) {
      message.name = name;
    }
    this.chat.addMessage(message);
  }

  async _executeToolCallsInternal(result, options = {}) {
    if (!result.tool_calls || result.tool_calls.length === 0) {
      return [];
    }
    
    let executeTool = options.executeTool || options.executeTools;
    if (!executeTool) {
      try {
        executeTool = require('./viib-etch-tools').executeTool;
      } catch (e) {
        throw new Error("No tool executor provided. Pass { executeTool } to executeToolCalls(), or create ./viib-etch-tools.js exporting executeTool().");
      }
    }
    const toolResults = [];
    
    for (const toolCall of result.tool_calls) {
      const toolCallStartTime = Date.now();
      try {
        const args = JSON.parse(toolCall.function.arguments);
        await this.callHook('onToolCallStart', toolCall, args, null);
        const context = {
          session: this.chat,
          onCommandOut: async (data) => {
            await this.callHook('onToolCallData', toolCall, data);
          }
        };
        
        const toolResult = await executeTool(toolCall.function.name, args, context);
        await this.callHook('onToolCallData', toolCall, { phase: 'result', result: toolResult });
        const content = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
        
        await this.addToolMessage(
          toolCall.id,
          toolCall.function.name,
          content
        );
        
        toolResults.push({
          toolCallId: toolCall.id,
          name: toolCall.function.name,
          result: toolResult
        });
        const toolCallElapsed = Date.now() - toolCallStartTime;
        await this.callHook('onToolCallEnd', toolCall, { result: toolResult }, toolCallElapsed);
      } catch (error) {
        await this.callHook('onToolCallData', toolCall, { phase: 'error', error: error.message });
        const errorContent = JSON.stringify({ error: error.message, success: false });
        await this.addToolMessage(
          toolCall.id,
          toolCall.function.name,
          errorContent
        );
        
        toolResults.push({
          toolCallId: toolCall.id,
          name: toolCall.function.name,
          error: error.message
        });
        const toolCallElapsed = Date.now() - toolCallStartTime;
        await this.callHook('onToolCallEnd', toolCall, { error: error.message }, toolCallElapsed);
      }
    }
    
    return toolResults;
  }

  async executeToolCalls(result, options = {}) {
    // Public method for backwards compatibility - delegates to internal method
    return this._executeToolCallsInternal(result, options);
  }

  async send(message, options = {}) {
    this.chat.addMessage({ role: 'user', content: message });
    return this.complete(options);
  }
}

// Convenience: hooks that log to console/stdout
// Usage: ChatLLM.newChatSession(modelName, false, tools, consoleLogHooks({ response: true, reasoning: false, tools: true }))
function consoleLogHooks(opts = {}) {
  const {
    brief = false,
    response = true,
    reasoning = true,
    tools = true,
    prefix = ''
  } = opts || {};
  const p = prefix ? String(prefix) : '';

  const extractPatchFiles = (patchCommand) => {
    if (typeof patchCommand !== 'string' || !patchCommand) return [];
    const files = [];
    for (const line of patchCommand.split(/\r?\n/)) {
      if (line.startsWith('*** Add File: ')) files.push(line.slice('*** Add File: '.length).trim());
      else if (line.startsWith('*** Update File: ')) files.push(line.slice('*** Update File: '.length).trim());
    }
    return [...new Set(files)].filter(Boolean);
  };

  return {
    onRequestStart: async () => {
      console.log(`${p}[request:start]`);
    },
    onRequestDone: async (elapsed) => {
      console.log(`${p}[request:done] ${elapsed}ms`);
    },
    onReasoningStart: reasoning ? async (sinceRequestDone) => {
      const timing = (sinceRequestDone !== null && sinceRequestDone !== undefined) ? ` +${sinceRequestDone}ms` : '';
      console.log(`${p}[reasoning:start]${timing}`);
    } : null,
    onReasoningData: reasoning ? async (chunk) => process.stdout.write(String(chunk)) : null,
    onReasoningDone: reasoning ? async (fullReasoning, elapsed) => {
      console.log(`\n${p}[reasoning:done] ${elapsed}ms`);
    } : null,

    onResponseStart: response ? async (sinceRequestDone) => {
      const timing = (sinceRequestDone !== null && sinceRequestDone !== undefined) ? ` +${sinceRequestDone}ms` : '';
      console.log(`${p}[response:start]${timing}`);
    } : null,
    onResponseData: response ? async (chunk) => process.stdout.write(String(chunk)) : null,
    onResponseDone: response ? async (content, elapsed) => {
      console.log(`\n${p}[response:done] ${elapsed}ms`);
    } : null,

    onToolCallStart: tools ? async (toolCall, args, sinceRequestDone) => {
      const name = toolCall?.function?.name || '(unknown)';
      const timing = (sinceRequestDone !== null && sinceRequestDone !== undefined) ? ` +${sinceRequestDone}ms` : '';

      if (brief) {
        if (name === 'apply_patch') {
          const files = extractPatchFiles(args?.patchCommand);
          console.log(`${p}[tool:start] apply_patch${files.length ? ' ' + files.join(', ') : ''}${timing}`);
          return;
        }
        if (name === 'run_terminal_cmd') {
          const explanation = args?.explanation;
          console.log(`${p}[tool:start] run_terminal_cmd${explanation ? ' ' + String(explanation) : ''}${timing}`);
          return;
        }
      }

      console.log(`${p}[tool:start] ${name} ${args ? JSON.stringify(args) : ''}${timing}`);
    } : null,
    onToolCallData: tools ? (brief ? null : async (toolCall, data) => {
      if (data?.phase === 'stream') {
        // Stream stdout/stderr directly to stdout/stderr
        if (data.stream === 'stdout') {
          process.stdout.write(String(data.data));
        } else if (data.stream === 'stderr') {
          process.stderr.write(String(data.data));
        }
      } else if (data?.phase === 'result') {
        console.log(`${p}[tool:result] ${toolCall?.function?.name || '(unknown)'} ${typeof data.result === 'string' ? data.result : JSON.stringify(data.result)}`);
      } else if (data?.phase === 'error') {
        console.log(`${p}[tool:error] ${toolCall?.function?.name || '(unknown)'} ${data.error}`);
      }
    }) : null,
    onToolCallEnd: tools ? async (toolCall, data, elapsed) => {
      const timing = elapsed !== null && elapsed !== undefined ? ` ${elapsed}ms` : '';
      if (data?.error) {
        console.log(`${p}[tool:end] ${toolCall?.function?.name || '(unknown)'} (error)${timing}`);
      } else {
        console.log(`${p}[tool:end] ${toolCall?.function?.name || '(unknown)'}${timing}`);
      }
    } : null,
    onTitle: async (title) => {
      console.log(`${p}[title] ${title}`);
    },
  };
}

// createChat(model_name, persistent=false, tools=null, hooks={})
// hooks can be: "console" | "brief" | hooks object
function createChat(modelName, persistent = false, tools = null, hooks = {}) {
  let resolvedHooks = hooks;
  if (typeof hooks === 'string') {
    if (hooks === 'console') {
      resolvedHooks = consoleLogHooks();
    } else if (hooks === 'brief') {
      resolvedHooks = consoleLogHooks({ brief: true });
    }
    // Otherwise, treat as hooks object (though string won't work, but keep for consistency)
  }
  return ChatLLM.newChatSession(modelName, persistent, tools, resolvedHooks);
}

// openChat(chatId, tools=null, hooks={})
// Load an existing chat session and return a ChatLLM instance
// hooks can be: "console" | "brief" | hooks object
function openChat(chatId, tools = null, hooks = {}) {
  const chat = ChatSession.load(chatId);
  if (!chat) {
    throw new Error(`Chat session not found: ${chatId}`);
  }
  
  const modelName = chat.model_name;
  if (!modelName) {
    throw new Error(`Chat session ${chatId} has no model_name`);
  }
  
  // Resolve hooks
  let resolvedHooks = hooks;
  if (typeof hooks === 'string') {
    if (hooks === 'console') {
      resolvedHooks = consoleLogHooks();
    } else if (hooks === 'brief') {
      resolvedHooks = consoleLogHooks({ brief: true });
    }
  }
  
  // If caller didn't provide tools, default to model's configured tool-name list (if any)
  if (tools === null || tools === undefined) {
    try {
      const models = ChatModel.loadModels();
      const resolved = models.find(m => m.name === modelName);
      if (resolved && Array.isArray(resolved.tools) && resolved.tools.length > 0) {
        const { getToolDefinitions } = require(path.join(__dirname, 'viib-etch-tools'));
        const toolsPath = path.join(getBaseDir(), 'viib-etch-tools.json');
        tools = getToolDefinitions(toolsPath, resolved.tools);
      }
    } catch (e) {
      // Best-effort only; fall back to no tools.
    }
  }
  
  return new ChatLLM(modelName, chat, tools, resolvedHooks);
}

// Export classes and convenience functions
module.exports = {
  ChatModel,
  ChatSession,
  ChatLLM,
  setBaseDir,
  getBaseDir,
  setChatsDir,
  getChatsDir,
  consoleLogHooks,
  
  // Convenience functions
  loadModels: (file) => ChatModel.loadModels(file),
  loadChat: (chatId) => ChatSession.load(chatId),
  listChatSessions: () => ChatSession.listChatSessions(),
  createChat,
  openChat,
};

