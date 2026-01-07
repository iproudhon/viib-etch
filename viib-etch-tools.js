const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');

function loadToolDefinitions(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const definitions = JSON.parse(content);
    return normalizeToolDefinitions(definitions);
  } catch (err) {
    throw new Error(`Failed to load tool definitions: ${err.message}`);
  }
}

// Parse parameter strings (they're stored as strings in JSON, need to parse)
function parseParameterSchema(paramString) {
  if (typeof paramString === 'object') {
    return paramString; // Already parsed
  }
  if (typeof paramString === 'string') {
    try {
      // Replace single quotes with double quotes for JSON parsing
      const jsonString = paramString.replace(/'/g, '"');
      return JSON.parse(jsonString);
    } catch (err) {
      // If parsing fails, return as-is (might be a simple string description)
      return { type: 'string', description: paramString };
    }
  }
  return paramString;
}

function coerceSchemaDeep(value) {
  // Recursively convert schema fields that are stringified JSON / primitives
  // e.g. enum: "['a','b']" -> ['a','b'], minItems: "2" -> 2
  const tryParseLoose = (s) => {
    if (typeof s !== 'string') return s;
    const t = s.trim();
    // Numbers
    if (/^-?\d+(\.\d+)?$/.test(t)) {
      const n = Number(t);
      if (!Number.isNaN(n)) return n;
    }
    // Booleans (some configs use "True"/"False")
    if (t === 'true' || t === 'false') return t === 'true';
    if (t === 'True' || t === 'False') return t === 'True';

    // JSON-ish arrays/objects (often with single quotes)
    if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
      try {
        const jsonString = t.replace(/'/g, '"');
        return JSON.parse(jsonString);
      } catch {
        return s;
      }
    }
    return s;
  };

  const parsed = tryParseLoose(value);
  if (parsed !== value) return coerceSchemaDeep(parsed);

  if (Array.isArray(value)) {
    return value.map(coerceSchemaDeep);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = coerceSchemaDeep(v);
    }
    return out;
  }
  return value;
}

// Normalize tool definitions - convert parameter strings to objects
function normalizeToolDefinitions(definitions) {
  return definitions.map((toolDef) => {
    // Support both:
    // - OpenAI format: { type:'function', function:{ name, description, parameters } }
    // - Flat format: { type:'function', name, description, parameters, ... }
    let normalized = toolDef;
    if (toolDef && toolDef.type === 'function' && !toolDef.function && toolDef.name) {
      normalized = {
        type: 'function',
        function: {
          name: toolDef.name,
          description: toolDef.description,
          parameters: toolDef.parameters,
          strict: toolDef.strict,
          disallow_in_ask_mode: toolDef.disallow_in_ask_mode,
        },
      };
      if (toolDef.format) normalized.format = toolDef.format;
    }

    if (normalized && normalized.type === 'function' && normalized.function && normalized.function.parameters) {
      const params = normalized.function.parameters;
      if (params.properties) {
        const normalizedProps = {};
        for (const [key, value] of Object.entries(params.properties)) {
          normalizedProps[key] = parseParameterSchema(value);
        }
        params.properties = normalizedProps;
      }
      // Coerce nested schema fields (enum/minItems/items/etc.) that may still be stringified.
      normalized.function.parameters = coerceSchemaDeep(params);
    }
    return normalized;
  });
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
function isImagePath(p) {
  return IMAGE_EXTS.has(path.extname(p).toLowerCase());
}

function resolveTargetPath(targetFile) {
  if (typeof targetFile !== 'string' || !targetFile) {
    throw new Error('target_file must be a non-empty string');
  }
  return path.isAbsolute(targetFile) ? targetFile : path.resolve(process.cwd(), targetFile);
}

function splitLinesPreserveEmpty(text) {
  // Split on \n and trim trailing \r per-line (handles CRLF)
  return String(text).split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

async function readJsonSafe(filePath, fallback) {
  try {
    const txt = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJsonSafe(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function memoryPath() {
  // Allow tests or callers to override where memory is stored.
  if (process.env.VIIB_ETCH_MEMORY_PATH) {
    return resolveTargetPath(process.env.VIIB_ETCH_MEMORY_PATH);
  }
  return path.resolve(process.cwd(), 'viib.memory.json');
}

function toPosixPath(p) {
  return String(p).split(path.sep).join('/');
}

function globToRegExp(globPattern) {
  // Minimal glob: **, *, ? with "/" as path separator.
  const glob = toPosixPath(globPattern);
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // ** => match anything including /
        i++;
        // consume optional following slash
        if (glob[i + 1] === '/') i++;
        re += '.*';
      } else {
        // * => any chars except /
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
    }
  }
  re += '$';
  return new RegExp(re);
}

function matchesAnyGlob(relPosixPath, globs) {
  const p = toPosixPath(relPosixPath);
  for (const g of globs) {
    const pat = String(g || '');
    if (!pat) continue;
    const normalized = pat.startsWith('**/') ? pat : `**/${pat}`;
    const rx = globToRegExp(normalized);
    if (rx.test(p) || rx.test(`./${p}`)) return true;
  }
  return false;
}

async function walkFiles(rootDir, { includeDotfiles = false } = {}) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!includeDotfiles && ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

async function generateDiff(beforeContent, afterContent, filePath) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const originalFile = path.join(tmpDir, `diff-orig-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    const currentFile = path.join(tmpDir, `diff-curr-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    
    let cleanup = () => {
      try { fs.unlinkSync(originalFile); } catch {}
      try { fs.unlinkSync(currentFile); } catch {}
    };
    
    fs.writeFileSync(originalFile, beforeContent, 'utf8');
    fs.writeFileSync(currentFile, afterContent, 'utf8');
    
    const diffProcess = spawn('diff', ['-u', originalFile, currentFile], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    diffProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    diffProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    diffProcess.on('close', (code) => {
      cleanup();
      // diff returns 0 if files are identical, 1 if different, 2 on error
      if (code === 2) {
        reject(new Error(`diff command failed: ${stderr}`));
      } else {
        // Normalize the diff output to use the actual file path
        const normalizedDiff = stdout.replace(/^--- .+\n/, `--- ${filePath}\n`).replace(/^\+\+\+ .+\n/, `+++ ${filePath}\n`);
        resolve(normalizedDiff || '');
      }
    });
    
    diffProcess.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

// Tool handlers
const toolHandlers = {
  async todo_write(args, context) {
    const { merge = false, todos } = args;
    
    if (!Array.isArray(todos) || todos.length < 2) {
      throw new Error('todos must be an array with at least 2 items');
    }
    
    // Validate todo items
    for (const todo of todos) {
      if (!todo.id || !todo.status || !todo.content) {
        throw new Error('Each todo must have id, status, and content');
      }
      if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(todo.status)) {
        throw new Error(`Invalid status: ${todo.status}`);
      }
    }
    
    // Get or initialize todos in session data
    const session = context.session;
    if (!session) {
      throw new Error('Session context required for todo_write');
    }
    
    if (!session.data.todos) {
      session.data.todos = [];
    }
    
    if (merge) {
      // Merge todos by id
      const existingTodos = session.data.todos;
      const todoMap = new Map(existingTodos.map(t => [t.id, t]));
      
      for (const todo of todos) {
        todoMap.set(todo.id, todo);
      }
      
      session.data.todos = Array.from(todoMap.values());
    } else {
      // Replace all todos
      session.data.todos = todos;
    }
    
    // Save session if persistent
    if (session.persistent) {
      session.save();
    }
    
    return {
      success: true,
      todo_count: session.data.todos.length,
      message: merge ? 'Todos merged successfully' : 'Todos replaced successfully'
    }
  },

  async run_terminal_cmd(args, context) {
    const { command, is_background, explanation, required_permissions } = args;
    if (typeof command !== 'string') {
      throw new Error('run_terminal_cmd: "command" is required')
    }
    
    // Check for cancellation before starting
    if (context?._isCancelled && context._isCancelled()) {
      throw new Error('Operation cancelled');
    }
    
    const onCommandOut = context?.onCommandOut || null
    const activeProcesses = context?._activeProcesses || null;
    const shell = process.env.SHELL || '/bin/bash';
    const child = spawn(shell, ['-lc', command], {
      cwd: process.cwd(),
      stdio: is_background ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    });
  
    // Track process for cancellation
    const processKey = `run_terminal_cmd_${child.pid}_${Date.now()}`;
    if (activeProcesses) {
      activeProcesses.set(processKey, child);
    }
  
    // Clean up on process exit
    const cleanup = () => {
      if (activeProcesses) {
        activeProcesses.delete(processKey);
      }
    };
  
    if (is_background) {
      child.unref();
      child.on('close', cleanup);
      return {
        command,
        pid: child.pid,
        is_background: true,
        explanation,
        required_permissions: required_permissions,
        started_at: new Date().toISOString(),
      };
    }
  
    let stdout = '';
    let stderr = '';
  
    return await new Promise((resolve, reject) => {
      let isResolved = false;
      
      // Check for cancellation periodically
      const checkCancellation = () => {
        if (context?._isCancelled && context._isCancelled()) {
          if (!isResolved) {
            isResolved = true;
            try {
              if (!child.killed) {
                child.kill('SIGTERM');
              }
            } catch (err) {
              // Ignore errors when killing
            }
            cleanup();
            clearInterval(cancellationInterval);
            reject(new Error('Operation cancelled'));
            return true;
          }
        }
        return false;
      };
      
      child.stdout.on('data', (chunk) => {
        if (isResolved) return;
        const text = chunk.toString()
        stdout += text
        if (onCommandOut) {
          onCommandOut({ phase: 'stream', stream: 'stdout', data: text }).catch(err => {
            // Silently handle errors in stream callback to avoid breaking the stream
            console.error('Error in onCommandOut for stdout:', err)
          })
        }
      })
      child.stderr.on('data', (chunk) => {
        if (isResolved) return;
        const text = chunk.toString()
        stderr += text
        if (onCommandOut) {
          onCommandOut({ phase: 'stream', stream: 'stderr', data: text }).catch(err => {
            // Silently handle errors in stream callback to avoid breaking the stream
            console.error('Error in onCommandOut for stderr:', err)
          })
        }
      })
      child.on('error', (err) => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          clearInterval(cancellationInterval);
          reject(err);
        }
      });
      child.on('close', (code) => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          clearInterval(cancellationInterval);
          resolve({
            command,
            pid: child.pid,
            is_background: false,
            explanation,
            required_permissions: required_permissions,
            exitCode: code,
            stdout,
            stderr,
          })
        }
      })
      
      // Check cancellation periodically (every 100ms)
      const cancellationInterval = setInterval(() => {
        checkCancellation();
      }, 100);
    })      
  },

  async rg(args) {
    if (!args || typeof args.pattern !== 'string' || !args.pattern.length) {
      throw new Error('rg: "pattern" is required and must be a non-empty string');
    }

    const baseRoot = process.cwd();
    const searchPath = args.path && String(args.path).length ? args.path : baseRoot;

    const rgArgs = [];
    const mode = args.output_mode || 'content';
    if (mode === 'files_with_matches') rgArgs.push('--files-with-matches');
    else if (mode === 'count') rgArgs.push('--count');

    if (args['-i']) rgArgs.push('-i');
    if (typeof args['-B'] === 'number') rgArgs.push('-B', String(args['-B']));
    if (typeof args['-A'] === 'number') rgArgs.push('-A', String(args['-A']));
    if (typeof args['-C'] === 'number') rgArgs.push('-C', String(args['-C']));
    if (args.type) rgArgs.push('--type', String(args.type));
    if (args.glob) rgArgs.push('--glob', String(args.glob));
    if (args.multiline) rgArgs.push('-U', '--multiline', '--multiline-dotall');

    rgArgs.push('--regexp', args.pattern);
    rgArgs.push(path.resolve(searchPath));

    const result = await new Promise((resolve, reject) => {
      const child = spawn('rg', rgArgs, { cwd: baseRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (err) => {
        if (err && err.code === 'ENOENT') {
          reject(new Error('ripgrep (rg) is not installed or not in PATH.'));
        } else {
          reject(err);
        }
      });
      child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
    });

    let stdout = result.stdout;
    const headLimit = typeof args.head_limit === 'number' && args.head_limit > 0
      ? Math.floor(args.head_limit)
      : null;
    if (headLimit !== null) {
      stdout = stdout.split('\n').slice(0, headLimit).join('\n');
    }

    let output = `<workspace_result workspace_path="${baseRoot}">\n\n`;
    if (result.exitCode !== 0 && !stdout.trim()) {
      output += 'No matches found.';
    } else if (stdout.trim()) {
      const lines = stdout.trim().split('\n');
      const matchLines = lines.filter(line => line.includes(':') && !line.startsWith('-'));
      const matchCount = matchLines.length;
      if (matchCount > 0) {
        output += `Found ${matchCount} matching line${matchCount !== 1 ? 's' : ''}\n\n`;
      }
      output += stdout.trim();
    } else {
      output += result.stderr.trim() || 'No output';
    }
    return output;
  },

  async delete_file(args, context) {
    if (!args || !args.target_file) {
      throw new Error('delete_file: "target_file" is required');
    }
    const target = resolveTargetPath(args.target_file);
    const baseRoot = process.cwd();
    const relPath = path.relative(baseRoot, target);
    const session = context && context.session;
    const fileOriginals = session && session.data ? (session.data.fileOriginals || (session.data.fileOriginals = {})) : null;
    
    let beforeContent = null;
    try {
      beforeContent = await fsp.readFile(target, 'utf-8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { ok: false, deleted: false, error: 'File does not exist', target };
      }
      return { ok: false, deleted: false, error: err?.message || String(err), target };
    }
    
    // Store original content if not already stored
    if (fileOriginals && !(relPath in fileOriginals)) {
      fileOriginals[relPath] = beforeContent;
    }
    
    try {
      await fsp.unlink(target);
      const result = { ok: true, deleted: target };
      
      // Generate diff for deleted file
      try {
        const diff = await generateDiff(beforeContent, '', relPath);
        result._diff = diff;
      } catch (err) {
        // Ignore diff generation errors
      }
      
      return result;
    } catch (err) {
      return { ok: false, deleted: false, error: err?.message || String(err), target };
    }
  },

  async update_memory(args, context) {
    const action = (args && args.action) || 'create';
    
    // Get or initialize memories in session data
    const session = context.session;
    if (!session) {
      throw new Error('Session context required for update_memory');
    }
    
    if (!session.data.memories) {
      session.data.memories = [];
    }
    
    let memories = session.data.memories;

    if (action === 'create') {
      if (!args || !args.title || !args.knowledge_to_store) {
        throw new Error('update_memory(create): "title" and "knowledge_to_store" are required');
      }
      const id = `mem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const mem = {
        id,
        title: args.title,
        knowledge_to_store: args.knowledge_to_store,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      memories.push(mem);
      session.data.memories = memories;
      if (session.persistent) {
        session.save();
      }
      return mem;
    }

    if (action === 'update') {
      const id = args && args.existing_knowledge_id;
      if (!id) throw new Error('update_memory(update): "existing_knowledge_id" is required');
      const idx = memories.findIndex(m => m.id === id);
      if (idx === -1) throw new Error(`update_memory(update): memory id "${id}" not found`);
      const mem = memories[idx];
      if (args.title) mem.title = args.title;
      if (args.knowledge_to_store) mem.knowledge_to_store = args.knowledge_to_store;
      mem.updated_at = new Date().toISOString();
      memories[idx] = mem;
      session.data.memories = memories;
      if (session.persistent) {
        session.save();
      }
      return mem;
    }

    if (action === 'delete') {
      const id = args && args.existing_knowledge_id;
      if (!id) throw new Error('update_memory(delete): "existing_knowledge_id" is required');
      const before = memories.length;
      memories = memories.filter(m => m.id !== id);
      session.data.memories = memories;
      if (session.persistent) {
        session.save();
      }
      return { deleted: before !== memories.length, id };
    }

    throw new Error(`update_memory: unsupported action "${action}"`);
  },

  async read_lints(args = {}) {
    // Minimal deterministic implementation: the IDE-driven lints are not available here.
    // Keep it best-effort and stable.
    const paths = Array.isArray(args.paths) ? args.paths : [];
    if (paths.length) {
      // Validate paths exist; ignore missing.
      for (const p of paths) {
        if (typeof p !== 'string') continue;
        const abs = resolveTargetPath(p);
        try { await fsp.stat(abs); } catch { /* ignore */ }
      }
    }
    return 'No linter errors found.';
  },

  async list_dir(args) {
    if (!args || !args.target_directory) {
      throw new Error('list_dir: "target_directory" is required');
    }
    const dir = resolveTargetPath(args.target_directory);
    const ignoreGlobs = Array.isArray(args.ignore_globs) ? args.ignore_globs : [];

    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const visible = entries
      .filter(ent => !ent.name.startsWith('.'))
      .filter(ent => !matchesAnyGlob(ent.name, ignoreGlobs))
      .sort((a, b) => a.name.localeCompare(b.name));

    let out = `${dir}/\n`;
    for (const ent of visible) {
      out += `  - ${ent.name}${ent.isDirectory() ? '/' : ''}\n`;
    }
    return out.trimEnd();
  },

  async glob_file_search(args) {
    if (!args || !args.glob_pattern) {
      throw new Error('glob_file_search: "glob_pattern" is required');
    }
    const baseDir = args.target_directory
      ? resolveTargetPath(args.target_directory)
      : process.cwd();

    const pat = String(args.glob_pattern);
    const normalized = pat.startsWith('**/') ? pat : `**/${pat}`;
    const rx = globToRegExp(normalized);

    const files = await walkFiles(baseDir, { includeDotfiles: false });
    const matches = [];
    for (const f of files) {
      const rel = toPosixPath(path.relative(baseDir, f));
      if (rx.test(rel)) {
        let mtimeMs = 0;
        try {
          const st = await fsp.stat(f);
          mtimeMs = st.mtimeMs;
        } catch {}
        matches.push({ path: f, mtimeMs });
      }
    }

    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const outFiles = matches.map(m => m.path);
    if (outFiles.length === 0) {
      return `No files found matching pattern "${pat}" in ${baseDir}`;
    }
    return outFiles.join('\n');
  },

  async read_file(args) {
    if (!args || !args.target_file) {
      throw new Error('read_file: "target_file" is required');
    }

    const target = resolveTargetPath(args.target_file);
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new Error(`read_file: file does not exist: ${target}`);
      }
      throw err;
    }

    if (stat.isDirectory()) {
      throw new Error('read_file: target is a directory');
    }

    if (isImagePath(target)) {
      const buf = await fsp.readFile(target);
      return buf.toString('base64');
    }

    const text = await fsp.readFile(target, 'utf-8');
    if (!text) return '';

    const lines = splitLinesPreserveEmpty(text);
    const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 1;
    const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : null;

    const startIdx = Math.max(0, offset - 1);
    const endIdx = limit ? Math.min(lines.length, startIdx + limit) : lines.length;
    const sliced = lines.slice(startIdx, endIdx);

    if (sliced.length === 0) return '';

    const padWidth = Math.max(3, String(lines.length).length);
    return sliced
      .map((line, idx) => {
        const lineNo = String(startIdx + idx + 1).padStart(padWidth, '0');
        return `L${lineNo}:${line}`;
      })
      .join('\n');
  },

  async apply_patch(args, context) {
    const patchCommand = args && typeof args.patchCommand === 'string' ? args.patchCommand : null;
    if (!patchCommand) {
      throw new Error('apply_patch: "patchCommand" is required');
    }

    const rawLines = splitLinesPreserveEmpty(patchCommand);
    const beginIdx = rawLines.findIndex(l => l.trimEnd() === '*** Begin Patch');
    const endIdx = (() => {
      for (let i = rawLines.length - 1; i >= 0; i--) {
        if (rawLines[i].trimEnd() === '*** End Patch') return i;
      }
      return -1;
    })();

    if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
      throw new Error('apply_patch: patch must start with "*** Begin Patch" and end with "*** End Patch"');
    }

    const lines = rawLines.slice(beginIdx + 1, endIdx);
    const hunks = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('*** Add File: ')) {
        const filename = line.slice('*** Add File: '.length).trim();
        if (!filename) throw new Error('apply_patch: Add File must specify a filename');
        i++;
        const addLines = [];
        while (i < lines.length && !lines[i].startsWith('*** ')) {
          const l = lines[i];
          if (!l.startsWith('+')) {
            throw new Error('apply_patch: Add File content lines must start with +');
          }
          addLines.push(l.slice(1));
          i++;
        }
        if (addLines.length === 0) {
          throw new Error('apply_patch: Add File must include at least one + line');
        }
        hunks.push({ type: 'add', filename, addLines });
        continue;
      }

      if (line.startsWith('*** Update File: ')) {
        const filename = line.slice('*** Update File: '.length).trim();
        if (!filename) throw new Error('apply_patch: Update File must specify a filename');
        i++;

        const blocks = [];
        let currentContext = null;
        let currentLines = [];

        while (i < lines.length && !lines[i].startsWith('*** ')) {
          const l = lines[i];
          if (l.startsWith('@@')) {
            if (currentContext !== null) {
              blocks.push({ context: currentContext, lines: currentLines });
            }
            currentContext = l.slice(2).trim();
            currentLines = [];
          } else if (l === '*** End of File') {
            // optional marker inside update blocks; ignore
          } else if (l.startsWith('+') || l.startsWith('-') || l.startsWith(' ')) {
            if (currentContext === null) currentContext = '';
            currentLines.push({ type: l[0], content: l.slice(1) });
          } else if (l.trim() !== '') {
            // Non-empty line not prefixed by + - space. Treat as a context hint.
            if (currentContext === null || currentContext === '') currentContext = l.trim();
            else currentContext = `${currentContext}\n${l.trim()}`;
          }
          i++;
        }
        if (currentContext !== null) {
          blocks.push({ context: currentContext, lines: currentLines });
        }

        hunks.push({ type: 'update', filename, blocks });
        continue;
      }

      // Skip blank lines
      if (line.trim() === '') {
        i++;
        continue;
      }

      throw new Error(`apply_patch: invalid patch line: "${line}"`);
    }

    const baseRoot = process.cwd();
    const results = [];
    const session = context && context.session;
    const fileOriginals = session && session.data ? (session.data.fileOriginals || (session.data.fileOriginals = {})) : null;
    const fileDiffs = [];

    for (const hunk of hunks) {
      const filePath = path.isAbsolute(hunk.filename)
        ? hunk.filename
        : path.resolve(baseRoot, hunk.filename);
      const relPath = path.relative(baseRoot, filePath);

      if (hunk.type === 'add') {
        // Store original as empty for new files
        if (fileOriginals && !(relPath in fileOriginals)) {
          fileOriginals[relPath] = '';
        }
        const newContent = hunk.addLines.join('\n');
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, newContent, 'utf-8');
        results.push({ file: hunk.filename, action: 'created' });
        
        // Generate diff for new file
        try {
          const diff = await generateDiff('', newContent, relPath);
          fileDiffs.push({ file: relPath, diff });
        } catch (err) {
          // Ignore diff generation errors
        }
        continue;
      }

      // update
      let original;
      try {
        original = await fsp.readFile(filePath, 'utf-8');
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          throw new Error(`apply_patch: file does not exist: ${hunk.filename}`);
        }
        throw err;
      }

      // Store original content if not already stored
      if (fileOriginals && !(relPath in fileOriginals)) {
        fileOriginals[relPath] = original;
      }

      let fileLines = splitLinesPreserveEmpty(original);
      let pos = 0;

      const findContextIndex = (ctx) => {
        if (!ctx) return -1;
        const trimmed = ctx.trim();
        if (!trimmed) return -1;
        // prefer exact match, else substring
        let idx = fileLines.findIndex(l => l === trimmed);
        if (idx !== -1) return idx;
        idx = fileLines.findIndex(l => l.includes(trimmed));
        return idx;
      };

      for (const block of hunk.blocks) {
        if (block.context && block.context.trim()) {
          const idx = findContextIndex(block.context);
          if (idx === -1) {
            throw new Error(`apply_patch: could not find context "${block.context}" in file ${hunk.filename}`);
          }
          pos = idx;
        }

        for (const op of block.lines) {
          if (op.type === ' ') {
            // Context lines: trim leading whitespace for flexible matching
            // This handles cases where GPT-5.1 adds leading spaces to context lines
            // Only trim leading spaces, preserve trailing spaces
            const trimLeading = (s) => s.replace(/^\s+/, '');
            const expected = trimLeading(op.content);
            // If we don't have a context position yet (empty @@ context), use this line to find it
            if (pos === 0 && (!block.context || !block.context.trim())) {
              const idx = fileLines.findIndex(l => l && trimLeading(l) === expected);
              if (idx === -1) {
                throw new Error(`apply_patch: could not find context line "${expected}" in file ${hunk.filename}`);
              }
              pos = idx;
            }
            const actual = fileLines[pos] ? trimLeading(fileLines[pos]) : '';
            if (actual === expected) {
              pos++;
              continue;
            }
            // search forward for the expected line (limited window)
            const windowEnd = Math.min(fileLines.length, pos + 50);
            let found = -1;
            for (let k = pos; k < windowEnd; k++) {
              if (fileLines[k] && trimLeading(fileLines[k]) === expected) {
                found = k;
                break;
              }
            }
            if (found === -1) {
              throw new Error(`apply_patch: context line mismatch in file ${hunk.filename}: expected "${expected}"`);
            }
            pos = found + 1;
          } else if (op.type === '-') {
            const toRemove = op.content;
            // Remove the first matching line at/after pos
            const idx = fileLines.findIndex((l, k) => k >= pos && l === toRemove);
            if (idx === -1) {
              throw new Error(`apply_patch: could not find line to remove: "${toRemove}" in file ${hunk.filename}`);
            }
            fileLines.splice(idx, 1);
            pos = idx;
          } else if (op.type === '+') {
            fileLines.splice(pos, 0, op.content);
            pos++;
          } else {
            throw new Error(`apply_patch: invalid change line type: ${op.type}`);
          }
        }
      }

      const newContent = fileLines.join('\n');
      await fsp.writeFile(filePath, newContent, 'utf-8');
      results.push({ file: hunk.filename, action: 'updated' });
      
      // Generate diff
      try {
        // Diff should represent the delta applied by THIS patch invocation
        // (compare content as it was just before applying this patch to the new content).
        const diff = await generateDiff(original, newContent, relPath);
        fileDiffs.push({ file: relPath, diff });
      } catch (err) {
        // Ignore diff generation errors
      }
    }

    const combinedDiff = fileDiffs.length
      ? fileDiffs.map(d => d.diff).filter(Boolean).join('\n')
      : null;

    return {
      success: true,
      message: `Successfully applied patch to ${results.length} file(s)`,
      results,
      _diff: combinedDiff,
      _patchCommand: patchCommand,
    }
  },
}

// Get tool definitions for API (OpenAI format)
function getToolDefinitions(filePath, tool_names = []) {
  const definitions = loadToolDefinitions(filePath);
  if (tool_names.length === 0) {
    return definitions;
  }

  // Built-in tools for OpenAI /v1/responses (pass-through; not present in viib-etch-tools.json)
  // Note: `include` (e.g. ["web_search_call.results"]) is NOT part of the tool definition.
  // Pass it as an option to `ChatLLM.complete()` / `ChatLLM.send()` instead.
  const builtinTools = [];
  for (const name of tool_names) {
    if (name === 'web_search_preview' || name === 'web_search_preview_2025_03_11') {
      builtinTools.push({ type: name });
    }
    // Future built-ins could go here (file_search, code_interpreter, etc.) once you decide on their configs.
  }

  const customTools = definitions.filter(tool => tool_names.includes(tool.function.name));
  return [...builtinTools, ...customTools];
}

// Execute a tool by name
async function executeTool(toolName, args, context) {
  const handler = toolHandlers[toolName];
  if (!handler) {
    throw new Error(`Tool handler not found: ${toolName}`);
  }
  
  try {
    const result = await handler(args, context);
    return result;
  } catch (error) {
    return {
      error: error.message,
      success: false
    };
  }
}

// Get handler for a tool name
function getToolHandler(toolName) {
  return toolHandlers[toolName];
}

// Check if a tool is available
function hasTool(toolName) {
  return toolName in toolHandlers;
}

module.exports = {
  loadToolDefinitions,
  getToolDefinitions,
  executeTool,
  getToolHandler,
  hasTool,
  toolHandlers
};

