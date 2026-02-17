# viib-etch

A powerful Node.js library for building coding agents with LLM integration. Designed for AI-powered development tools like Cursor IDE, viib-etch provides a complete interface for managing chat sessions, executing tools, streaming responses, and handling complex multi-turn conversations with large language models.

## Features

- 🤖 **Multi-Model Support**: Works with OpenAI (including GPT‑4o, GPT‑5.x, o‑series), OpenRouter, and Google Gemini/Veo
- 💬 **Chat Session Management**: Persistent chat sessions with automatic saving/loading on disk
- 🔧 **Tool Calling**: Built-in support for function calling with automatic tool execution
- 🧾 **Tool Diffs**: Stores diffs/patches from file‑modifying tools in `ChatSession.data`
- 🎬 **Image & Video Generation**: High‑level helpers for images and video segments (Gemini Veo and Sora via OpenAI Videos API)
- 📡 **Streaming**: Real-time streaming of responses and reasoning (including o‑series reasoning traces)
- 🎣 **Hooks System**: Comprehensive event hooks for monitoring requests, responses, and tool calls
- 📝 **System Prompts**: Dynamic system prompt loading from files with per‑model `system_prompt_file`
- 🧭 **API Routing**: Automatic routing between `/v1/chat/completions` and `/v1/responses` APIs
- 🛠️ **Rich Toolset**: Pre-built tools for file operations, terminal commands, code search, and more
- 💾 **Session Persistence**: Save and restore chat sessions across restarts

## Installation

```bash
npm install
```

## Quick Start

```javascript
const { createChat, openChat } = require('./viib-etch');

// Create a new chat session with console logging
const llm = createChat('gpt-5.1-coder', false, null, 'console');

// Send a message
await llm.send('Write a hello world function in Python');

// The response is automatically added to the chat history

// Later, open the same chat session
const llm2 = openChat(llm.chat.id, null, 'console');
await llm2.send('Now add error handling');
```

## Basic UI (mountable)

`viib-etch` includes a minimal, embeddable web UI in a single file: `viib-etch-ui.js`.

### Mount into your own Node server

```javascript
const http = require('http');
const { createViibEtchUI } = require('./viib-etch-ui');

const ui = createViibEtchUI({
  token: process.env.VIIB_ETCH_UI_TOKEN, // required (simple Bearer token auth)
  // chatsDir: '/path/to/chats',
  // modelsFile: '/path/to/viib-etch-models.json',
});

http.createServer((req, res) => {
  const handled = ui.handler(req, res);
  if (!handled) {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(8080, '0.0.0.0');
```

- Open the UI at `GET /ui` (requires `Authorization: Bearer <token>`).
- The UI script is served at `GET /viib-etch-ui.js`.

### Quick HTTPS helper (defaults)

```javascript
const { createViibEtchUI } = require('./viib-etch-ui');
const ui = createViibEtchUI({ token: 'my-token' });
ui.createHttpsServer({ port: 8443, certPath: 'zdte_cert.crt', keyPath: 'zdte_key.key' }).listen();
```

#### UI authentication

The UI requires a bearer token for all API calls:

- **Single token**: Pass `token` to `createViibEtchUI({ token })` or set `VIIB_ETCH_UI_TOKEN`.
- **Token file**: Put one token per line in `.viib-etch-tokens` (or override via `VIIB_ETCH_TOKENS_FILE`).

When opened in the browser, the UI prompts for a token (stored in `localStorage`) and sends it as `Authorization: Bearer …`.

```javascript
const { createChat } = require('./viib-etch');

// Create a new chat session with brief logging (string shortcut)
const coder = createChat('gpt-5.1-coder', true, null, 'brief')

// Ask it to implement 'web-search' tool, which is not implemented at the time of writing this.
// This request is fully functional, i.e. it does what normal coding agent, like Cursor IDE, does.
response = await coder.send("Implement web-search tool using brave web search. Add test cases, run them, and fix issues if any.", { stream: true})
```

### UI workflow

The browser UI (`/ui`) is optimized for running viib‑etch agents interactively:

- **Tabs** represent chat sessions. Right‑click / long‑press a tab to rename, delete, open the File Explorer, or view **Changes** (tracked edits per chat).
- The footer lets you pick **Model** and **Reasoning** level (`default`, `off`, `low`, `medium`, `high`, `minimal`).
- **Base directory** (`📁`): sets a per‑chat working directory for file/terminal tools.
- **System prompt** (`📜`): opens the selected model’s `system_prompt_file` directly in a floating file editor.
- **Image tools** (`🍌` button, 📋 clipboard, 🔗 URL): generate images and attach reference images.
- **Video tools** (`🐵` button): generate video segments via Veo or Sora, with controls for extend/update, duration, aspect ratio, resolution, and voiceover.

The UI communicates with the same Node server APIs described below and is entirely optional—the core library can be used headless.


## Configuration

### Models Configuration

Models are configured in `viib-etch-models.json`:

```json
{
  "name": "gpt-5.1-coder",
  "model": "gpt-5.1",
  "baseUrl": "https://api.openai.com/v1",
  "api_key_file": "/path/to/.openai-api-key",
  "system_prompt_file": "/path/to/viib-etch.system.coder.prompt",
  "tools": ["run_terminal_cmd", "read_file", "apply_patch"],
  "reasoning_effort": "high"
}
```

### API Keys

API keys can be provided via:
1. **File path** (recommended): Set `api_key_file` in model config
2. **Environment variable**:
   - `OPENAI_API_KEY` for OpenAI / OpenAI-compatible models (including OpenRouter)
   - `GEMINI_API_KEY` for Google Gemini models
   - `ANTHROPIC_API_KEY` for Anthropic Claude models
#### Anthropic baseUrl note

If you set `baseUrl` for Claude models, use `https://api.anthropic.com` (no trailing `/v1`).
If you provide `https://api.anthropic.com/v1`, viib-etch will normalize it automatically.

3. **Direct config**: `api_key` in model config (not recommended)

**File path resolution for `api_key_file`:**
- **Absolute paths**: Used as-is
- **Relative paths**: Resolved in order:
  1. Current working directory
  2. Directory containing the models file (`viib-etch-models.json`)
  3. Module directory (`__dirname`)

### System Prompts

System prompts can be:
- **File-based**: Set `system_prompt_file` in model config (reloaded on each request)
- **Inline**: Set `system_prompt` in model config

**File path resolution for `system_prompt_file`:**
- **Absolute paths**: Used as-is
- **Relative paths**: Resolved in order:
  1. Current working directory
  2. Directory containing the models file (`viib-etch-models.json`)
  3. Module directory (`__dirname`)

## Core API

### ChatModel

Represents a configured LLM model:

```javascript
const { ChatModel } = require('./viib-etch');

const models = ChatModel.loadModels('viib-etch-models.json');
const model = models.find(m => m.name === 'gpt-5.1-coder');
```

### ChatSession

Manages conversation state:

```javascript
const { ChatSession } = require('./viib-etch');

// Create a new session
const session = new ChatSession({
  title: 'My Chat',
  model_name: 'gpt-5.1-coder'
});

// Enable persistence
session.enablePersistence('./chats');

// Add messages
session.addMessage({ role: 'user', content: 'Hello' });
session.addMessage({ role: 'assistant', content: 'Hi there!' });

// Save and load
session.save();
const loaded = ChatSession.load(session.id);
```

#### Tool diffs in `ChatSession.data`

File-modifying tools may store diffs and patch commands in the session’s data for later inspection:

- `session.data.diffs[toolCallId] = { diff, patchCommand, toolName }`

Notes:
- These fields are persisted if the session is persistent.
- `_diff` / `_patchCommand` are stripped from the tool message content (they live in `session.data` instead).

#### File originals & base directory

- `session.data.fileOriginals[path]` stores the **original contents** of any file modified via `apply_patch` or `edit_file`, keyed by path.
- `session.base_dir` (and `ChatLLM.setBaseDir()`) control the working directory used for file and terminal tools. The UI’s 📁 button calls `/api/chat/:id/base_dir` to keep this in sync.

### ChatLLM

Main interface for LLM interactions:

```javascript
const { ChatLLM } = require('./viib-etch');

// Create with hooks
const llm = ChatLLM.newChatSession('gpt-5.1-coder', false, null, {
  onRequestStart: () => console.log('Request started'),
  onRequestDone: (elapsed) => console.log(`Request took ${elapsed}ms`),
  onReasoningStart: () => console.log('Reasoning...'),
  onReasoningData: (chunk) => process.stdout.write(chunk),
  onReasoningDone: (fullReasoning, elapsed) => console.log(`\nReasoning done (${elapsed}ms)`),
  onResponseStart: () => console.log('Response started'),
  onResponseData: (chunk) => process.stdout.write(chunk),
  onResponseDone: (content, elapsed) => console.log(`\nResponse done (${elapsed}ms)`),
  onToolCallStart: (toolCall, args) => console.log(`Tool: ${toolCall.function.name}`),
  onToolCallData: (toolCall, data) => console.log('Tool data:', data),
  onToolCallEnd: (toolCall, result, elapsed) => console.log(`Tool done (${elapsed}ms)`),
  onTitle: (title) => console.log(`Chat title: ${title}`)
});

// Send messages
await llm.send('Write a function to calculate fibonacci numbers');

// Or use complete() for more control
const result = await llm.complete({
  stream: true,
  temperature: 0.7,
  max_tokens: 1000,
  tools: customTools
});
```

## Available Tools

viib-etch includes a comprehensive set of tools for coding agents:

### File Operations
- **`read_file`**: Read files with line numbers, offset/limit support, and base64 encoding for images
- **`apply_patch`**: Apply structured patches to files (add, update, delete)
- **`delete_file`**: Delete files with graceful error handling
- **`list_dir`**: List directory contents with glob filtering
- **`glob_file_search`**: Search for files matching patterns, sorted by modification time

For `apply_patch` and `delete_file`, the library records a unified diff (and for `apply_patch`, the patch text) into `ChatSession.data.diffs` keyed by tool call id.

### Code Operations
- **`rg`**: Fast text search using ripgrep (respects .gitignore)
- **`read_lints`**: Read linter errors from IDE

### Terminal
- **`run_terminal_cmd`**: Execute terminal commands with streaming output, background support, and hooks

### Project Management
- **`todo_write`**: Manage todo lists in session data (create, update, merge, delete)
- **`update_memory`**: Store and retrieve knowledge in session data

### Web
- **`web_search`**: Web search capabilities (when configured)

## Tool Execution

Tools are automatically executed when the LLM requests them:

```javascript
const llm = ChatLLM.newChatSession('gpt-5.1-coder', false, null, {
  onToolCallStart: (toolCall, args) => {
    console.log(`Executing: ${toolCall.function.name}`, args);
  },
  onToolCallEnd: (toolCall, result) => {
    console.log(`Result:`, result);
  }
});

// The LLM can now use tools automatically
await llm.send('Read the file src/index.js and suggest improvements');
```

## Streaming

Both streaming and non-streaming modes are supported:

```javascript
// Non-streaming
const result = await llm.complete({ stream: false });
console.log(result.content);

// Streaming
const result = await llm.complete({ stream: true });
// Content is streamed via onResponseData hook
// result.content contains the full response
```

## API Routing

viib-etch automatically routes requests to the appropriate API:

- **`/v1/chat/completions`**: For GPT-4 and older models
- **`/v1/responses`**: For GPT-4o, GPT-5, and newer models (with response_id support)

The library handles:
- Automatic API selection based on model
- Response ID management for conversation continuity
- Error handling and retry logic for invalid response IDs
- Tool format normalization between APIs

## Convenience Functions

```javascript
const {
  ChatModel,
  ChatSession,
  ChatLLM,
  setModelsFileName,
  getModelsFileName,
  setChatsDir,
  getChatsDir,
  consoleLogHooks,
  loadModels,
  loadChat,
  listChatSessions,
  createChat,
  openChat
} = require('./viib-etch');

// Load models
const models = loadModels('viib-etch-models.json');

// Load a chat session (returns ChatSession)
const chat = loadChat('chat-id-here');

// List all chat sessions
const sessions = listChatSessions();
sessions.forEach(s => {
  console.log(`${s.id}: ${s.title} (${s.message_count} messages)`);
});

// Configure models file location
setModelsFileName('/path/to/custom-models.json');
const currentModelsFile = getModelsFileName();

// Configure chats directory location
setChatsDir('/path/to/custom-chats');
const currentChatsDir = getChatsDir();

// Create chat with string hooks (convenient shortcuts)
const llm1 = createChat('gpt-5.1-coder', false, null, 'console');  // Full console logging
const llm2 = createChat('gpt-5.1-coder', false, null, 'brief');     // Brief console logging

// Create chat with custom hooks object
const llm3 = createChat('gpt-5.1-coder', false, null, 
  consoleLogHooks({ response: true, reasoning: true, tools: true })
);

// Open an existing chat session (returns ChatLLM)
const llm4 = openChat('chat-id-here', null, 'console');  // With console hooks
const llm5 = openChat('chat-id-here', null, 'brief');    // With brief hooks
const llm6 = openChat('chat-id-here', null, customHooks); // With custom hooks
```

## Examples

### Basic Chat

```javascript
const { createChat } = require('./viib-etch');

// Simple chat
const llm = createChat('gpt-4.1-mini', false);
await llm.send('Hello!');

// With console logging
const llm2 = createChat('gpt-4.1-mini', false, null, 'console');
await llm2.send('Hello!');
```

### Chat with Tools

```javascript
const { ChatLLM } = require('./viib-etch');
const { getToolDefinitions } = require('./viib-etch-tools');

// Load tools
const tools = getToolDefinitions('./viib-etch-tools.json', [
  'read_file',
  'apply_patch',
  'run_terminal_cmd'
]);

const llm = ChatLLM.newChatSession('gpt-5.1-coder', false, tools);
await llm.send('Read package.json and update the version to 2.0.0');
```

### Registering 3rd-party tools (definitions + handlers)

You can extend the tool system from outside by registering **tool definitions + handlers** at runtime.
Registered tool definitions are included by `getToolDefinitions(...)`, and registered handlers are used by `executeTool(...)`.

```javascript
const { registerTool } = require('./viib-etch-tools');

// Register a tool definition + handler (does not need to exist in viib-etch-tools.json)
registerTool({
  type: 'function',
  function: {
    name: 'calculator',
    description: 'Evaluate a basic arithmetic expression and return the numeric result.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
  },
}, async (args) => {
  const expr = String(args?.expression || '');
  // Example only: validate input appropriately for your use case.
  // eslint-disable-next-line no-new-func
  const result = Function(`"use strict"; return (${expr});`)();
  return { success: true, result };
});
```

Then you can include it when building tools:

```javascript
const path = require('path');
const { getToolDefinitions } = require('./viib-etch-tools');

const toolsPath = path.join(__dirname, 'viib-etch-tools.json');
const tools = getToolDefinitions(toolsPath, ['calculator']);
```

### Persistent Chat Sessions

```javascript
const { createChat, openChat } = require('./viib-etch');

// Create persistent session
const llm = createChat('gpt-5.1-coder', true, null, 'console');
// Session is automatically saved to ./chats/

// Later, open the session (easier than manual loading)
const llm2 = openChat(llm.chat.id, null, 'console');
await llm2.send('Continue from where we left off');
```

Or using the lower-level API:

```javascript
const { ChatLLM, loadChat } = require('./viib-etch');

// Create persistent session
const llm = ChatLLM.newChatSession('gpt-5.1-coder', true, null);
// Session is automatically saved to ./chats/

// Later, load the session manually
const loaded = loadChat(llm.chat.id);
const llm2 = new ChatLLM(null, loaded);
```

### Custom Hooks

```javascript
const hooks = {
  onRequestStart: async () => {
    console.log('🚀 Starting request...');
  },
  onTitle: async (title) => {
    console.log(`📝 Chat titled: ${title}`);
  },
  onResponseData: async (chunk) => {
    process.stdout.write(chunk);
  },
  onToolCallStart: async (toolCall, args) => {
    console.log(`🔧 ${toolCall.function.name}(${JSON.stringify(args)})`);
  },
  onToolCallEnd: async (toolCall, result, elapsed) => {
    console.log(`✅ Done in ${elapsed}ms`);
  }
};

const llm = ChatLLM.newChatSession('gpt-5.1-coder', false, null, hooks);
```

## Testing

Run the test suites:

```bash
# Test tools
node test-viib-etch-tools.js

# Test main library
node test-viib-etch.js
```

## Architecture

viib-etch is designed for coding agents with these key components:

1. **ChatModel**: Model configuration and API key management
2. **ChatSession**: Conversation state and persistence
3. **ChatLLM**: Main interface for LLM interactions
4. **Tool System**: Extensible tool execution framework
5. **Hook System**: Event-driven monitoring and logging

## License

See LICENSE file for details.

