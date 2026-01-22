// viib-etch.js
// LLM interface with OpenAI library, tool calling, streaming, and hooks

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { OpenAI } = require('openai');
const { GoogleGenAI } = require('@google/genai');

let modelsFileName = path.join(__dirname, 'viib-etch-models.json')
let chatsDir = path.join(__dirname, 'chats')

function ensureDirExists(dirPath) {
  if (!dirPath) return;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (e) {
    // If it already exists or can't be created, let later fs ops surface the error.
  }
}

function setModelsFileName(fileName) {
  if (typeof fileName !== 'string' || fileName.trim() === '') {
    throw new Error('modelsFileName must be a non-empty string');
  }
  modelsFileName = fileName;
}

function getModelsFileName() {
  return modelsFileName;
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

function resolveConfigFile(filePath) {
  if (!filePath) return null;
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  // Try relative paths in order: current directory, getModelsFileName directory, __dirname
  const searchDirs = [
    process.cwd(),
    path.dirname(getModelsFileName()),
    __dirname
  ];
  for (const dir of searchDirs) {
    const candidatePath = path.join(dir, filePath);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  // If not found, return path relative to current directory (will error on read if doesn't exist)
  return path.join(process.cwd(), filePath);
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
    // For Gemini models, check GEMINI_API_KEY env var; otherwise use OPENAI_API_KEY
    if (this.api_key_file) {
      try {
        const keyPath = resolveConfigFile(this.api_key_file);
        this.api_key = fs.readFileSync(keyPath, 'utf8').trim();
      } catch (err) {
        throw new Error(`Failed to load API key from ${this.api_key_file}: ${err.message}`);
      }
    } else {
      const isGemini = this._isGeminiModel();
      this.api_key = config.api_key || (isGemini ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY);
    }
    
    if (!this.api_key) {
      throw new Error(`API key not provided for model ${this.name}`);
    }
  }

  _isGeminiModel() {
    const modelName = (this.model || '').toLowerCase();
    return modelName.includes('gemini') || modelName.includes('veo') || modelName.startsWith('google/');
  }

  readSystemPromptFileFresh() {
    if (!this.system_prompt_file) return null;
    try {
      const promptPath = resolveConfigFile(this.system_prompt_file);
      return fs.readFileSync(promptPath, 'utf8');
    } catch (err) {
      throw new Error(`Failed to load system prompt from ${this.system_prompt_file}: ${err.message}`);
    }
  }
  
  static loadModels(modelsFile = getModelsFileName()) {
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
    // In-memory image store: id -> image record
    // Record shape (minimal):
    //   { id, kind: 'reference'|'generated', mime_type, data_b64, created_at, ... }
    this.images = (data.images && typeof data.images === 'object') ? data.images : {};
    // In-memory audio store: id -> audio record
    // Record shape (minimal):
    //   { id, kind: 'voiceover'|'generated', mime_type, data_b64, created_at, ... }
    this.audio = (data.audio && typeof data.audio === 'object') ? data.audio : {};
    this.data = data.data || {};
    // Persistent base directory for tool execution (optional).
    // If set, tool execution will chdir() into this directory for the duration of the tool call.
    this.base_dir = (data.base_dir === null || data.base_dir === undefined) ? null : String(data.base_dir);
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
      images: this.images,
      audio: this.audio,
      data: this.data,
      base_dir: this.base_dir
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  setBaseDir(dir) {
    const v = (dir === null || dir === undefined) ? null : String(dir).trim();
    this.base_dir = v ? v : null;
    this.save();
    return this;
  }

  getBaseDir() {
    return this.base_dir;
  }

  addMessage(message) {
    this.messages.push(message);
    this.save();
    return message;
  }

  _ensureImagesMap() {
    if (!this.images || typeof this.images !== 'object') this.images = {};
    return this.images;
  }

  addImage(imageRecord) {
    if (!imageRecord || typeof imageRecord !== 'object') {
      throw new Error('addImage: imageRecord must be an object');
    }
    const images = this._ensureImagesMap();
    const id = imageRecord.id ? String(imageRecord.id) : crypto.randomUUID();
    const rec = { ...imageRecord, id };
    images[id] = rec;
    this.save();
    return id;
  }

  /**
   * cleanupImages()
   *
   * Removes images that are not referenced by any persisted message content.
   * This is intentionally NOT called automatically by addImage()/save() because
   * some workflows (like "attach then later generate") temporarily store images
   * before they are referenced by a message.
   *
   * Returns { removedIds, keptIds }.
   */
  cleanupImages() {
    const images = this._ensureImagesMap();
    const used = new Set();

    const addId = (v) => {
      const s = (v === null || v === undefined) ? '' : String(v);
      if (s) used.add(s);
    };
    const addIds = (arr) => {
      const a = Array.isArray(arr) ? arr : [];
      for (const v of a) addId(v);
    };

    for (const msg of Array.isArray(this.messages) ? this.messages : []) {
      if (!msg || typeof msg !== 'object') continue;

      // Back-compat: some formats may store these at the top level.
      addIds(msg.images);
      addIds(msg.reference_images);
      addIds(msg.reference_image_ids);

      const c = msg.content;
      if (!c || typeof c !== 'object') continue;

      // Current UI format: { type:'image'|'image_prompt', reference_images:[...], images:[...] }
      addIds(c.images);
      addIds(c.reference_images);
      addIds(c.reference_image_ids);
    }

    const removedIds = [];
    const keptIds = [];
    for (const id of Object.keys(images)) {
      if (used.has(String(id))) keptIds.push(String(id));
      else {
        removedIds.push(String(id));
        try { delete images[id]; } catch {}
      }
    }

    // Persist cleanup result in-memory; caller decides when to save().
    this.images = images;
    return { removedIds, keptIds };
  }

  getImage(id) {
    const images = this._ensureImagesMap();
    const key = (id === null || id === undefined) ? '' : String(id);
    return images[key] || null;
  }

  listImages(filter = {}) {
    const images = this._ensureImagesMap();
    const kind = filter && filter.kind ? String(filter.kind) : null;
    const out = Object.values(images);
    const filtered = kind ? out.filter((r) => r && r.kind === kind) : out;
    filtered.sort((a, b) => {
      const ta = a && a.created_at ? Date.parse(a.created_at) : 0;
      const tb = b && b.created_at ? Date.parse(b.created_at) : 0;
      if (ta !== tb) return ta - tb;
      return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
    });
    return filtered;
  }

  getImageData(id) {
    const rec = this.getImage(id);
    if (!rec) throw new Error(`image not found: ${String(id)}`);
    const b64 = rec.data_b64 ?? rec.data_base64 ?? rec.b64_json ?? rec.data ?? null;
    if (!b64 || typeof b64 !== 'string') {
      throw new Error(`image has no data_b64: ${String(id)}`);
    }
    return Buffer.from(b64, 'base64');
  }

  _ensureAudioMap() {
    if (!this.audio || typeof this.audio !== 'object') this.audio = {};
    return this.audio;
  }

  addAudio(audioRecord) {
    if (!audioRecord || typeof audioRecord !== 'object') {
      throw new Error('addAudio: audioRecord must be an object');
    }
    const audio = this._ensureAudioMap();
    const id = audioRecord.id ? String(audioRecord.id) : crypto.randomUUID();
    const rec = { ...audioRecord, id };
    audio[id] = rec;
    this.save();
    return id;
  }

  getAudio(id) {
    const audio = this._ensureAudioMap();
    const key = (id === null || id === undefined) ? '' : String(id);
    return audio[key] || null;
  }

  getAudioData(id) {
    const rec = this.getAudio(id);
    if (!rec) throw new Error(`audio not found: ${String(id)}`);
    const b64 = rec.data_b64 ?? rec.data_base64 ?? rec.b64_json ?? rec.data ?? null;
    if (!b64 || typeof b64 !== 'string') {
      throw new Error(`audio has no data_b64: ${String(id)}`);
    }
    return Buffer.from(b64, 'base64');
  }

  _stringifyStructuredMessageForAPI(msg) {
    if (!msg || typeof msg !== 'object') return '';
    const c = msg.content;
    if (!c || typeof c !== 'object') return '';
    const t = c.type ? String(c.type) : '';
    if (t === 'image_prompt') {
      const prompt = c.prompt ? String(c.prompt) : '';
      const refs = Array.isArray(c.reference_images) ? c.reference_images.map(String) : [];
      return [
        '[image_prompt]',
        prompt ? `prompt: ${prompt}` : null,
        refs.length ? `reference_images: ${refs.join(', ')}` : null,
      ].filter(Boolean).join('\n');
    }
    if (t === 'image') {
      const prompt = c.prompt ? String(c.prompt) : '';
      const provider = c.provider ? String(c.provider) : '';
      const imgs = Array.isArray(c.images) ? c.images.map(String) : [];
      return [
        '[image_result]',
        provider ? `provider: ${provider}` : null,
        prompt ? `prompt: ${prompt}` : null,
        imgs.length ? `images: ${imgs.join(', ')}` : null,
      ].filter(Boolean).join('\n');
    }
    try { return JSON.stringify(c); } catch { return ''; }
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
      
      if ((msg.role === 'assistant' || msg.role === 'user') && typeof msg.content === 'object' && msg.content !== null) {
        // Structured blocks (e.g., image prompt/result). Serialize to text for API context.
        apiMsg.content = this._stringifyStructuredMessageForAPI(msg);
        
        // Include tool calls if present (ensure it's an array)
        if (msg.role === 'assistant' && msg.content.tool_call) {
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
    // In-memory (non-persistent) default; if set, it will be used unless overridden per-call.
    // NOTE: This is NOT saved into ChatSession JSON.
    this.reasoning_effort = undefined;
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
    this._abortController = null;
    this._activeProcesses = new Map();
  }

  setBaseDir(dir) {
    // Back-compat: store on ChatSession (persistent)
    if (this.chat && typeof this.chat.setBaseDir === 'function') {
      this.chat.setBaseDir(dir);
    } else if (this.chat) {
      const v = (dir === null || dir === undefined) ? null : String(dir).trim();
      this.chat.base_dir = v ? v : null;
      try { this.chat.save(); } catch {}
    }
    return this;
  }

  getBaseDir() {
    if (this.chat && typeof this.chat.getBaseDir === 'function') return this.chat.getBaseDir();
    return this.chat ? this.chat.base_dir : null;
  }

  // Set a default reasoning effort for this ChatLLM instance (non-persistent).
  // Pass null/undefined/'default'/'' to clear (i.e., use model/provider default).
  setReasoningEffort(effort) {
    const v = (typeof effort === 'string') ? effort.trim() : effort;
    if (v === null || v === undefined || v === '' || String(v).toLowerCase() === 'default') {
      this.reasoning_effort = undefined;
    } else {
      this.reasoning_effort = v;
    }
    return this;
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
          const toolsPath = path.join(__dirname, 'viib-etch-tools.json')
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

  _isGeminiModel() {
    const model = this._ensureModelResolved();
    return model._isGeminiModel();
  }

  getClient() {
    const model = this._ensureModelResolved();
    if (!this._client) {
      if (model._isGeminiModel()) {
        this._client = new GoogleGenAI({
          apiKey: model.api_key
        });
      } else {
        this._client = new OpenAI({
          apiKey: model.api_key,
          baseURL: model.base_url
        });
      }
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
  
  cancel() {
    if (this._abortController) {
      this._abortController.abort();
    }
    // Kill all active processes
    for (const [key, child] of this._activeProcesses) {
      try {
        if (child && !child.killed) {
          child.kill('SIGTERM');
        }
      } catch (err) {
        // Ignore errors when killing processes
      }
      this._activeProcesses.delete(key);
    }
  }
  
  _isCancelled() {
    return this._abortController && this._abortController.signal.aborted;
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
      const isGemini = this._isGeminiModel();
      
      if (isGemini) {
        // Use Gemini API for title generation
        const client = this.getClient();
        const modelName = model.model.replace(/^google\//, '');
        
        const titleContents = [
          { role: 'user', parts: [{ text: userMessages[0].content || '' }] }
        ];
        
        if (assistantMessages[0] && assistantMessages[0].content) {
          titleContents.push({
            role: 'model',
            parts: [{ text: String(assistantMessages[0].content).substring(0, 500) }]
          });
        }
        
        const titleRequest = {
          model: modelName,
          contents: titleContents,
          config: {
            systemInstruction: 'Generate a concise, descriptive title (maximum 10 words) for this conversation based on the user\'s request and your response. Return only the title, nothing else.',
            maxOutputTokens: 50
          }
        };
        
        const response = await client.models.generateContent(titleRequest);
        const title = this._extractTextFromGeminiResponse(response)?.trim();
        
        if (title) {
          const cleanTitle = title.replace(/^["']|["']$/g, '').trim();
          if (cleanTitle && cleanTitle.length > 0) {
            this.chat.title = cleanTitle.substring(0, 200);
            this.chat.save();
            await this.callHook('onTitle', this.chat.title);
          }
        }
      } else {
        // Use OpenAI API for title generation
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
      }
    } catch (err) {
      // Silently fail - title generation is best-effort
    }
  }

  async complete(options = {}) {
    const hasReasoningEffort = Object.prototype.hasOwnProperty.call(options, 'reasoning_effort');
    const {
      tools = this.tools,
      stream = false,
      temperature = null,
      max_tokens = null,
      reasoning_effort = undefined,
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
 
     // reasoning_effort:
     // - If explicitly provided via options, include it (even "off") to override the model/provider default.
     // - Otherwise, omit it entirely so the model/provider default reasoning behavior applies.
     const resolveEff = (effRaw) => {
       const eff = (typeof effRaw === 'string') ? effRaw.trim() : effRaw;
       if (eff === null || eff === undefined || eff === '' || String(eff).toLowerCase() === 'default') {
         return undefined; // omit
       }
       return eff; // include (including "off")
     };
     if (hasReasoningEffort) {
       const eff = resolveEff(reasoning_effort);
       if (eff !== undefined) params.reasoning_effort = eff;
     } else {
       const eff = resolveEff(this.reasoning_effort);
       if (eff !== undefined) params.reasoning_effort = eff;
     }
    
    // Route to appropriate API method
    const useResponsesAPI = this._shouldUseResponsesAPI();
    // Request options (OpenAI SDK): support timeout via AbortController.
    // IMPORTANT: request options must NOT be included in the API body.
    let requestOptions = undefined;
    let timeoutId = null;
    let timeoutController = null;
    
    // Create abort controller for cancellation
    this._abortController = new AbortController();
    
    // Combine timeout and cancellation signals
    if (timeout_ms !== null && timeout_ms !== undefined) {
      const ms = Number(timeout_ms);
      if (!Number.isFinite(ms) || ms <= 0) {
        throw new Error('timeout_ms must be a positive number (milliseconds)');
      }
      timeoutController = new AbortController();
      timeoutId = setTimeout(() => timeoutController.abort(), ms);
      
      // Combine signals: create a signal that aborts when either does
      const combinedController = new AbortController();
      const abortOnSignal = (signal) => {
        if (signal.aborted) {
          combinedController.abort();
        } else {
          signal.addEventListener('abort', () => combinedController.abort(), { once: true });
        }
      };
      abortOnSignal(this._abortController.signal);
      abortOnSignal(timeoutController.signal);
      requestOptions = { signal: combinedController.signal };
    } else {
      requestOptions = { signal: this._abortController.signal };
    }

    try {
      // Route Gemini models to Gemini-specific methods
      if (this._isGeminiModel()) {
        const p = stream
          ? this._completeStreamGemini(params, requestOptions)
          : this._completeNoStreamGemini(params, requestOptions);
        return await p;
      }
      
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
      this._abortController = null;
      // Clear processes map but don't kill them (they may still be running)
      this._activeProcesses.clear();
    }
  }
  
  // Convert OpenAI message format to Google Gemini format
  _convertMessagesToGeminiFormat(messages) {
    const contents = [];
    
    for (const msg of messages) {
      if (msg.role === 'system') {
        // System messages are handled separately in Gemini
        continue;
      }
      
      if (msg.role === 'user') {
        const parts = [];
        if (msg.content) {
          parts.push({ text: String(msg.content) });
        }
        if (parts.length > 0) {
          contents.push({ role: 'user', parts });
        }
      } else if (msg.role === 'assistant') {
        const parts = [];
        if (msg.content) {
          parts.push({ text: String(msg.content) });
        }
        
        // Handle tool calls in assistant messages
        const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : null;
        if (toolCalls) {
          const functionCallParts = [];
          for (const toolCall of toolCalls) {
            try {
              const args = JSON.parse(toolCall.function?.arguments || '{}');
              const name = toolCall.function?.name || '';
              const thoughtSignature =
                toolCall.thoughtSignature ??
                toolCall.thought_signature ??
                toolCall._thoughtSignature ??
                null;

              const fcPart = {
                functionCall: { name, args },
              };
              // Gemini requires thoughtSignature on the first functionCall part in a tool-calling turn.
              // If we don't have it, it's safer to omit functionCall parts entirely than to 400.
              if (thoughtSignature) {
                fcPart.thoughtSignature = thoughtSignature;
              }
              functionCallParts.push(fcPart);
            } catch (e) {
              // Skip invalid tool calls
            }
          }

          // Only include functionCall parts if the first functionCall has a thoughtSignature somewhere
          // (Gemini validates tool-calling turns strictly).
          const hasAnyThoughtSignature = functionCallParts.some(p => p.thoughtSignature);
          if (hasAnyThoughtSignature) {
            // Preserve ordering: if Gemini produced parallel calls, thoughtSignature is only on one part.
            parts.push(...functionCallParts);
          } else {
            // Fallback: keep a textual hint so the model has some context, but avoid invalid tool parts.
            const names = functionCallParts
              .map(p => p?.functionCall?.name)
              .filter(Boolean);
            if (names.length > 0) {
              parts.push({ text: `[tools requested: ${names.join(', ')}]` });
            }
          }
        }
        
        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
      } else if (msg.role === 'tool') {
        // Tool outputs must be sent back as a separate `role: 'user'` message with functionResponse.
        const name = msg.name || '';
        let response;
        try {
          response = (typeof msg.content === 'string') ? JSON.parse(msg.content) : msg.content;
        } catch (e) {
          response = String(msg.content || '');
        }
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name, response } }],
        });
      }
    }
    return contents;
  }
  
  // Convert OpenAI tool format to Google Gemini format
  _convertToolsToGeminiFormat(tools) {
    if (!tools || !Array.isArray(tools)) return null;
    
    const outTools = [];
    const functionDeclarations = [];
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') continue;

      // Built-in Gemini tools (non-function tools)
      // We represent them internally as { type: 'googleSearch' } / { type: 'codeExecution' }.
      // Gemini expects tool objects like { googleSearch: {} } / { codeExecution: {} }.
      if (tool.type === 'googleSearch' || tool.type === 'google_search') {
        outTools.push({ googleSearch: {} });
        continue;
      }
      if (tool.type === 'codeExecution' || tool.type === 'code_execution') {
        outTools.push({ codeExecution: {} });
        continue;
      }

      // Function tools
      if (tool.type === 'function' && tool.function) {
        functionDeclarations.push({
          name: tool.function.name,
          description: tool.function.description || '',
          parameters: tool.function.parameters || {}
        });
      } else if (tool.type === 'function' && tool.name) {
        // Already in Gemini format
        functionDeclarations.push({
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || {}
        });
      }
    }
    
    // NOTE: Gemini (via @google/genai) currently rejects mixing built-in tools
    // (e.g. googleSearch/codeExecution) with functionDeclarations in the same request.
    // If built-ins are present, prefer them and omit functionDeclarations.
    if (functionDeclarations.length > 0 && outTools.length === 0) {
      outTools.push({ functionDeclarations });
    }

    return outTools.length > 0 ? outTools : null;
  }
  
  // Extract tool calls from Gemini response
  _extractToolCallsFromGeminiResponse(response) {
    if (!response.candidates || !response.candidates[0]) return null;
    const candidate = response.candidates[0];
    if (!candidate.content || !candidate.content.parts) return null;
    
    const toolCalls = [];
    for (const part of candidate.content.parts) {
      if (part.functionCall) {
        const thoughtSignature =
          part.thoughtSignature ??
          part.thought_signature ??
          part.functionCall?.thoughtSignature ??
          part.functionCall?.thought_signature ??
          null;
        toolCalls.push({
          id: `call_${crypto.randomBytes(8).toString('hex')}`,
          type: 'function',
          thoughtSignature,
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {})
          }
        });
      }
    }
    return toolCalls.length > 0 ? toolCalls : null;
  }
  
  // Extract text content from Gemini response
  _extractTextFromGeminiResponse(response) {
    if (!response.candidates || !response.candidates[0]) return null;
    const candidate = response.candidates[0];
    if (!candidate.content || !candidate.content.parts) return null;
    
    let text = '';
    for (const part of candidate.content.parts) {
      // When includeThoughts is enabled, Gemini may emit thought text parts with { thought: true }.
      // Keep "final" text here and extract thought text separately.
      if (part.text && !part.thought) {
        text += part.text;
      }
    }
    return text || null;
  }

  // Extract "thoughts" / reasoning text from Gemini response (when includeThoughts is enabled)
  _extractReasoningFromGeminiResponse(response) {
    if (!response.candidates || !response.candidates[0]) return null;
    const candidate = response.candidates[0];
    if (!candidate.content || !candidate.content.parts) return null;

    let text = '';
    for (const part of candidate.content.parts) {
      if (part.text && part.thought) {
        text += part.text;
      }
    }
    return text || null;
  }
  
  // Google Gemini API - non-streaming
  async _completeNoStreamGemini(params, requestOptions = undefined) {
    const max_iterations = params.max_iterations || 100;
    const tools = params.tools;
    delete params.max_iterations; // Remove from API params
    
    let iteration = 0;
    let lastResult = null;
    let accumulatedUsage = null;
    
    const model = this._ensureModelResolved();
    const client = this.getClient();
    const modelName = model.model.replace(/^google\//, ''); // Remove 'google/' prefix if present
    
    while (iteration < max_iterations) {
      // Check for cancellation
      if (this._isCancelled()) {
        throw new Error('Operation cancelled');
      }
      
      // Get messages in OpenAI format, then convert to Gemini format
      const openAIMessages = this.chat.getMessagesForAPI();
      const geminiContents = this._convertMessagesToGeminiFormat(openAIMessages);
      
      // Get system instruction if present
      let systemInstruction = null;
      if (openAIMessages.length > 0 && openAIMessages[0].role === 'system') {
        systemInstruction = openAIMessages[0].content;
      }
      
      // Build Gemini request
      const geminiRequest = {
        model: modelName,
        contents: geminiContents
      };
      
      // Build config object for optional parameters
      const config = {};
      if (systemInstruction) {
        config.systemInstruction = systemInstruction;
      }
      if (tools) {
        const geminiTools = this._convertToolsToGeminiFormat(tools);
        if (geminiTools) {
          config.tools = geminiTools;
        }
      }
      if (params.temperature !== null && params.temperature !== undefined) {
        config.temperature = params.temperature;
      }
      if (params.max_tokens !== null && params.max_tokens !== undefined) {
        config.maxOutputTokens = params.max_tokens;
      }
      // If reasoning is enabled, request thought summaries so we can populate assistantMessage.reasoning.
      // Caller can override by passing include_thoughts explicitly.
      if (params.include_thoughts !== null && params.include_thoughts !== undefined) {
        config.thinkingConfig = {
          ...(config.thinkingConfig || {}),
          includeThoughts: !!params.include_thoughts,
        };
      } else if (params.reasoning_effort !== null && params.reasoning_effort !== undefined && String(params.reasoning_effort).toLowerCase() !== 'off') {
        config.thinkingConfig = {
          ...(config.thinkingConfig || {}),
          includeThoughts: true,
        };
      }
      // Best-effort: map viib-etch `reasoning_effort` to Gemini "thinking" controls.
      // Prefer `thinkingLevel` for Gemini 3.x, and use `thinkingBudget` as fallback for numeric budgets / non-3.x models.
      // We do NOT request thought summaries (includeThoughts=false).
      if (params.reasoning_effort !== null && params.reasoning_effort !== undefined && config.thinkingConfig === undefined) {
        const effRaw = params.reasoning_effort;
        const effStr = String(effRaw).toLowerCase();

        // If user passes a numeric budget, honor it.
        const asNum = Number(effRaw);
        const hasNumericBudget = Number.isFinite(asNum) && String(effRaw).trim() !== '';

        if (modelName.startsWith('gemini-3') && !hasNumericBudget) {
          // Gemini 3 Pro supports LOW/HIGH; Flash supports MINIMAL/LOW/MEDIUM/HIGH.
          const isFlash = modelName.includes('flash');
          let thinkingLevel = null;
          if (effStr === 'low') thinkingLevel = 'LOW';
          else if (effStr === 'high') thinkingLevel = 'HIGH';
          else if (effStr === 'medium') thinkingLevel = isFlash ? 'MEDIUM' : 'HIGH';
          else if (effStr === 'minimal') thinkingLevel = isFlash ? 'MINIMAL' : 'LOW';
          else if (effStr === 'on' || effStr === 'auto') thinkingLevel = 'HIGH';

          if (thinkingLevel) {
            config.thinkingConfig = { thinkingLevel, includeThoughts: false };
          }
        } else {
          // Fallback: thinkingBudget controls thinking depth for models that support budgets.
          let thinkingBudget = null;
          if (hasNumericBudget) thinkingBudget = asNum;
          else if (effStr === 'on' || effStr === 'auto') thinkingBudget = -1;
          else if (effStr === 'low') thinkingBudget = 64;
          else if (effStr === 'medium') thinkingBudget = 256;
          else if (effStr === 'high') thinkingBudget = 1024;
          if (thinkingBudget !== null) {
            config.thinkingConfig = { thinkingBudget, includeThoughts: false };
          }
        }
      }
      if (Object.keys(config).length > 0) {
        geminiRequest.config = config;
      }
      
      const requestStartTime = Date.now();
      await this.callHook('onRequestStart');
      
      let response;
      try {
        response = await client.models.generateContent(geminiRequest);
      } catch (error) {
        // Handle errors
        throw error;
      }
      
      const requestDoneTime = Date.now();
      const requestElapsed = requestDoneTime - requestStartTime;
      await this.callHook('onRequestDone', requestElapsed);
      
      // Extract content/reasoning and tool calls
      const reasoning = this._extractReasoningFromGeminiResponse(response);
      const content = this._extractTextFromGeminiResponse(response);
      const toolCalls = this._extractToolCallsFromGeminiResponse(response);
      
      // Build structured assistant message
      const assistantMessage = {
        role: 'assistant',
        content: content || '',
        reasoning: reasoning || null,
        tool_calls: toolCalls
      };
      
      let firstEventAfterRequestDone = true;
      
      // Handle reasoning (Gemini thoughts) similar to OpenAI reasoning channel
      if (reasoning) {
        const reasoningStartTime = Date.now();
        const sinceRequestDone = firstEventAfterRequestDone ? Date.now() - requestDoneTime : null;
        await this.callHook('onReasoningStart', sinceRequestDone);
        firstEventAfterRequestDone = false;
        await this.callHook('onReasoningData', reasoning);
        const reasoningElapsed = Date.now() - reasoningStartTime;
        await this.callHook('onReasoningDone', reasoning, reasoningElapsed);
      }

      // Handle response content
      if (content) {
        const responseStartTime = Date.now();
        const sinceRequestDone = firstEventAfterRequestDone ? Date.now() - requestDoneTime : null;
        await this.callHook('onResponseStart', sinceRequestDone);
        firstEventAfterRequestDone = false;
        await this.callHook('onResponseData', content);
        const responseElapsed = Date.now() - responseStartTime;
        await this.callHook('onResponseDone', content, responseElapsed);
      }
      
      // Add message to chat
      this.chat.addMessage(assistantMessage);
      
      // Generate title if not already set
      if (assistantMessage.content) {
        await this._generateTitle();
      }
      
      lastResult = {
        message: assistantMessage,
        content: content,
        tool_calls: toolCalls,
        reasoning: null,
        usage: response.usage || null,
        finish_reason: null
      };
      
      // Check for cancellation before tool execution
      if (this._isCancelled()) {
        throw new Error('Operation cancelled');
      }
      
      // Automatically execute tool calls if present
      if (toolCalls && toolCalls.length > 0) {
        await this._executeToolCallsInternal({
          tool_calls: toolCalls
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
  
  // Google Gemini API - streaming
  async _completeStreamGemini(params, requestOptions = undefined) {
    const max_iterations = params.max_iterations || 100;
    const tools = params.tools;
    delete params.max_iterations; // Remove from API params
    
    let iteration = 0;
    let lastResult = null;
    
    const model = this._ensureModelResolved();
    const client = this.getClient();
    const modelName = model.model.replace(/^google\//, ''); // Remove 'google/' prefix if present
    
    while (iteration < max_iterations) {
      // Check for cancellation
      if (this._isCancelled()) {
        throw new Error('Operation cancelled');
      }
      
      // Get messages in OpenAI format, then convert to Gemini format
      const openAIMessages = this.chat.getMessagesForAPI();
      const geminiContents = this._convertMessagesToGeminiFormat(openAIMessages);
      
      // Get system instruction if present
      let systemInstruction = null;
      if (openAIMessages.length > 0 && openAIMessages[0].role === 'system') {
        systemInstruction = openAIMessages[0].content;
      }
      
      // Build Gemini request
      const geminiRequest = {
        model: modelName,
        contents: geminiContents
      };
      
      // Build config object for optional parameters
      const config = {};
      if (systemInstruction) {
        config.systemInstruction = systemInstruction;
      }
      if (tools) {
        const geminiTools = this._convertToolsToGeminiFormat(tools);
        if (geminiTools) {
          config.tools = geminiTools;
        }
      }
      if (params.temperature !== null && params.temperature !== undefined) {
        config.temperature = params.temperature;
      }
      if (params.max_tokens !== null && params.max_tokens !== undefined) {
        config.maxOutputTokens = params.max_tokens;
      }
      // If reasoning is enabled, request thought summaries so we can populate assistantMessage.reasoning.
      // Caller can override by passing include_thoughts explicitly.
      if (params.include_thoughts !== null && params.include_thoughts !== undefined) {
        config.thinkingConfig = {
          ...(config.thinkingConfig || {}),
          includeThoughts: !!params.include_thoughts,
        };
      } else if (params.reasoning_effort !== null && params.reasoning_effort !== undefined && String(params.reasoning_effort).toLowerCase() !== 'off') {
        config.thinkingConfig = {
          ...(config.thinkingConfig || {}),
          includeThoughts: true,
        };
      }
      // Best-effort: map viib-etch `reasoning_effort` to Gemini "thinking" controls.
      // Prefer `thinkingLevel` for Gemini 3.x, and use `thinkingBudget` as fallback for numeric budgets / non-3.x models.
      // We do NOT request thought summaries (includeThoughts=false).
      if (params.reasoning_effort !== null && params.reasoning_effort !== undefined && config.thinkingConfig === undefined) {
        const effRaw = params.reasoning_effort;
        const effStr = String(effRaw).toLowerCase();

        // If user passes a numeric budget, honor it.
        const asNum = Number(effRaw);
        const hasNumericBudget = Number.isFinite(asNum) && String(effRaw).trim() !== '';

        if (modelName.startsWith('gemini-3') && !hasNumericBudget) {
          // Gemini 3 Pro supports LOW/HIGH; Flash supports MINIMAL/LOW/MEDIUM/HIGH.
          const isFlash = modelName.includes('flash');
          let thinkingLevel = null;
          if (effStr === 'low') thinkingLevel = 'LOW';
          else if (effStr === 'high') thinkingLevel = 'HIGH';
          else if (effStr === 'medium') thinkingLevel = isFlash ? 'MEDIUM' : 'HIGH';
          else if (effStr === 'minimal') thinkingLevel = isFlash ? 'MINIMAL' : 'LOW';
          else if (effStr === 'on' || effStr === 'auto') thinkingLevel = 'HIGH';

          if (thinkingLevel) {
            config.thinkingConfig = { thinkingLevel, includeThoughts: false };
          }
        } else {
          // Fallback: thinkingBudget controls thinking depth for models that support budgets.
          let thinkingBudget = null;
          if (hasNumericBudget) thinkingBudget = asNum;
          else if (effStr === 'on' || effStr === 'auto') thinkingBudget = -1;
          else if (effStr === 'low') thinkingBudget = 64;
          else if (effStr === 'medium') thinkingBudget = 256;
          else if (effStr === 'high') thinkingBudget = 1024;
          if (thinkingBudget !== null) {
            config.thinkingConfig = { thinkingBudget, includeThoughts: false };
          }
        }
      }
      if (Object.keys(config).length > 0) {
        geminiRequest.config = config;
      }
      
      const requestStartTime = Date.now();
      await this.callHook('onRequestStart');
      
      let stream;
      try {
        stream = await client.models.generateContentStream(geminiRequest);
      } catch (error) {
        throw error;
      }
      
      const requestDoneTime = Date.now();
      const requestElapsed = requestDoneTime - requestStartTime;
      await this.callHook('onRequestDone', requestElapsed);
      
      let fullContent = '';
      const toolCalls = {};
      let fullReasoning = '';
      let hasStartedReasoning = false;
      let reasoningStartTime = null;
      let hasStartedResponse = false;
      let responseStartTime = null;
      let firstEventAfterRequestDone = true;
      
      // Process streaming response
      for await (const chunk of stream) {
        // Check for cancellation during streaming
        if (this._isCancelled()) {
          throw new Error('Operation cancelled');
        }
        
        if (!chunk.candidates || !chunk.candidates[0]) continue;
        const candidate = chunk.candidates[0];
        if (!candidate.content || !candidate.content.parts) continue;
        
        for (const part of candidate.content.parts) {
          // Handle text content (final) vs reasoning (thought) content
          if (part.text) {
            if (part.thought) {
              if (!hasStartedReasoning) {
                reasoningStartTime = Date.now();
                const sinceRequestDone = firstEventAfterRequestDone ? Date.now() - requestDoneTime : null;
                await this.callHook('onReasoningStart', sinceRequestDone);
                firstEventAfterRequestDone = false;
                hasStartedReasoning = true;
              }
              fullReasoning += part.text;
              await this.callHook('onReasoningData', part.text);
            } else {
              if (!hasStartedResponse) {
                responseStartTime = Date.now();
                const sinceRequestDone = firstEventAfterRequestDone ? Date.now() - requestDoneTime : null;
                await this.callHook('onResponseStart', sinceRequestDone);
                firstEventAfterRequestDone = false;
                hasStartedResponse = true;
              }
              fullContent += part.text;
              await this.callHook('onResponseData', part.text);
            }
          }
          
          // Handle function calls (tool calls)
          if (part.functionCall) {
            const callId = `call_${crypto.randomBytes(8).toString('hex')}`;
            const index = Object.keys(toolCalls).length;
            const thoughtSignature =
              part.thoughtSignature ??
              part.thought_signature ??
              part.functionCall?.thoughtSignature ??
              part.functionCall?.thought_signature ??
              null;
            toolCalls[index] = {
              id: callId,
              type: 'function',
              thoughtSignature,
              function: {
                name: part.functionCall.name || '',
                arguments: JSON.stringify(part.functionCall.args || {})
              }
            };
          }
        }
      }
      
      // End response
      if (hasStartedResponse && responseStartTime !== null) {
        const responseElapsed = Date.now() - responseStartTime;
        await this.callHook('onResponseDone', fullContent, responseElapsed);
      }

      // End reasoning
      if (hasStartedReasoning && reasoningStartTime !== null) {
        const reasoningElapsed = Date.now() - reasoningStartTime;
        await this.callHook('onReasoningDone', fullReasoning, reasoningElapsed);
      }
      
      // Build structured assistant message
      const toolCallsArray = Object.values(toolCalls).filter(tc => tc.id);
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
      
      // Check for cancellation before tool execution
      if (this._isCancelled()) {
        throw new Error('Operation cancelled');
      }
      
      // Automatically execute tool calls if present
      if (toolCallsArray.length > 0) {
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
      // Check for cancellation
      if (this._isCancelled()) {
        throw new Error('Operation cancelled');
      }
      
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
      
      // Check for cancellation before tool execution
      if (this._isCancelled()) {
        throw new Error('Operation cancelled');
      }
      
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
      // Check for cancellation
      if (this._isCancelled()) {
        throw new Error('Operation cancelled');
      }
      
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
      
      // Check for cancellation before tool execution
      if (this._isCancelled()) {
        throw new Error('Operation cancelled');
      }
      
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
      // Check for cancellation
      if (this._isCancelled()) {
        throw new Error('Operation cancelled');
      }
      
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
        // Check for cancellation during streaming
        if (this._isCancelled()) {
          throw new Error('Operation cancelled');
        }
        
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
      
      // Check for cancellation before tool execution
      if (this._isCancelled()) {
        throw new Error('Operation cancelled');
      }
      
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
      // Check for cancellation
      if (this._isCancelled()) {
        throw new Error('Operation cancelled');
      }
      
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
        // Check for cancellation during streaming
        if (this._isCancelled()) {
          throw new Error('Operation cancelled');
        }
        
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
      
      // Check for cancellation before tool execution
      if (this._isCancelled()) {
        throw new Error('Operation cancelled');
      }
      
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
      // Check for cancellation before each tool call
      if (this._isCancelled()) {
        throw new Error('Operation cancelled');
      }

      // Save current directory and change to base_dir if set
      const originalCwd = process.cwd();
      let changedDir = false;
      
      const toolCallStartTime = Date.now();
      try {
        // Change to base_dir if set (stored on ChatSession)
        const baseDir = (this.chat && (typeof this.chat.getBaseDir === 'function' ? this.chat.getBaseDir() : this.chat.base_dir)) || null;
        if (baseDir) {
          process.chdir(baseDir);
          changedDir = true;
        }
        
        const args = JSON.parse(toolCall.function.arguments);
        await this.callHook('onToolCallStart', toolCall, args, null);
        const context = {
          session: this.chat,
          onCommandOut: async (data) => {
            await this.callHook('onToolCallData', toolCall, data);
          },
          _activeProcesses: this._activeProcesses,
          _isCancelled: () => this._isCancelled()
        };
        
        const toolResult = await executeTool(toolCall.function.name, args, context);
        await this.callHook('onToolCallData', toolCall, { phase: 'result', result: toolResult });
        
        // Store diff in ChatSession.data if present, then remove from result
        let cleanedResult = toolResult;
        if (toolResult && typeof toolResult === 'object' && (toolResult._diff || toolResult._patchCommand)) {
          if (!this.chat.data.diffs) {
            this.chat.data.diffs = {};
          }
          this.chat.data.diffs[toolCall.id] = {
            diff: toolResult._diff || null,
            patchCommand: toolResult._patchCommand || null,
            toolName: toolCall.function.name
          };
          this.chat.save();
          
          // Remove _diff and _patchCommand from result before storing in message
          cleanedResult = { ...toolResult };
          delete cleanedResult._diff;
          delete cleanedResult._patchCommand;
        }
        
        const content = typeof cleanedResult === 'string' ? cleanedResult : JSON.stringify(cleanedResult);
        
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
      } finally {
        // Restore original directory if we changed it
        if (changedDir) {
          process.chdir(originalCwd);
        }
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

  /**
   * generateImage(prompt, referenceImages=null, options={})
   *
   * - Stores all images in ChatSession.images[id] (base64), never writes to disk.
   * - Assistant message block stores image ids.
   * - For Gemini, stores raw model parts and replays them for continuation by default.
   */
  async generateImage(prompt, referenceImages = null, options = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('generateImage: prompt must be a non-empty string');
    }

    const model = this._ensureModelResolved();
    const client = this.getClient();
    const isGemini = model._isGeminiModel();

    const nowIso = () => new Date().toISOString();

    const guessMime = (p) => {
      const ext = String(p || '').toLowerCase();
      if (ext.endsWith('.png')) return 'image/png';
      if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) return 'image/jpeg';
      if (ext.endsWith('.webp')) return 'image/webp';
      if (ext.endsWith('.gif')) return 'image/gif';
      return 'application/octet-stream';
    };

    // Normalize referenceImages
    const refsRaw =
      referenceImages === null || referenceImages === undefined
        ? []
        : (Array.isArray(referenceImages) ? referenceImages : [referenceImages]);

    // Save reference images into ChatSession.images (in-memory)
    const referenceImageIds = [];
    for (const r of refsRaw) {
      // Allow passing an existing ChatSession image id directly.
      if (typeof r === 'string' && this.chat.getImage(r)) {
        referenceImageIds.push(String(r));
        continue;
      }

      if (typeof r === 'string') {
        // Treat as file path; read and store.
        const abs = path.resolve(r);
        const buf = fs.readFileSync(abs);
        const rec = {
          kind: 'reference',
          mime_type: guessMime(abs),
          data_b64: buf.toString('base64'),
          created_at: nowIso(),
          source_file_path: abs,
        };
        referenceImageIds.push(this.chat.addImage(rec));
        continue;
      }

      if (!r || typeof r !== 'object') {
        throw new Error('generateImage: each referenceImages entry must be an id string, a file path string, or an object');
      }

      const b64 = r.data_b64 ?? r.data_base64 ?? r.b64_json ?? r.data ?? null;
      const hasB64 = typeof b64 === 'string' && b64.length > 0;
      if (!hasB64) {
        throw new Error('generateImage: reference image object must include data_b64');
      }

      const rec = {
        id: r.id || crypto.randomUUID(),
        kind: 'reference',
        mime_type: r.mime_type || 'application/octet-stream',
        data_b64: b64,
        created_at: nowIso(),
      };
      referenceImageIds.push(this.chat.addImage(rec));
    }

    // Persist user intent
    this.chat.addMessage({
      role: 'user',
      content: {
        type: 'image_prompt',
        prompt,
        reference_images: referenceImageIds,
        options: (options && typeof options === 'object') ? options : {},
      },
    });

    // Helper: build inlineData parts for reference ids
    const refInlineParts = () => {
      const parts = [];
      for (const id of referenceImageIds) {
        const rec = this.chat.getImage(id);
        if (!rec) continue;
        const b64 = rec.data_b64 ?? rec.data_base64 ?? rec.b64_json ?? rec.data ?? null;
        if (!b64) continue;
        parts.push({
          inlineData: {
            data: String(b64),
            mimeType: rec.mime_type || 'image/png',
          },
        });
      }
      return parts;
    };

    const normalizeRawModelParts = (parts) => {
      // Keep JSON-serializable subset and preserve thoughtSignature.
      const out = [];
      const arr = Array.isArray(parts) ? parts : [];
      for (const part of arr) {
        if (!part || typeof part !== 'object') continue;
        const ts =
          part.thoughtSignature ??
          part.thought_signature ??
          part.functionCall?.thoughtSignature ??
          part.functionCall?.thought_signature ??
          null;
        if (typeof part.text === 'string') {
          const p = { text: part.text };
          if (part.thought === true) p.thought = true;
          if (ts) p.thoughtSignature = ts;
          out.push(p);
          continue;
        }
        const img = part.inlineData || part.inline_data || null;
        if (img && img.data) {
          const mt = img.mimeType || img.mime_type || 'image/png';
          const p = { inlineData: { data: String(img.data), mimeType: String(mt) } };
          if (ts) p.thoughtSignature = ts;
          out.push(p);
          continue;
        }
        if (part.functionCall) {
          const p = { functionCall: part.functionCall };
          if (ts) p.thoughtSignature = ts;
          out.push(p);
          continue;
        }
      }
      return out;
    };

    const findLastImageTurn = () => {
      for (let i = (this.chat.messages || []).length - 1; i >= 0; i--) {
        const m = this.chat.messages[i];
        if (!m || m.role !== 'assistant') continue;
        const c = m.content;
        if (!c || typeof c !== 'object') continue;
        if (c.type !== 'image') continue;
        if (c.raw_model_message && typeof c.raw_model_message === 'object' && Array.isArray(c.raw_model_message.parts)) {
          return c;
        }
      }
      return null;
    };

    const buildGeminiImageHistoryFromChat = () => {
      // Reconstruct a gemini-native history from stored ChatSession messages.
      // Only includes structured image_prompt and image turns.
      const out = [];
      const msgs = Array.isArray(this.chat.messages) ? this.chat.messages : [];
      for (const m of msgs) {
        if (!m || typeof m !== 'object') continue;
        if (m.role === 'user' && m.content && typeof m.content === 'object' && m.content.type === 'image_prompt') {
          const p = m.content.prompt ? String(m.content.prompt) : '';
          const refIds = Array.isArray(m.content.reference_images) ? m.content.reference_images : [];
          const parts = [];
          for (const id of refIds) {
            const rec = this.chat.getImage(id);
            if (!rec) continue;
            const b64 = rec.data_b64 ?? rec.data_base64 ?? rec.b64_json ?? rec.data ?? null;
            if (!b64) continue;
            parts.push({
              inlineData: { data: String(b64), mimeType: rec.mime_type || 'image/png' },
            });
          }
          parts.push({ text: p });
          out.push({ role: 'user', parts });
          continue;
        }
        if (m.role === 'assistant' && m.content && typeof m.content === 'object' && m.content.type === 'image') {
          const rm = m.content.raw_model_message;
          if (rm && typeof rm === 'object' && Array.isArray(rm.parts) && rm.parts.length > 0) {
            out.push({ role: 'model', parts: rm.parts });
          }
          continue;
        }
      }
      return out;
    };

    let outImages = []; // [{data_b64, mime_type}]
    let rawModelMessage = null;

    if (isGemini) {
      const modelName = model.model.replace(/^google\//, '');

      // Continuation by default: send the full prior gemini-native history "as-is",
      // then append the new user turn. Persist the updated history back onto chat.data.
      let history = (this.chat && this.chat.data && Array.isArray(this.chat.data.gemini_image_history))
        ? this.chat.data.gemini_image_history
        : null;
      if (!history || history.length === 0) {
        history = buildGeminiImageHistoryFromChat();
      }

      const userTurn = { role: 'user', parts: [...refInlineParts(), { text: String(prompt) }] };
      const contents = [...history, userTurn];

      const request = {
        model: modelName,
        contents,
        generationConfig: {},
      };
      if (options && typeof options === 'object' && typeof options.size === 'string') {
        request.generationConfig.size = options.size;
      }

      const response = await client.models.generateContent(request);
      const parts = response?.candidates?.[0]?.content?.parts || [];
      const normalizedParts = normalizeRawModelParts(parts);
      rawModelMessage = { role: 'model', parts: normalizedParts };

      // Persist gemini-native history for exact replay next time.
      const nextHistory = [...history, userTurn, rawModelMessage];
      this.chat.data = this.chat.data && typeof this.chat.data === 'object' ? this.chat.data : {};
      this.chat.data.gemini_image_history = nextHistory;
      this.chat.save();

      // Extract images
      for (const p of parts) {
        const img = p && (p.inlineData || p.inline_data);
        if (!img || !img.data) continue;
        const mime = img.mimeType || img.mime_type || 'image/png';
        outImages.push({ data_b64: String(img.data), mime_type: String(mime) });
      }
    } else {
      // OpenAI image generation (one-shot; continuation not guaranteed)
      const tools = [{ type: 'image_generation' }];
      const input = [{ role: 'user', content: prompt }];
      const resp = await client.responses.create({ model: model.model, input, tools });
      const outputs = resp.output || [];
      for (const item of outputs) {
        if (!item || typeof item !== 'object') continue;
        if (item.type !== 'image') continue;
        const imgList = Array.isArray(item.images) ? item.images : [];
        for (const img of imgList) {
          if (img && img.b64_json) outImages.push({ data_b64: String(img.b64_json), mime_type: 'image/png' });
        }
      }
      rawModelMessage = null;
    }

    if (!outImages.length) {
      throw new Error('generateImage: no image data returned from provider');
    }

    const savedIds = [];
    for (const img of outImages) {
      const rec = {
        kind: 'generated',
        mime_type: img.mime_type,
        data_b64: img.data_b64,
        created_at: nowIso(),
        provider: isGemini ? 'gemini' : 'openai',
        prompt,
        reference_images: referenceImageIds,
        raw_model_message: rawModelMessage,
      };
      savedIds.push(this.chat.addImage(rec));
    }

    const assistantMessage = {
      role: 'assistant',
      content: {
        type: 'image',
        provider: isGemini ? 'gemini' : 'openai',
        prompt,
        reference_images: referenceImageIds,
        images: savedIds,
        raw_model_message: rawModelMessage,
      },
    };
    this.chat.addMessage(assistantMessage);

    return {
      provider: isGemini ? 'gemini' : 'openai',
      prompt,
      reference_images: referenceImageIds,
      images: savedIds,
      message: assistantMessage,
    };
  }

  /**
   * generateVideoSegment(prompt, options={})
   *
   * - Stores videos in ChatSession.images[id] (base64), never writes to disk.
   * - Stores audio in ChatSession.audio[id] (base64) for voiceover.
   * - Assistant message block stores video id and audio id.
   * - Supports multiple modes: new segment, extend, update, frame-directed.
   * - Supports native audio generation or provided voiceover.
   * - Uses Veo API via Google GenAI library.
   */
  async generateVideoSegment(prompt, options = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('generateVideoSegment: prompt must be a non-empty string');
    }

    const model = this._ensureModelResolved();
    const client = this.getClient();
    const modelName = model.model.replace(/^google\//, '');
    const isVeoModel = modelName.toLowerCase().includes('veo');
    
    // Veo models are Gemini-based, but check for Veo explicitly
    if (!isVeoModel) {
      const isGemini = model._isGeminiModel();
      if (!isGemini) {
        throw new Error('generateVideoSegment: only Gemini/Veo models are supported');
      }
      throw new Error(`generateVideoSegment: model ${modelName} is not a Veo model`);
    }

    const nowIso = () => new Date().toISOString();

    const guessMime = (p) => {
      const ext = String(p || '').toLowerCase();
      if (ext.endsWith('.mp4')) return 'video/mp4';
      if (ext.endsWith('.webm')) return 'video/webm';
      if (ext.endsWith('.mov')) return 'video/quicktime';
      if (ext.endsWith('.mp3')) return 'audio/mpeg';
      if (ext.endsWith('.wav')) return 'audio/wav';
      if (ext.endsWith('.m4a')) return 'audio/mp4';
      return 'application/octet-stream';
    };

    // Normalize options
    const opts = (options && typeof options === 'object') ? options : {};
    // Veo API requires durationSeconds between 4 and 8 (inclusive)
    const durationSeconds = Math.max(4, Math.min(8, Math.floor(opts.durationSeconds || 8)));
    const aspectRatio = (opts.aspectRatio === '9:16') ? '9:16' : '16:9';
    const generateAudio = opts.generateAudio !== false; // default true
    const negativePrompt = (typeof opts.negativePrompt === 'string') ? opts.negativePrompt : undefined;
    const seed = (typeof opts.seed === 'number') ? opts.seed : undefined;
    const enhancePrompt = opts.enhancePrompt === true;
    const lipsyncPrompt = (typeof opts.lipsyncPrompt === 'string') ? opts.lipsyncPrompt : undefined;

    // Normalize referenceImages (same pattern as generateImage)
    const refsRaw =
      (opts.referenceImages === null || opts.referenceImages === undefined)
        ? []
        : (Array.isArray(opts.referenceImages) ? opts.referenceImages : [opts.referenceImages]);

    const referenceImageIds = [];
    for (const r of refsRaw) {
      if (typeof r === 'string' && this.chat.getImage(r)) {
        referenceImageIds.push(String(r));
        continue;
      }

      if (typeof r === 'string') {
        const abs = path.resolve(r);
        const buf = fs.readFileSync(abs);
        const rec = {
          kind: 'reference',
          mime_type: guessMime(abs),
          data_b64: buf.toString('base64'),
          created_at: nowIso(),
          source_file_path: abs,
        };
        referenceImageIds.push(this.chat.addImage(rec));
        continue;
      }

      if (!r || typeof r !== 'object') {
        throw new Error('generateVideoSegment: each referenceImages entry must be an id string, a file path string, or an object');
      }

      const b64 = r.data_b64 ?? r.data_base64 ?? r.b64_json ?? r.data ?? null;
      const hasB64 = typeof b64 === 'string' && b64.length > 0;
      if (!hasB64) {
        throw new Error('generateVideoSegment: reference image object must include data_b64');
      }

      const rec = {
        id: r.id || crypto.randomUUID(),
        kind: 'reference',
        mime_type: r.mime_type || 'image/png',
        data_b64: b64,
        created_at: nowIso(),
      };
      referenceImageIds.push(this.chat.addImage(rec));
    }

    // Determine generation mode
    const extendFrom = (typeof opts.extendFrom === 'string') ? String(opts.extendFrom) : null;
    const updateTarget = (typeof opts.updateTarget === 'string') ? String(opts.updateTarget) : null;
    const firstFrame = opts.firstFrame || null;
    const lastFrame = opts.lastFrame || null;

    let mode = 'new';
    if (updateTarget) {
      mode = 'update';
    } else if (extendFrom) {
      mode = 'extend';
    } else if (firstFrame || lastFrame) {
      mode = 'frame-directed';
    }

    // Handle voiceover audio if provided
    let voiceoverAssetId = null;
    if (opts.voiceoverAudio && !generateAudio) {
      let voiceoverData = null;
      let voiceoverMime = 'audio/mpeg';

      if (typeof opts.voiceoverAudio === 'string') {
        // Check if it's an existing audio ID
        if (this.chat.getAudio(opts.voiceoverAudio)) {
          voiceoverAssetId = String(opts.voiceoverAudio);
        } else {
          // Treat as file path
          const abs = path.resolve(opts.voiceoverAudio);
          const buf = fs.readFileSync(abs);
          voiceoverMime = guessMime(abs);
          voiceoverData = buf.toString('base64');
        }
      } else if (opts.voiceoverAudio && typeof opts.voiceoverAudio === 'object') {
        // Check if it's an ID reference
        if (opts.voiceoverAudio.id && this.chat.getAudio(opts.voiceoverAudio.id)) {
          voiceoverAssetId = String(opts.voiceoverAudio.id);
        } else {
          // Object with data_b64
          const b64 = opts.voiceoverAudio.data_b64 ?? opts.voiceoverAudio.data_base64 ?? opts.voiceoverAudio.data ?? null;
          if (!b64 || typeof b64 !== 'string') {
            throw new Error('generateVideoSegment: voiceoverAudio object must include data_b64 or id');
          }
          voiceoverData = String(b64);
          voiceoverMime = opts.voiceoverAudio.mime_type || 'audio/mpeg';
        }
      }

      // Store new voiceover if not already stored
      if (voiceoverData && !voiceoverAssetId) {
        const rec = {
          kind: 'voiceover',
          mime_type: voiceoverMime,
          data_b64: voiceoverData,
          created_at: nowIso(),
        };
        voiceoverAssetId = this.chat.addAudio(rec);
      }
    }

    // Build reference image parts for API
    const refInlineParts = () => {
      const parts = [];
      for (const id of referenceImageIds) {
        const rec = this.chat.getImage(id);
        if (!rec) continue;
        const b64 = rec.data_b64 ?? rec.data_base64 ?? rec.b64_json ?? rec.data ?? null;
        if (!b64) continue;
        parts.push({
          inlineData: {
            data: String(b64),
            mimeType: rec.mime_type || 'image/png',
          },
        });
      }
      return parts;
    };

    // Build frame data if provided
    const getFrameData = (frame) => {
      if (!frame) return null;
      if (typeof frame === 'string') {
        const rec = this.chat.getImage(frame);
        if (!rec) return null;
        const b64 = rec.data_b64 ?? rec.data_base64 ?? rec.b64_json ?? rec.data ?? null;
        if (!b64) return null;
        return {
          inlineData: {
            data: String(b64),
            mimeType: rec.mime_type || 'image/png',
          },
        };
      }
      if (frame && typeof frame === 'object') {
        const b64 = frame.data_b64 ?? frame.data_base64 ?? frame.b64_json ?? frame.data ?? null;
        if (!b64) return null;
        return {
          inlineData: {
            data: String(b64),
            mimeType: frame.mime_type || 'image/png',
          },
        };
      }
      return null;
    };

    // Persist user intent
    const userIntent = {
      role: 'user',
      content: {
        type: 'video_prompt',
        prompt,
        reference_images: referenceImageIds,
        mode,
        extend_from: extendFrom,
        update_target: updateTarget,
        options: {
          durationSeconds,
          aspectRatio,
          generateAudio,
          negativePrompt,
          seed,
          enhancePrompt,
          lipsyncPrompt,
          voiceover_audio: voiceoverAssetId,
        },
      },
    };
    this.chat.addMessage(userIntent);

    // Build Veo API request
    // Note: The exact API structure may vary - this is based on expected Veo API format
    const requestConfig = {
      prompt: String(prompt),
      durationSeconds,
      aspectRatio,
      generateAudio,
    };

    if (negativePrompt) requestConfig.negativePrompt = negativePrompt;
    if (seed !== undefined) requestConfig.seed = seed;
    if (enhancePrompt) requestConfig.enhancePrompt = true;
    if (lipsyncPrompt) requestConfig.lipsyncPrompt = lipsyncPrompt;

    // Add reference images
    const refParts = refInlineParts();
    if (refParts.length > 0) {
      requestConfig.referenceImages = refParts;
    }

    // Add frame continuity
    const firstFrameData = getFrameData(firstFrame);
    const lastFrameData = getFrameData(lastFrame);
    if (firstFrameData) requestConfig.firstFrame = firstFrameData;
    if (lastFrameData) requestConfig.lastFrame = lastFrameData;

    // Add extension/modification targets
    if (extendFrom) {
      const extendVideo = this.chat.getImage(extendFrom);
      if (!extendVideo) {
        throw new Error(`generateVideoSegment: extendFrom video not found: ${extendFrom}`);
      }
      requestConfig.extendFrom = extendFrom;
    }

    if (updateTarget) {
      const updateVideo = this.chat.getImage(updateTarget);
      if (!updateVideo) {
        throw new Error(`generateVideoSegment: updateTarget video not found: ${updateTarget}`);
      }
      requestConfig.updateTarget = updateTarget;
    }

    // Call Veo API using Google GenAI library
    let operation = null;
    let videoBytes = null;
    let videoMimeType = 'video/mp4';

    try {
      // Build the video generation request using library API
      const generateRequest = {
        model: modelName,
        prompt: String(prompt),
        config: {
          durationSeconds,
          aspectRatio,
        },
      };

      // Add optional config parameters
      if (negativePrompt) generateRequest.config.negativePrompt = negativePrompt;
      if (seed !== undefined) generateRequest.config.seed = seed;
      if (enhancePrompt) generateRequest.config.enhancePrompt = true;
      // Note: generateAudio is not currently supported by the API
      // Audio generation may be enabled by default in some models or require different parameter
      // if (generateAudio) generateRequest.config.generateAudio = generateAudio;
      // Note: lipsyncPrompt may not be supported - keeping for future API updates
      // if (lipsyncPrompt) generateRequest.config.lipsyncPrompt = lipsyncPrompt;

      // Add reference images
      if (refParts.length > 0) {
        generateRequest.referenceImages = refParts.map(part => part.inlineData);
      }

      // Add frame continuity
      if (firstFrameData) generateRequest.firstFrame = firstFrameData.inlineData;
      if (lastFrameData) generateRequest.lastFrame = lastFrameData.inlineData;

      // Add extension/modification
      if (extendFrom) {
        const extendVideo = this.chat.getImage(extendFrom);
        if (extendVideo) {
          const videoB64 = extendVideo.data_b64 ?? extendVideo.data_base64 ?? extendVideo.data ?? null;
          if (videoB64) {
            generateRequest.video = {
              inlineData: {
                data: String(videoB64),
                mimeType: extendVideo.mime_type || 'video/mp4',
              },
            };
          }
        }
      }

      if (updateTarget) {
        const updateVideo = this.chat.getImage(updateTarget);
        if (updateVideo) {
          const videoB64 = updateVideo.data_b64 ?? updateVideo.data_base64 ?? updateVideo.data ?? null;
          if (videoB64) {
            generateRequest.video = {
              inlineData: {
                data: String(videoB64),
                mimeType: updateVideo.mime_type || 'video/mp4',
              },
            };
          }
        }
      }

      // Use library method to generate video
      if (typeof client.models !== 'undefined' && typeof client.models.generateVideos === 'function') {
        operation = await client.models.generateVideos(generateRequest);
      } else {
        throw new Error('generateVideoSegment: client.models.generateVideos is not available. Please ensure @google/genai library is up to date.');
      }

      // Poll operation until complete
      if (operation && typeof operation === 'object' && !operation.done) {
        const pollInterval = 10000; // 10 seconds
        while (!operation.done) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          
          // Poll operation status using library method
          if (typeof client.operations !== 'undefined' && typeof client.operations.getVideosOperation === 'function') {
            operation = await client.operations.getVideosOperation({
              // operation: operation.name || operation,
              operation,
            });
          } else {
            throw new Error('generateVideoSegment: client.operations.getVideosOperation is not available. Please ensure @google/genai library is up to date.');
          }

          if (operation.error) {
            throw new Error(`generateVideoSegment: operation failed: ${operation.error.message || JSON.stringify(operation.error)}`);
          }
        }
      }

      // Extract video from completed operation
      if (operation && operation.response && operation.response.generatedVideos) {
        const generatedVideos = operation.response.generatedVideos;
        if (Array.isArray(generatedVideos) && generatedVideos.length > 0) {
          const videoFile = generatedVideos[0].video;
          
          // Download video using library method
          if (typeof client.files !== 'undefined' && typeof client.files.download === 'function') {
            // Use library download method
            const https = require('https');
            const http = require('http');
            const url = require('url');
            
            // The file object should have a uri or data property
            const videoUri = videoFile.uri || videoFile.data;
            if (videoUri) {
              if (typeof videoUri === 'string' && videoUri.startsWith('http')) {
                // Download from URI
                const parsedUrl = new url.URL(videoUri);
                const clientModule = parsedUrl.protocol === 'https:' ? https : http;
                
                videoBytes = await new Promise((resolve, reject) => {
                  clientModule.get(videoUri, (res) => {
                    const chunks = [];
                    res.on('data', (chunk) => chunks.push(chunk));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                    res.on('error', reject);
                  }).on('error', reject);
                });
              } else if (typeof videoUri === 'string') {
                // Base64 data
                videoBytes = Buffer.from(videoUri, 'base64');
              } else if (Buffer.isBuffer(videoUri)) {
                videoBytes = videoUri;
              }
            } else {
              // Try using library's download method directly
              try {
                const tempPath = require('os').tmpdir() + '/' + crypto.randomUUID() + '.mp4';
                await client.files.download({
                  file: videoFile,
                  downloadPath: tempPath,
                });
                videoBytes = fs.readFileSync(tempPath);
                fs.unlinkSync(tempPath); // Clean up temp file
              } catch (downloadError) {
                throw new Error(`generateVideoSegment: failed to download video: ${downloadError.message}`);
              }
            }
          } else {
            // Fallback: try to extract from file object directly
            const videoData = videoFile.data || videoFile.inlineData?.data;
            if (videoData) {
              videoBytes = Buffer.from(String(videoData), 'base64');
            } else {
              throw new Error('generateVideoSegment: video file format not recognized');
            }
          }
        } else {
          throw new Error('generateVideoSegment: no videos in operation response');
        }
      } else {
        throw new Error('generateVideoSegment: no video data returned from operation');
      }

      if (!videoBytes) {
        throw new Error('generateVideoSegment: failed to extract video data');
      }
    } catch (error) {
      throw new Error(`generateVideoSegment: API call failed: ${error.message || String(error)}`);
    }

    // Store video
    const videoBase64 = videoBytes.toString('base64');
    const videoRec = {
      kind: 'generated',
      mime_type: videoMimeType,
      data_b64: videoBase64,
      created_at: nowIso(),
      provider: 'gemini',
      prompt,
      reference_images: referenceImageIds,
      mode,
      extend_from: extendFrom ? String(extendFrom) : null,
      update_target: updateTarget ? String(updateTarget) : null,
      audio: generateAudio ? { type: 'native' } : (voiceoverAssetId ? { type: 'voiceover', voiceover_asset: voiceoverAssetId } : null),
      veo_operation: {
        name: operation?.name || null,
        model: modelName,
        config: requestConfig,
      },
    };
    const videoId = this.chat.addImage(videoRec);

    // Store audio if native generation returned separate audio
    let audioId = null;
    if (operation && operation.response && operation.response.audio) {
      const audioData = operation.response.audio.data || operation.response.audio.uri;
      if (audioData) {
        let audioBytes = null;
        if (typeof audioData === 'string' && audioData.startsWith('http')) {
          const https = require('https');
          const http = require('http');
          const url = require('url');
          const parsedUrl = new url.URL(audioData);
          const clientModule = parsedUrl.protocol === 'https:' ? https : http;
          
          audioBytes = await new Promise((resolve, reject) => {
            clientModule.get(audioData, (res) => {
              const chunks = [];
              res.on('data', (chunk) => chunks.push(chunk));
              res.on('end', () => resolve(Buffer.concat(chunks)));
              res.on('error', reject);
            }).on('error', reject);
          });
        } else if (typeof audioData === 'string') {
          audioBytes = Buffer.from(audioData, 'base64');
        } else if (Buffer.isBuffer(audioData)) {
          audioBytes = audioData;
        }

        if (audioBytes) {
          const audioRec = {
            kind: 'generated',
            mime_type: 'audio/mpeg',
            data_b64: audioBytes.toString('base64'),
            created_at: nowIso(),
            provider: 'gemini',
            video_id: videoId,
          };
          audioId = this.chat.addAudio(audioRec);
        }
      }
    }

    // Build assistant message
    const assistantMessage = {
      role: 'assistant',
      content: {
        type: 'video',
        provider: 'gemini',
        prompt,
        mode,
        reference_images: referenceImageIds,
        video: videoId,
        extend_from: extendFrom ? String(extendFrom) : null,
        update_target: updateTarget ? String(updateTarget) : null,
        audio: generateAudio ? { type: 'native', audio_id: audioId } : (voiceoverAssetId ? { type: 'voiceover', voiceover_asset: voiceoverAssetId } : null),
        operation: { name: operation?.name || null },
      },
    };
    this.chat.addMessage(assistantMessage);

    // Persist video history
    this.chat.data = this.chat.data && typeof this.chat.data === 'object' ? this.chat.data : {};
    if (!Array.isArray(this.chat.data.gemini_video_history)) {
      this.chat.data.gemini_video_history = [];
    }
    this.chat.data.gemini_video_history.push({
      user: userIntent,
      result: { video: videoId, operation: operation?.name || null },
    });
    this.chat.save();

    return {
      provider: 'gemini',
      prompt,
      mode,
      reference_images: referenceImageIds,
      video: videoId,
      audio: audioId,
      message: assistantMessage,
      operation: { name: operation?.name || null },
    };
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
        const toolsPath = path.join(__dirname, 'viib-etch-tools.json');
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
  setModelsFileName,
  getModelsFileName,
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

