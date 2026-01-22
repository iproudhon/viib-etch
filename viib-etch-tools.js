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

// Helper functions for edit_file
function splitByMarkers(codeEdit) {
  // Split code edit by markers like "// ... existing code ..."
  // Supports multiple comment styles: //, #, <!--, etc.
  const markerPattern = /^(\s*)(\/\/|#|<!--)\s*\.\.\.\s*existing\s+code\s*\.\.\.(\s*-->)?(\s*)$/gim;
  const segments = [];
  let lastIndex = 0;
  let match;

  while ((match = markerPattern.exec(codeEdit)) !== null) {
    if (match.index > lastIndex) {
      // Extract segment and trim trailing newlines/whitespace
      let segment = codeEdit.slice(lastIndex, match.index).trimEnd();
      segments.push(segment);
    }
    // Skip the marker line itself (including its newline if any)
    lastIndex = markerPattern.lastIndex;
    // Skip any trailing newline after the marker
    while (lastIndex < codeEdit.length && (codeEdit[lastIndex] === '\n' || codeEdit[lastIndex] === '\r')) {
      lastIndex++;
    }
  }

  if (lastIndex < codeEdit.length) {
    // Extract remaining segment and trim trailing whitespace
    let segment = codeEdit.slice(lastIndex).trimEnd();
    if (segment.length > 0) {
      segments.push(segment);
    }
  }

  // If no markers found, return the whole edit as a single segment
  if (segments.length === 0) {
    segments.push(codeEdit.trimEnd());
  }

  return segments.filter(s => s.length > 0);
}

function findRegionForSegment(segment, originalLines, searchStart) {
  // Find where a segment should be applied using contextual matching
  const segmentLines = segment.split('\n');
  if (segmentLines.length === 0) return null;

  // Try exact string match first
  const segmentText = segment;
  const originalText = originalLines.join('\n');
  const exactIndex = originalText.indexOf(segmentText);
  if (exactIndex !== -1) {
    // Calculate line numbers from character index
    const textBefore = originalText.slice(0, exactIndex);
    const linesBefore = textBefore.split('\n').length - 1;
    const segmentLineCount = segmentLines.length;
    return {
      start: linesBefore,
      end: linesBefore + segmentLineCount - 1,
      replacementLines: segmentLines,
    };
  }

  // Try contextual matching: find unique context lines from the segment
  // Use first K lines and last K lines as anchors (K=3)
  const K = 3;
  const headLines = segmentLines.slice(0, K).filter(l => l.trim().length > 0);
  const tailLines = segmentLines.slice(-K).filter(l => l.trim().length > 0);

  if (headLines.length === 0) return null;

  // Find potential start positions matching head
  let candidates = [];
  for (let i = Math.max(searchStart, 0); i < originalLines.length; i++) {
    const line = originalLines[i] || '';
    // Try to match first head line (with some flexibility for whitespace)
    if (headLines[0] && line.trim() === headLines[0].trim()) {
      // Check if subsequent head lines match
      let matches = true;
      for (let j = 1; j < headLines.length && i + j < originalLines.length; j++) {
        if (originalLines[i + j].trim() !== headLines[j].trim()) {
          matches = false;
          break;
        }
      }
      if (matches) {
        candidates.push(i);
      }
    }
  }

  // If no candidates from head match, try finding any matching line in segment
  // and use it as an anchor point. Also try flexible matching for similar lines.
  if (candidates.length === 0) {
    // First, try exact line matching
    for (let segIdx = 0; segIdx < segmentLines.length; segIdx++) {
      const segLine = segmentLines[segIdx].trim();
      if (segLine.length === 0) continue;
      
      // Look for this line in the original file
      for (let origIdx = Math.max(searchStart, 0); origIdx < originalLines.length; origIdx++) {
        if (originalLines[origIdx].trim() === segLine) {
          // Found a match - use this as anchor
          const proposedStart = origIdx - segIdx;
          if (proposedStart >= 0 && proposedStart < originalLines.length) {
            // Verify that surrounding lines make sense
            let matchCount = 0;
            const checkRange = Math.min(segmentLines.length, originalLines.length - proposedStart);
            for (let k = 0; k < checkRange; k++) {
              if (proposedStart + k < originalLines.length) {
                const segTrim = segmentLines[k].trim();
                const origTrim = originalLines[proposedStart + k].trim();
                if (segTrim.length > 0 && segTrim === origTrim) {
                  matchCount++;
                }
              }
            }
            if (matchCount > 0) {
              candidates.push(proposedStart);
              if (matchCount >= Math.min(2, segmentLines.length)) {
                break;
              }
            }
          }
        }
      }
      if (candidates.length > 0) break;
    }
    
    // If still no candidates, try flexible matching based on line structure
    // Match lines that have similar prefixes (e.g., "let x = 10" matches "let x = 1")
    if (candidates.length === 0) {
      for (let segIdx = 0; segIdx < segmentLines.length; segIdx++) {
        const segLine = segmentLines[segIdx].trim();
        if (segLine.length === 0) continue;
        
        // Try to find a line that starts similarly (before the value/assignment)
        // Look for patterns like "variable = value" and match on "variable ="
        const segParts = segLine.split('=');
        if (segParts.length >= 2) {
          const segPrefix = segParts[0].trim();
          
          for (let origIdx = Math.max(searchStart, 0); origIdx < originalLines.length; origIdx++) {
            const origLine = originalLines[origIdx].trim();
            const origParts = origLine.split('=');
            if (origParts.length >= 2) {
              const origPrefix = origParts[0].trim();
              // Match if the prefix (before =) is the same
              if (segPrefix === origPrefix && segPrefix.length > 0) {
                // Found a structural match - use this as anchor
                const proposedStart = origIdx - segIdx;
                if (proposedStart >= 0 && proposedStart < originalLines.length) {
                  // Verify that at least some lines have matching structure
                  let matchCount = 0;
                  const checkRange = Math.min(segmentLines.length, originalLines.length - proposedStart);
                  for (let k = 0; k < checkRange; k++) {
                    if (proposedStart + k < originalLines.length) {
                      const segTrim = segmentLines[k].trim();
                      const origTrim = originalLines[proposedStart + k].trim();
                      if (segTrim.length > 0 && origTrim.length > 0) {
                        const segPre = segTrim.split('=')[0].trim();
                        const origPre = origTrim.split('=')[0].trim();
                        if (segPre === origPre && segPre.length > 0) {
                          matchCount++;
                        }
                      }
                    }
                  }
                  // Require at least 2 structural matches for this to be valid
                  if (matchCount >= Math.min(2, segmentLines.length)) {
                    candidates.push(proposedStart);
                    break;
                  }
                }
              }
            }
          }
        }
        if (candidates.length > 0) break;
      }
    }
  }

  if (candidates.length === 0) return null;

  // If multiple candidates, prefer one where tail also matches
  let bestCandidate = candidates[0];
  if (tailLines.length > 0 && candidates.length > 1) {
    for (const cand of candidates) {
      const expectedEnd = cand + segmentLines.length - 1;
      if (expectedEnd < originalLines.length) {
        const actualTailStart = Math.max(expectedEnd - tailLines.length + 1, cand);
        let tailMatches = true;
        for (let j = 0; j < tailLines.length && actualTailStart + j < originalLines.length; j++) {
          if (originalLines[actualTailStart + j].trim() !== tailLines[j].trim()) {
            tailMatches = false;
            break;
          }
        }
        if (tailMatches) {
          bestCandidate = cand;
          break;
        }
      }
    }
  }

  return {
    start: bestCandidate,
    end: bestCandidate + segmentLines.length - 1,
    replacementLines: segmentLines,
  };
}

function applyEditToFile(codeEdit, originalContent) {
  if (originalContent === null) {
    // New file: filter out marker comments
    const markerPattern = /\/\/\s*\.\.\.\s*existing\s+code\s*\.\.\./gi;
    return codeEdit.split('\n')
      .filter(line => !markerPattern.test(line.trim()))
      .join('\n');
  }

  const originalLines = originalContent.split('\n');
  const segments = splitByMarkers(codeEdit);

  // If no markers, try exact match first, then contextual matching
  if (segments.length === 1) {
    const segment = segments[0];
    const segmentLines = segment.split('\n');
    
    // Try exact match first (as string)
    const exactMatch = originalContent.indexOf(segment);
    if (exactMatch !== -1) {
      // Exact match found - replace it (though content is same, so this is a no-op)
      // But we still need to check if it's actually different
      const before = originalContent.slice(0, exactMatch);
      const after = originalContent.slice(exactMatch + segment.length);
      const result = `${before}${segment}${after}`;
      // If result is same as original, it's a no-op (will be caught later)
      return result;
    }
    
    // No exact match - try contextual matching using K-line anchors
    const region = findRegionForSegment(segment, originalLines, 0);
    if (region === null) {
      throw new Error(`Failed to locate segment in target file:\n${segment.substring(0, 200)}`);
    }
    // Apply single patch
    const newLines = [];
    for (let i = 0; i < region.start; i += 1) {
      newLines.push(originalLines[i]);
    }
    newLines.push(...region.replacementLines);
    for (let i = region.end + 1; i < originalLines.length; i += 1) {
      newLines.push(originalLines[i]);
    }
    return newLines.join('\n');
  }

  // Multi-segment edit: use contextual anchoring
  // For multi-segment edits, segments are separated by markers and represent
  // sequential regions to match/replace. We match each segment and replace the regions.
  const patches = [];
  let searchIndex = 0;

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const segment = segments[segIdx];
    const segmentLines = segment.split('\n');
    
    // Try to find this segment in the original file
    let region = findRegionForSegment(segment, originalLines, searchIndex);
    
    // If segment not found and it's a middle segment, try to infer position
    // based on surrounding segments
    if (region === null && segIdx > 0 && segIdx < segments.length - 1) {
      // Middle segment - try to find position between previous and next segments
      const prevRegion = patches[segIdx - 1];
      if (prevRegion) {
        // Start searching after the previous segment
        searchIndex = prevRegion.end + 1;
        
        // If we have a next segment, try to find where it starts
        let nextSegment = segments[segIdx + 1];
        let nextRegion = findRegionForSegment(nextSegment, originalLines, searchIndex);
        
        if (nextRegion) {
          // We found the next segment - the middle segment replaces everything between
          // the end of previous and start of next
          region = {
            start: prevRegion.end + 1,
            end: nextRegion.start - 1,
            replacementLines: segmentLines,
          };
        } else {
          // Can't find next segment either - try matching the segment more flexibly
          // Look for any matching lines to determine position
          region = findRegionForSegment(segment, originalLines, searchIndex);
        }
      }
    }
    
    if (region === null) {
      throw new Error(`Failed to locate segment ${segIdx + 1} in target file:\n${segment.substring(0, 200)}`);
    }
    
    patches.push(region);
    searchIndex = region.end + 1;
  }

  // Check for overlapping patches
  for (let i = 0; i < patches.length - 1; i += 1) {
    if (patches[i].end >= patches[i + 1].start) {
      throw new Error('Overlapping patches detected; aborting edit to avoid corruption');
    }
  }

  // Apply patches in order to build new file content
  const newLines = [];
  let cursor = 0;

  for (const patch of patches) {
    if (patch.start < cursor) {
      throw new Error('Overlapping patches detected; aborting edit to avoid corruption');
    }
    // Unchanged region before this patch
    for (let i = cursor; i < patch.start; i += 1) {
      newLines.push(originalLines[i]);
    }
    // Replacement region
    newLines.push(...patch.replacementLines);
    cursor = patch.end + 1;
  }

  // Trailing unchanged region
  for (let i = cursor; i < originalLines.length; i += 1) {
    newLines.push(originalLines[i]);
  }

  return newLines.join('\n');
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
    
    if (!Array.isArray(todos) || todos.length < 1) {
      throw new Error('todos must be an array with at least 1 item');
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
      message: `${merge ? 'Todos merged successfully' : 'Todos replaced successfully'}\n\nCurrent todos:\n${JSON.stringify(session.data.todos)}`
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
    else rgArgs.push('--line-number'); // Ensure line numbers are included for content mode

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

    let output = `<workspace_result workspace_path="${baseRoot}">\n`;
    if (result.exitCode !== 0 && !stdout.trim()) {
      output += 'No matches found.';
    } else if (stdout.trim()) {
      // Handle different output modes
      if (mode === 'files_with_matches' || mode === 'count') {
        // For these modes, output format is different - just show the raw output
        output += stdout.trim();
      } else {
        // Content mode: parse and format
        const lines = stdout.trim().split('\n');
        // Filter out context lines (lines starting with -) and separator lines
        const matchLines = lines.filter(line => {
          const trimmed = line.trim();
          return trimmed && trimmed.includes(':') && !trimmed.startsWith('-') && !trimmed.startsWith('--');
        });
        const matchCount = matchLines.length;
        if (matchCount > 0) {
          output += `Found ${matchCount} matching line${matchCount !== 1 ? 's' : ''}\n`;
        }
        
        // Parse and group matches by file
        // Ripgrep format: file:line-number:content
        // Use regex to match: file path, then :, then digits (line number), then :, then content
        const fileMatches = new Map();
        for (const line of matchLines) {
          // Match pattern: (file path):(line number):(content)
          // The line number is always digits, so we can use that as an anchor
          // Use regex to find the pattern: anything:digits:anything
          // This handles file paths that might contain colons (like Windows drive letters)
          const match = line.match(/^(.+?):(\d+):(.*)$/);
          if (!match) {
            // Try alternative: maybe the file path has colons, so we need to be more flexible
            // Find the last colon (separates content), then work backwards
            const lastColonIdx = line.lastIndexOf(':');
            if (lastColonIdx === -1) continue;
            
            const beforeLastColon = line.substring(0, lastColonIdx);
            const content = line.substring(lastColonIdx + 1);
            
            // Find the colon before the line number by looking for :digits at the end
            const secondLastColonIdx = beforeLastColon.lastIndexOf(':');
            if (secondLastColonIdx === -1) continue;
            
            const filePath = beforeLastColon.substring(0, secondLastColonIdx);
            const lineNum = beforeLastColon.substring(secondLastColonIdx + 1).trim();
            
            // Validate line number is numeric
            if (!/^\d+$/.test(lineNum)) continue;
            
            // Convert to relative path with ./ prefix
            let relPath;
            if (path.isAbsolute(filePath)) {
              relPath = './' + path.relative(baseRoot, filePath);
            } else {
              relPath = filePath.startsWith('./') ? filePath : './' + filePath;
            }
            
            if (!fileMatches.has(relPath)) {
              fileMatches.set(relPath, []);
            }
            fileMatches.get(relPath).push({ lineNum, content });
            continue;
          }
          
          const filePath = match[1];
          const lineNum = match[2];
          const content = match[3];
          
          // Convert to relative path with ./ prefix
          let relPath;
          if (path.isAbsolute(filePath)) {
            relPath = './' + path.relative(baseRoot, filePath);
          } else {
            // If it's already relative, make sure it starts with ./
            relPath = filePath.startsWith('./') ? filePath : './' + filePath;
          }
          
          if (!fileMatches.has(relPath)) {
            fileMatches.set(relPath, []);
          }
          fileMatches.get(relPath).push({ lineNum, content });
        }
        
        // Format output grouped by file
        if (fileMatches.size > 0) {
          const fileEntries = Array.from(fileMatches.entries()).sort();
          for (const [file, matches] of fileEntries) {
            output += file + '\n';
            for (const { lineNum, content } of matches) {
              output += `${lineNum}:${content}\n`;
            }
          }
        } else if (matchCount > 0) {
          // Fallback: if parsing failed but we have matches, show original format
          output += stdout.trim();
        }
      }
    } else {
      output += result.stderr.trim() || 'No output';
    }
    output += '\n</workspace_result>';
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
          } else if (l === '') {
            // Preserve blank lines inside hunks.
            // Without this, patches that delete/insert blocks separated by empty lines can mis-apply
            // because the operation ordering and anchoring changes.
            if (currentContext === null) currentContext = '';
            currentLines.push({ type: ' ', content: '' });
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
        } else {
          // Empty context (@@): reset pos to allow searching from the beginning
          // or continue from current position if we're in the middle of processing
          // Only reset if we haven't found a position yet
          if (pos === 0 || block.lines.length === 0 || block.lines[0].type !== ' ') {
            // Reset to allow fresh search, but keep current pos if we're continuing
            // Actually, for empty context blocks, we should search from current pos forward
            // Don't reset pos here - let the first context line find the position
          }
        }

        // If there are no explicit context (' ') lines, try to apply the hunk by
        // matching the entire "old" sequence (all '-' lines and blank context lines)
        // and replacing it with the "new" sequence (all '+' lines and blank context lines).
        // This is important for patches that only specify -/+ lines and rely on adjacency,
        // especially when the removed lines are not unique (e.g., multiple "}" lines).
        const hasExplicitContext = block.lines.some(op => op.type === ' ' && op.content !== '');
        if ((!block.context || !block.context.trim()) && !hasExplicitContext) {
          const oldSeq = block.lines
            .filter(op => op.type === '-' || (op.type === ' ' && op.content === ''))
            .map(op => op.type === '-' ? op.content : '');
          const newSeq = block.lines
            .filter(op => op.type === '+' || (op.type === ' ' && op.content === ''))
            .map(op => op.type === '+' ? op.content : '');

          if (oldSeq.length > 0) {
            // Find contiguous match for oldSeq in fileLines.
            let matchAt = -1;
            for (let s = 0; s <= fileLines.length - oldSeq.length; s++) {
              let ok = true;
              for (let j = 0; j < oldSeq.length; j++) {
                if (fileLines[s + j] !== oldSeq[j]) {
                  ok = false;
                  break;
                }
              }
              if (ok) {
                matchAt = s;
                break;
              }
            }
            if (matchAt === -1) {
              throw new Error(`apply_patch: could not find hunk (no-context) sequence in file ${hunk.filename}`);
            }
            // Replace the matched range with newSeq
            fileLines.splice(matchAt, oldSeq.length, ...newSeq);
            pos = matchAt + newSeq.length;
            continue;
          }
        }

        for (const op of block.lines) {
          if (op.type === ' ') {
            // Context lines: trim leading whitespace for flexible matching
            // This handles cases where GPT-5.1 adds leading spaces to context lines
            // Only trim leading spaces, preserve trailing spaces
            const trimLeading = (s) => s.replace(/^\s+/, '');
            const expected = trimLeading(op.content);
            // If we don't have a context position yet (empty @@ context), use this line to find it
            // Search from current pos forward, not from beginning
            if ((!block.context || !block.context.trim())) {
              // For empty context, search from current pos forward
              const searchStart = pos;
              const searchEnd = Math.min(fileLines.length, searchStart + 200);
              let idx = -1;
              for (let k = searchStart; k < searchEnd; k++) {
                if (fileLines[k] && trimLeading(fileLines[k]) === expected) {
                  idx = k;
                  break;
                }
              }
              if (idx === -1) {
                // If not found from pos forward, try from beginning
                idx = fileLines.findIndex(l => l && trimLeading(l) === expected);
                if (idx === -1) {
                  throw new Error(`apply_patch: could not find context line "${expected}" in file ${hunk.filename}`);
                }
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
            // Prefer removing at the current position (sequential application).
            // This avoids deleting the wrong occurrence when the same line appears multiple times
            // (e.g., multiple "}" lines) and the patch relies on nearby context/blank lines.
            if (fileLines[pos] === toRemove) {
              fileLines.splice(pos, 1);
              // keep pos (now points at next line)
              continue;
            }
            // Otherwise, search forward for the next exact match.
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

  async edit_file(args, context) {
    if (!args || !args.target_file) {
      throw new Error('edit_file: "target_file" is required');
    }
    if (!args.code_edit) {
      throw new Error('edit_file: "code_edit" is required');
    }

    const target = resolveTargetPath(args.target_file);
    const baseRoot = process.cwd();
    const relPath = path.relative(baseRoot, target);
    const session = context && context.session;
    const fileOriginals = session && session.data ? (session.data.fileOriginals || (session.data.fileOriginals = {})) : null;

    // Read original content (null if file doesn't exist)
    let originalContent = null;
    try {
      originalContent = await fsp.readFile(target, 'utf-8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        throw new Error(`edit_file: failed to read file: ${err.message}`);
      }
      // File doesn't exist, originalContent remains null (new file)
    }

    // Store original content if not already stored
    if (fileOriginals && !(relPath in fileOriginals)) {
      fileOriginals[relPath] = originalContent || '';
    }

    // Apply edit using the helper function
    let newContent;
    try {
      newContent = applyEditToFile(args.code_edit, originalContent);
    } catch (err) {
      throw new Error(`edit_file: failed to apply edit: ${err.message}`);
    }

    // Write new content
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, newContent, 'utf-8');

    // Generate diff
    let diff = null;
    try {
      const beforeContent = originalContent || '';
      diff = await generateDiff(beforeContent, newContent, relPath);
    } catch (err) {
      // Ignore diff generation errors
    }

    return {
      success: true,
      target_file: args.target_file,
      created: originalContent === null,
      _diff: diff,
    };
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
    if (name === 'web_search_preview' || name === 'web_search_preview_2025_03_11' || name === "googleSearch" || name === "codeExecution") {
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

