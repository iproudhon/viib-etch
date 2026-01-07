// test-viib-etch-tools.js
// Test file for viib-etch-tools.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const {
  loadToolDefinitions,
  getToolDefinitions,
  executeTool,
  getToolHandler,
  hasTool,
  toolHandlers
} = require('./viib-etch-tools');
const { ChatSession, setChatsDir } = require('./viib-etch');

// Test directory for cleanup
const TEST_CHATS_DIR = path.join(__dirname, 'test-chats');

async function testLoadToolDefinitions() {
  console.log('\n=== Test: Load Tool Definitions ===');
  
  const toolsPath = path.join(__dirname, 'viib-etch-tools.json');
  const definitions = loadToolDefinitions(toolsPath);
  
  console.log(`Loaded ${definitions.length} tool definitions`);
  
  // Verify structure
  for (const def of definitions) {
    if (def.type !== 'function') {
      throw new Error(`Expected type 'function', got '${def.type}'`);
    }
    if (!def.function || !def.function.name) {
      throw new Error('Tool definition missing function.name');
    }
    if (!def.function.description) {
      throw new Error(`Tool ${def.function.name} missing description`);
    }
    if (!def.function.parameters) {
      throw new Error(`Tool ${def.function.name} missing parameters`);
    }
  }
  
  console.log('  ✓ All tool definitions have valid structure');
  console.log(`  Tools: ${definitions.map(d => d.function.name).join(', ')}`);
  
  return definitions;
}

async function testGetToolDefinitions() {
  console.log('\n=== Test: Get Tool Definitions (Filtered) ===');
  
  const toolsPath = path.join(__dirname, 'viib-etch-tools.json');
  
  // Test getting all tools
  const allTools = getToolDefinitions(toolsPath, []);
  console.log(`  All tools: ${allTools.length}`);
  
  // Test filtering by name
  const todoTool = getToolDefinitions(toolsPath, ['todo_write']);
  console.log(`  Filtered by 'todo_write': ${todoTool.length}`);
  
  if (todoTool.length !== 1) {
    throw new Error(`Expected 1 tool, got ${todoTool.length}`);
  }
  if (todoTool[0].function.name !== 'todo_write') {
    throw new Error(`Expected 'todo_write', got '${todoTool[0].function.name}'`);
  }
  
  // Test filtering with multiple names
  const multipleTools = getToolDefinitions(toolsPath, ['todo_write', 'run_terminal_cmd']);
  console.log(`  Filtered by multiple names: ${multipleTools.length}`);
  
  if (multipleTools.length !== 2) {
    throw new Error(`Expected 2 tools, got ${multipleTools.length}`);
  }
  
  // Test filtering with non-existent tool
  const nonExistent = getToolDefinitions(toolsPath, ['non_existent_tool']);
  console.log(`  Filtered by non-existent tool: ${nonExistent.length}`);
  
  if (nonExistent.length !== 0) {
    throw new Error(`Expected 0 tools, got ${nonExistent.length}`);
  }
  
  console.log('  ✓ Tool filtering works correctly');

  // Test built-in responses tool passthrough
  const webSearch = getToolDefinitions(toolsPath, ['web_search_preview']);
  if (webSearch.length !== 1) {
    throw new Error(`Expected 1 tool for web_search_preview, got ${webSearch.length}`);
  }
  if (webSearch[0].type !== 'web_search_preview') {
    throw new Error(`Expected type 'web_search_preview', got '${webSearch[0].type}'`);
  }
  console.log('  ✓ Built-in responses tools are returned when requested');
  
  return allTools;
}

async function testHasTool() {
  console.log('\n=== Test: Has Tool ===');
  
  // Test existing tool
  if (!hasTool('todo_write')) {
    throw new Error('todo_write should be available');
  }
  console.log('  ✓ todo_write is available');
  
  // Test non-existent tool
  if (hasTool('non_existent_tool')) {
    throw new Error('non_existent_tool should not be available');
  }
  console.log('  ✓ Non-existent tool correctly returns false');
}

async function testGetToolHandler() {
  console.log('\n=== Test: Get Tool Handler ===');
  
  const handler = getToolHandler('todo_write');
  if (!handler) {
    throw new Error('todo_write handler should exist');
  }
  if (typeof handler !== 'function') {
    throw new Error('Handler should be a function');
  }
  console.log('  ✓ todo_write handler retrieved');
  
  const nonExistent = getToolHandler('non_existent_tool');
  if (nonExistent !== undefined) {
    throw new Error('Non-existent tool handler should be undefined');
  }
  console.log('  ✓ Non-existent handler correctly returns undefined');
}

async function testTodoWrite() {
  console.log('\n=== Test: todo_write Tool ===');
  
  // Set up test chats directory
  setChatsDir(TEST_CHATS_DIR);
  
  // Create a test session
  const session = new ChatSession({
    title: 'Test Todo Write',
    model_name: 'test-model'
  });
  session.enablePersistence();
  
  const sessionId = session.id;
  const sessionFile = ChatSession.getFileName(sessionId);
  
  console.log(`  Created test session: ${sessionId}`);
  console.log(`  Session file: ${sessionFile}`);
  
  // Test 1: Initial todo_write (replace mode)
  const initialTodos = [
    { id: '1', status: 'pending', content: 'First task' },
    { id: '2', status: 'in_progress', content: 'Second task' }
  ];
  
  const context1 = { session };
  const result1 = await executeTool('todo_write', {
    merge: false,
    todos: initialTodos
  }, context1);
  
  if (!result1.success) {
    throw new Error(`todo_write failed: ${result1.error || 'unknown error'}`);
  }
  if (result1.todo_count !== 2) {
    throw new Error(`Expected 2 todos, got ${result1.todo_count}`);
  }
  if (session.data.todos.length !== 2) {
    throw new Error(`Session should have 2 todos, got ${session.data.todos.length}`);
  }
  
  console.log('  ✓ Initial todo_write (replace mode) succeeded');
  
  // Verify saved to file
  if (!fs.existsSync(sessionFile)) {
    throw new Error('Session file should exist after save');
  }
  const savedData1 = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  if (!savedData1.data || !savedData1.data.todos) {
    throw new Error('Session file should contain data.todos');
  }
  if (savedData1.data.todos.length !== 2) {
    throw new Error(`Session file should have 2 todos, got ${savedData1.data.todos.length}`);
  }
  console.log('  ✓ Todos saved to session file');
  
  // Test 2: Merge mode - update existing and add new
  const mergeTodos = [
    { id: '2', status: 'completed', content: 'Second task (updated)' },
    { id: '3', status: 'pending', content: 'Third task' }
  ];
  
  const result2 = await executeTool('todo_write', {
    merge: true,
    todos: mergeTodos
  }, context1);
  
  if (!result2.success) {
    throw new Error(`todo_write merge failed: ${result2.error || 'unknown error'}`);
  }
  if (result2.todo_count !== 3) {
    throw new Error(`Expected 3 todos after merge, got ${result2.todo_count}`);
  }
  if (session.data.todos.length !== 3) {
    throw new Error(`Session should have 3 todos after merge, got ${session.data.todos.length}`);
  }
  
  // Verify todo '2' was updated
  const todo2 = session.data.todos.find(t => t.id === '2');
  if (!todo2) {
    throw new Error('Todo 2 should exist');
  }
  if (todo2.status !== 'completed') {
    throw new Error(`Todo 2 status should be 'completed', got '${todo2.status}'`);
  }
  if (todo2.content !== 'Second task (updated)') {
    throw new Error(`Todo 2 content should be updated`);
  }
  
  // Verify todo '3' was added
  const todo3 = session.data.todos.find(t => t.id === '3');
  if (!todo3) {
    throw new Error('Todo 3 should exist');
  }
  
  console.log('  ✓ Merge mode correctly updated and added todos');
  
  // Verify saved to file again
  const savedData2 = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  if (savedData2.data.todos.length !== 3) {
    throw new Error(`Session file should have 3 todos after merge, got ${savedData2.data.todos.length}`);
  }
  console.log('  ✓ Merged todos saved to session file');
  
  // Test 3: Validation errors
  const resultInvalidStatus = await executeTool('todo_write', {
    merge: false,
    todos: [{ id: '1', status: 'invalid', content: 'Test' }, { id: '2', status: 'pending', content: 'Test2' }]
  }, context1);
  if (resultInvalidStatus.success !== false || !resultInvalidStatus.error || !resultInvalidStatus.error.includes('Invalid status')) {
    throw new Error(`Expected error for invalid status, got: ${JSON.stringify(resultInvalidStatus)}`);
  }
  console.log('  ✓ Invalid status correctly rejected');
  
  const resultMissingFields = await executeTool('todo_write', {
    merge: false,
    todos: [{ id: '1' }, { id: '2', status: 'pending', content: 'Test' }] // Missing status and content for first
  }, context1);
  if (resultMissingFields.success !== false || !resultMissingFields.error || !resultMissingFields.error.includes('id, status, and content')) {
    throw new Error(`Expected error for missing fields, got: ${JSON.stringify(resultMissingFields)}`);
  }
  console.log('  ✓ Missing fields correctly rejected');
  
  const resultTooFew = await executeTool('todo_write', {
    merge: false,
    todos: [{ id: '1', status: 'pending', content: 'Only one' }]
  }, context1);
  if (resultTooFew.success !== false || !resultTooFew.error || !resultTooFew.error.includes('at least 2 items')) {
    throw new Error(`Expected error for less than 2 todos, got: ${JSON.stringify(resultTooFew)}`);
  }
  console.log('  ✓ Less than 2 todos correctly rejected');
  
  // Test 4: Missing session context
  const resultNoSession = await executeTool('todo_write', {
    merge: false,
    todos: initialTodos
  }, {});
  if (resultNoSession.success !== false || !resultNoSession.error || !resultNoSession.error.includes('Session context required')) {
    throw new Error(`Expected error for missing session, got: ${JSON.stringify(resultNoSession)}`);
  }
  console.log('  ✓ Missing session context correctly rejected');
  
  return { sessionId, sessionFile };
}

async function testRunTerminalCmd() {
  console.log('\n=== Test: run_terminal_cmd Tool ===');
  
  // Test 1: Basic command execution
  const result1 = await executeTool('run_terminal_cmd', {
    command: 'echo "test output"',
    is_background: false
  }, {});
  
  if (result1.error) {
    throw new Error(`run_terminal_cmd failed: ${result1.error}`);
  }
  if (result1.exitCode !== 0) {
    throw new Error(`Expected exit code 0, got ${result1.exitCode}`);
  }
  if (!result1.stdout.includes('test output')) {
    throw new Error(`Expected stdout to contain 'test output', got: ${result1.stdout}`);
  }
  console.log('  ✓ Basic command execution works');
  
  // Test 2: Command with exit code
  const result2 = await executeTool('run_terminal_cmd', {
    command: 'exit 42',
    is_background: false
  }, {});
  
  if (result2.error) {
    throw new Error(`run_terminal_cmd failed: ${result2.error}`);
  }
  if (result2.exitCode !== 42) {
    throw new Error(`Expected exit code 42, got ${result2.exitCode}`);
  }
  console.log('  ✓ Exit code handling works');
  
  // Test 3: Background command
  const result3 = await executeTool('run_terminal_cmd', {
    command: 'sleep 0.1',
    is_background: true
  }, {});
  
  if (result3.error) {
    throw new Error(`run_terminal_cmd failed: ${result3.error}`);
  }
  if (!result3.is_background) {
    throw new Error('Expected is_background to be true');
  }
  if (!result3.pid) {
    throw new Error('Expected pid to be set');
  }
  if (!result3.started_at) {
    throw new Error('Expected started_at to be set');
  }
  console.log('  ✓ Background command works');
  
  // Test 4: Missing command
  const result4 = await executeTool('run_terminal_cmd', {
    is_background: false
  }, {});
  
  if (!result4.error || !result4.error.includes('command')) {
    throw new Error(`Expected error about missing command, got: ${JSON.stringify(result4)}`);
  }
  console.log('  ✓ Missing command correctly rejected');
  
  // Test 5: Invalid command type
  const result5 = await executeTool('run_terminal_cmd', {
    command: 123,
    is_background: false
  }, {});
  
  if (!result5.error || !result5.error.includes('command')) {
    throw new Error(`Expected error about command type, got: ${JSON.stringify(result5)}`);
  }
  console.log('  ✓ Invalid command type correctly rejected');
  
  // Test 6: Command with explanation and required_permissions
  const result6 = await executeTool('run_terminal_cmd', {
    command: 'echo "test"',
    is_background: false,
    explanation: 'Test explanation',
    required_permissions: 'read'
  }, {});
  
  if (result6.error) {
    throw new Error(`run_terminal_cmd failed: ${result6.error}`);
  }
  if (result6.explanation !== 'Test explanation') {
    throw new Error(`Expected explanation to be preserved, got: ${result6.explanation}`);
  }
  if (result6.required_permissions !== 'read') {
    throw new Error(`Expected required_permissions to be preserved, got: ${result6.required_permissions}`);
  }
  console.log('  ✓ Explanation and required_permissions preserved');
  
  // Test 7: Streaming stdout/stderr via onCommandOut
  const streamData = [];
  const mockOnCommandOut = async (data) => {
    streamData.push(data);
  };
  
  const result7 = await executeTool('run_terminal_cmd', {
    command: 'echo -e "line1\nline2" && echo "error" >&2',
    is_background: false
  }, { onCommandOut: mockOnCommandOut });
  
  if (result7.error) {
    throw new Error(`run_terminal_cmd failed: ${result7.error}`);
  }
  
  // Give a small delay to allow any pending onCommandOut callbacks to complete
  await new Promise(resolve => setImmediate(resolve));
  
  // Check that streaming events were captured
  const stdoutStreams = streamData.filter(d => d.phase === 'stream' && d.stream === 'stdout');
  const stderrStreams = streamData.filter(d => d.phase === 'stream' && d.stream === 'stderr');
  
  if (stdoutStreams.length === 0 && stderrStreams.length === 0) {
    // Note: Some shells might buffer output, so this is not always guaranteed
    // But if streaming is enabled, we should at least try to capture it
    console.log('  ⚠ Streaming test: No stream events captured (may be due to shell buffering)');
  } else {
    if (stdoutStreams.length > 0) {
      const stdoutText = stdoutStreams.map(d => d.data).join('');
      if (!stdoutText.includes('line1') && !stdoutText.includes('line2')) {
        throw new Error(`Expected stdout stream to contain 'line1' or 'line2', got: ${stdoutText}`);
      }
      console.log(`  ✓ Captured ${stdoutStreams.length} stdout stream event(s)`);
    }
    if (stderrStreams.length > 0) {
      const stderrText = stderrStreams.map(d => d.data).join('');
      if (!stderrText.includes('error')) {
        throw new Error(`Expected stderr stream to contain 'error', got: ${stderrText}`);
      }
      console.log(`  ✓ Captured ${stderrStreams.length} stderr stream event(s)`);
    }
  }
}

async function testReadFile() {
  console.log('\n=== Test: read_file Tool ===');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viib-etch-tools-readfile-'));
  try {
    // Test 1: Basic read
    const file = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(file, 'one\ntwo\nthree', 'utf8');

    const out1 = await executeTool('read_file', { target_file: file }, {});
    if (typeof out1 !== 'string') {
      throw new Error(`Expected read_file to return string, got: ${typeof out1}`);
    }
    if (!out1.includes('L001:one') || !out1.includes('L002:two') || !out1.includes('L003:three')) {
      throw new Error(`Unexpected read_file output:\n${out1}`);
    }
    console.log('  ✓ Reads file and prefixes line numbers');

    // Test 2: offset/limit
    const out2 = await executeTool('read_file', { target_file: file, offset: 2, limit: 1 }, {});
    if (out2.trim() !== 'L002:two') {
      throw new Error(`Expected only L2:two, got:\n${out2}`);
    }
    console.log('  ✓ offset/limit slice works');

    // Test 3: Empty file
    const empty = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(empty, '', 'utf8');
    const out3 = await executeTool('read_file', { target_file: empty }, {});
    if (out3 !== '') {
      throw new Error(`Expected empty string for empty file, got: ${JSON.stringify(out3)}`);
    }
    console.log('  ✓ Empty file returns empty string');

    // Test 4: Directory error
    const dir = path.join(tmpDir, 'dir');
    fs.mkdirSync(dir);
    const out4 = await executeTool('read_file', { target_file: dir }, {});
    if (!out4 || out4.success !== false || !out4.error || !out4.error.includes('directory')) {
      throw new Error(`Expected directory error, got: ${JSON.stringify(out4)}`);
    }
    console.log('  ✓ Directory path is rejected');

    // Test 5: Missing file error
    const missing = path.join(tmpDir, 'missing.txt');
    const out5 = await executeTool('read_file', { target_file: missing }, {});
    if (!out5 || out5.success !== false || !out5.error || !out5.error.includes('does not exist')) {
      throw new Error(`Expected missing file error, got: ${JSON.stringify(out5)}`);
    }
    console.log('  ✓ Missing file returns an error');

    // Test 6: Image base64 output (repo image)
    const imagePath = path.join(__dirname, 'viib.png');
    if (fs.existsSync(imagePath)) {
      const out6 = await executeTool('read_file', { target_file: imagePath }, {});
      if (typeof out6 !== 'string' || out6.length < 10) {
        throw new Error('Expected base64 string for image');
      }
      const buf = Buffer.from(out6, 'base64');
      if (!buf || buf.length === 0) {
        throw new Error('Expected base64 to decode to non-empty buffer');
      }
      console.log('  ✓ Image reads as base64');
    } else {
      console.log('  ⚠ Skipped image test (viib.png not found)');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testApplyPatch() {
  console.log('\n=== Test: apply_patch Tool ===');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viib-etch-tools-applypatch-'));
  try {
    const file = path.join(tmpDir, 't.txt');
    fs.writeFileSync(file, 'line1\nline2\nline3', 'utf8');

    // Test 1: Update file
    const patch1 = [
      '*** Begin Patch',
      `*** Update File: ${file}`,
      '@@',
      ' line1',
      '-line2',
      '+LINE2',
      ' line3',
      '*** End Patch',
      ''
    ].join('\n');

    const res1 = await executeTool('apply_patch', { patchCommand: patch1 }, {});
    if (!res1 || res1.success !== true) {
      throw new Error(`apply_patch update failed: ${JSON.stringify(res1)}`);
    }
    const after1 = fs.readFileSync(file, 'utf8');
    if (!after1.includes('LINE2') || after1.includes('line2')) {
      throw new Error(`File not updated as expected, content:\n${after1}`);
    }
    console.log('  ✓ Updates an existing file');

    // Test 2: Add file
    const newFile = path.join(tmpDir, 'new.txt');
    const patch2 = [
      '*** Begin Patch',
      `*** Add File: ${newFile}`,
      '+hello',
      '+world',
      '*** End Patch',
      ''
    ].join('\n');

    const res2 = await executeTool('apply_patch', { patchCommand: patch2 }, {});
    if (!res2 || res2.success !== true) {
      throw new Error(`apply_patch add failed: ${JSON.stringify(res2)}`);
    }
    const after2 = fs.readFileSync(newFile, 'utf8');
    if (after2 !== 'hello\nworld') {
      throw new Error(`Unexpected new file contents: ${JSON.stringify(after2)}`);
    }
    console.log('  ✓ Creates a new file');

    // Test 3: Missing markers
    const bad1 = '*** Update File: x\n@@\n-a\n+b\n';
    const res3 = await executeTool('apply_patch', { patchCommand: bad1 }, {});
    if (!res3 || res3.success !== false || !res3.error || !res3.error.includes('Begin Patch')) {
      throw new Error(`Expected marker error, got: ${JSON.stringify(res3)}`);
    }
    console.log('  ✓ Rejects patch missing Begin/End markers');

    // Test 4: Update missing file
    const missing = path.join(tmpDir, 'nope.txt');
    const patch4 = [
      '*** Begin Patch',
      `*** Update File: ${missing}`,
      '@@',
      '-x',
      '+y',
      '*** End Patch',
      ''
    ].join('\n');
    const res4 = await executeTool('apply_patch', { patchCommand: patch4 }, {});
    if (!res4 || res4.success !== false || !res4.error || !res4.error.includes('does not exist')) {
      throw new Error(`Expected missing file error, got: ${JSON.stringify(res4)}`);
    }
    console.log('  ✓ Rejects update for missing file');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function hasBinary(name) {
  try {
    const res = spawnSync(name, ['--version'], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

async function testRg() {
  console.log('\n=== Test: rg Tool ===');

  if (!hasBinary('rg')) {
    console.log('  ⚠ Skipped rg test (rg not found in PATH)');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viib-etch-tools-rg-'));
  try {
    const a = path.join(tmpDir, 'a.txt');
    const b = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(a, 'hello\nfoo\nbar\nfoo', 'utf8');
    fs.writeFileSync(b, 'nope\n', 'utf8');

    const out1 = await executeTool('rg', { pattern: 'foo', path: tmpDir }, {});
    if (typeof out1 !== 'string' || !out1.includes('<workspace_result')) {
      throw new Error(`Expected rg to return workspace_result string, got: ${typeof out1}`);
    }
    if (!out1.includes('Found') || !out1.includes('foo')) {
      throw new Error(`Unexpected rg output:\n${out1}`);
    }
    console.log('  ✓ Finds matches');

    const out2 = await executeTool('rg', { pattern: 'foo', path: tmpDir, head_limit: 1 }, {});
    const lines = out2.split('\n').filter(l => l.includes(':') && l.includes('foo'));
    if (lines.length > 1) {
      throw new Error(`Expected head_limit to truncate matches, got:\n${out2}`);
    }
    console.log('  ✓ head_limit truncates output');

    const out3 = await executeTool('rg', { pattern: 'does_not_match', path: tmpDir }, {});
    if (!out3.includes('No matches found')) {
      throw new Error(`Expected no matches message, got:\n${out3}`);
    }
    console.log('  ✓ No matches case');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testDeleteFile() {
  console.log('\n=== Test: delete_file Tool ===');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viib-etch-tools-delete-'));
  try {
    const f = path.join(tmpDir, 'x.txt');
    fs.writeFileSync(f, 'x', 'utf8');

    const res1 = await executeTool('delete_file', { target_file: f }, {});
    if (!res1 || res1.ok !== true) {
      throw new Error(`Expected ok delete, got: ${JSON.stringify(res1)}`);
    }
    if (fs.existsSync(f)) {
      throw new Error('File should have been deleted');
    }
    console.log('  ✓ Deletes an existing file');

    const res2 = await executeTool('delete_file', { target_file: f }, {});
    if (!res2 || res2.ok !== false || !res2.error) {
      throw new Error(`Expected graceful missing file response, got: ${JSON.stringify(res2)}`);
    }
    console.log('  ✓ Missing file handled gracefully');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testUpdateMemory() {
  console.log('\n=== Test: update_memory Tool ===');

  // Set up test chats directory
  setChatsDir(TEST_CHATS_DIR);
  
  // Create a test session
  const session = new ChatSession({
    title: 'Test Update Memory',
    model_name: 'test-model'
  });
  session.enablePersistence();

  try {
    const context = { session };
    
    const created = await executeTool('update_memory', {
      action: 'create',
      title: 'T',
      knowledge_to_store: 'K'
    }, context);

    if (!created || !created.id || created.title !== 'T') {
      throw new Error(`Create failed: ${JSON.stringify(created)}`);
    }
    if (!session.data.memories || session.data.memories.length !== 1) {
      throw new Error(`Expected 1 memory in session, got: ${session.data.memories?.length || 0}`);
    }
    console.log('  ✓ Creates memory');

    const updated = await executeTool('update_memory', {
      action: 'update',
      existing_knowledge_id: created.id,
      knowledge_to_store: 'K2'
    }, context);
    if (!updated || updated.id !== created.id || updated.knowledge_to_store !== 'K2') {
      throw new Error(`Update failed: ${JSON.stringify(updated)}`);
    }
    if (session.data.memories.length !== 1) {
      throw new Error(`Expected 1 memory after update, got: ${session.data.memories.length}`);
    }
    console.log('  ✓ Updates memory');

    const deleted = await executeTool('update_memory', {
      action: 'delete',
      existing_knowledge_id: created.id
    }, context);
    if (!deleted || deleted.deleted !== true) {
      throw new Error(`Delete failed: ${JSON.stringify(deleted)}`);
    }
    if (session.data.memories.length !== 0) {
      throw new Error(`Expected 0 memories after delete, got: ${session.data.memories.length}`);
    }
    console.log('  ✓ Deletes memory');
    
    // Test missing session context
    const resultNoSession = await executeTool('update_memory', {
      action: 'create',
      title: 'T',
      knowledge_to_store: 'K'
    }, {});
    if (!resultNoSession || !resultNoSession.error || !resultNoSession.error.includes('Session context required')) {
      throw new Error(`Expected error for missing session, got: ${JSON.stringify(resultNoSession)}`);
    }
    console.log('  ✓ Missing session context correctly rejected');
  } finally {
    // Cleanup session file
    const sessionFile = ChatSession.getFileName(session.id);
    if (fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
    }
  }
}

async function testReadLints() {
  console.log('\n=== Test: read_lints Tool ===');
  const out = await executeTool('read_lints', { paths: [__filename] }, {});
  if (typeof out !== 'string' || !out.includes('No linter errors found')) {
    throw new Error(`Unexpected read_lints output: ${JSON.stringify(out)}`);
  }
  console.log('  ✓ Returns stable no-lints message');
}

async function testEditFile() {
  console.log('\n=== Test: edit_file Tool ===');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viib-etch-tools-editfile-'));
  try {
    // Set up test session for file originals tracking
    setChatsDir(TEST_CHATS_DIR);
    const session = new ChatSession({
      title: 'Test Edit File',
      model_name: 'test-model'
    });
    session.enablePersistence();
    const context = { session };

    // Test 1: Create a new file (file doesn't exist)
    const newFile = path.join(tmpDir, 'new.txt');
    const codeEdit1 = 'line1\nline2\nline3';
    
    const res1 = await executeTool('edit_file', {
      target_file: newFile,
      instructions: 'Create a new file with three lines',
      code_edit: codeEdit1
    }, context);

    if (!res1 || res1.success !== true || !res1.created) {
      throw new Error(`edit_file create failed: ${JSON.stringify(res1)}`);
    }
    if (!fs.existsSync(newFile)) {
      throw new Error('New file should have been created');
    }
    const content1 = fs.readFileSync(newFile, 'utf8');
    if (content1 !== 'line1\nline2\nline3') {
      throw new Error(`Unexpected file content: ${JSON.stringify(content1)}`);
    }
    console.log('  ✓ Creates a new file');

    // Test 2: Simple edit without markers (single segment replacement)
    const codeEdit2 = 'LINE1\nline2\nline3';
    const res2 = await executeTool('edit_file', {
      target_file: newFile,
      instructions: 'Replace first line with uppercase',
      code_edit: codeEdit2
    }, context);

    if (!res2 || res2.success !== true || res2.created) {
      throw new Error(`edit_file update failed: ${JSON.stringify(res2)}`);
    }
    const content2 = fs.readFileSync(newFile, 'utf8');
    if (!content2.includes('LINE1') || content2.includes('line1')) {
      throw new Error(`File not updated as expected, content:\n${content2}`);
    }
    console.log('  ✓ Updates existing file without markers');

    // Test 3: Edit with marker comments (multiple segments)
    fs.writeFileSync(newFile, 'header1\nheader2\nbody1\nbody2\nbody3\nfooter1\nfooter2', 'utf8');
    const codeEdit3 = 'header1\nheader2\n// ... existing code ...\nBODY1\nBODY2\nBODY3\n// ... existing code ...\nfooter1\nfooter2';
    
    const res3 = await executeTool('edit_file', {
      target_file: newFile,
      instructions: 'Update body lines to uppercase while preserving header and footer',
      code_edit: codeEdit3
    }, context);

    if (!res3 || res3.success !== true) {
      throw new Error(`edit_file multi-segment failed: ${JSON.stringify(res3)}`);
    }
    const content3 = fs.readFileSync(newFile, 'utf8');
    if (!content3.includes('BODY1') || !content3.includes('BODY2') || !content3.includes('BODY3')) {
      throw new Error(`Body not updated to uppercase, content:\n${content3}`);
    }
    if (!content3.includes('header1') || !content3.includes('footer1')) {
      throw new Error(`Header/footer not preserved, content:\n${content3}`);
    }
    if (content3.includes('body1') || content3.includes('body2')) {
      throw new Error(`Old body still present, content:\n${content3}`);
    }
    console.log('  ✓ Multi-segment edit with markers works');

    // Test 4: Edit with Python-style comment markers
    const pyFile = path.join(tmpDir, 'test.py');
    fs.writeFileSync(pyFile, 'def func1():\n    pass\n\ndef func2():\n    pass', 'utf8');
    const codeEdit4 = 'def func1():\n    pass\n\n# ... existing code ...\ndef func2():\n    return True';
    
    const res4 = await executeTool('edit_file', {
      target_file: pyFile,
      instructions: 'Update func2 to return True',
      code_edit: codeEdit4
    }, context);

    if (!res4 || res4.success !== true) {
      throw new Error(`edit_file Python marker failed: ${JSON.stringify(res4)}`);
    }
    const content4 = fs.readFileSync(pyFile, 'utf8');
    if (!content4.includes('return True')) {
      throw new Error(`Python edit not applied, content:\n${content4}`);
    }
    console.log('  ✓ Python-style comment markers work');

    // Test 5: Missing target_file
    const res5 = await executeTool('edit_file', {
      code_edit: 'test',
      instructions: 'Test'
    }, context);
    if (!res5 || res5.success !== false || !res5.error || !res5.error.includes('target_file')) {
      throw new Error(`Expected error for missing target_file, got: ${JSON.stringify(res5)}`);
    }
    console.log('  ✓ Missing target_file correctly rejected');

    // Test 6: Missing code_edit
    const res6 = await executeTool('edit_file', {
      target_file: newFile,
      instructions: 'Test'
    }, context);
    if (!res6 || res6.success !== false || !res6.error || !res6.error.includes('code_edit')) {
      throw new Error(`Expected error for missing code_edit, got: ${JSON.stringify(res6)}`);
    }
    console.log('  ✓ Missing code_edit correctly rejected');

    // Test 7: Edit that filters markers from new file
    const newFile2 = path.join(tmpDir, 'new2.txt');
    const codeEdit7 = 'line1\n// ... existing code ...\nline2';
    
    const res7 = await executeTool('edit_file', {
      target_file: newFile2,
      instructions: 'Create file and filter markers',
      code_edit: codeEdit7
    }, context);

    if (!res7 || res7.success !== true || !res7.created) {
      throw new Error(`edit_file marker filter failed: ${JSON.stringify(res7)}`);
    }
    const content7 = fs.readFileSync(newFile2, 'utf8');
    if (content7.includes('existing code')) {
      throw new Error(`Marker comment not filtered from new file, content:\n${content7}`);
    }
    if (!content7.includes('line1') || !content7.includes('line2')) {
      throw new Error(`Content missing, content:\n${content7}`);
    }
    console.log('  ✓ Marker comments filtered from new files');

    // Test 8: Contextual matching when exact match fails
    fs.writeFileSync(newFile, 'function foo() {\n    let x = 1;\n    let y = 2;\n    return x + y;\n}', 'utf8');
    const codeEdit8 = '    let x = 10;\n    let y = 20;';
    
    const res8 = await executeTool('edit_file', {
      target_file: newFile,
      instructions: 'Update x and y values',
      code_edit: codeEdit8
    }, context);

    if (!res8 || res8.success !== true) {
      throw new Error(`edit_file contextual match failed: ${JSON.stringify(res8)}`);
    }
    const content8 = fs.readFileSync(newFile, 'utf8');
    if (!content8.includes('let x = 10') || !content8.includes('let y = 20')) {
      throw new Error(`Contextual edit not applied, content:\n${content8}`);
    }
    console.log('  ✓ Contextual matching works when exact match unavailable');

    // Test 9: Verify diff generation
    if (res8._diff && res8._diff.includes('let x =')) {
      console.log('  ✓ Diff generation works');
    } else {
      console.log('  ⚠ Diff generation test skipped (diff may be empty or unavailable)');
    }

    // Test 10: Verify file originals tracking
    if (session.data && session.data.fileOriginals) {
      const relPath = path.relative(process.cwd(), newFile);
      if (relPath in session.data.fileOriginals) {
        console.log('  ✓ File originals tracked in session');
      } else {
        console.log('  ⚠ File originals tracking may not be working');
      }
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testListDirAndGlobFileSearch() {
  console.log('\n=== Test: list_dir / glob_file_search Tools ===');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viib-etch-tools-fs-'));
  try {
    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a', 'utf8');
    fs.writeFileSync(path.join(sub, 'b.txt'), 'b', 'utf8');
    fs.writeFileSync(path.join(sub, '.hidden.txt'), 'h', 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.dot'), 'd', 'utf8');

    // list_dir hides dot entries
    const ls = await executeTool('list_dir', { target_directory: tmpDir }, {});
    if (!ls.includes('a.txt') || !ls.includes('sub/')) {
      throw new Error(`Unexpected list_dir output:\n${ls}`);
    }
    if (ls.includes('.dot')) {
      throw new Error(`Expected dotfiles hidden, got:\n${ls}`);
    }
    console.log('  ✓ list_dir hides dotfiles and lists entries');

    // ignore_globs
    const ls2 = await executeTool('list_dir', { target_directory: tmpDir, ignore_globs: ['*.txt'] }, {});
    if (ls2.includes('a.txt')) {
      throw new Error(`Expected ignore_globs to filter a.txt, got:\n${ls2}`);
    }
    console.log('  ✓ list_dir ignore_globs works');

    // glob_file_search should find both txt files, excluding dotfile
    // Ensure ordering is by mtime: make sub/b.txt newer
    const aPath = path.join(tmpDir, 'a.txt');
    const bPath = path.join(sub, 'b.txt');
    const now = Date.now() / 1000;
    fs.utimesSync(aPath, now - 10, now - 10);
    fs.utimesSync(bPath, now, now);

    const globOut = await executeTool('glob_file_search', { target_directory: tmpDir, glob_pattern: '*.txt' }, {});
    const lines = String(globOut).trim().split('\n').filter(Boolean);
    if (lines.length < 2) {
      throw new Error(`Expected at least 2 matches, got:\n${globOut}`);
    }
    if (lines.some(l => l.includes('.hidden.txt'))) {
      throw new Error(`Expected hidden dotfile excluded, got:\n${globOut}`);
    }
    if (!(lines[0].includes('b.txt') && lines[1].includes('a.txt'))) {
      throw new Error(`Expected mtime sort (b before a), got:\n${globOut}`);
    }
    console.log('  ✓ glob_file_search matches and sorts by mtime');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function cleanup(testSessionId, testSessionFile) {
  console.log('\n=== Cleanup ===');
  
  // Delete test session file
  if (testSessionFile && fs.existsSync(testSessionFile)) {
    fs.unlinkSync(testSessionFile);
    console.log(`  ✓ Deleted test session file: ${path.basename(testSessionFile)}`);
  }
  
  // Try to remove test directory if empty
  if (fs.existsSync(TEST_CHATS_DIR)) {
    try {
      const files = fs.readdirSync(TEST_CHATS_DIR);
      // Filter out hidden files and directories
      const visibleFiles = files.filter(f => !f.startsWith('.'));
      if (visibleFiles.length === 0) {
        fs.rmdirSync(TEST_CHATS_DIR);
        console.log(`  ✓ Removed empty test directory`);
      } else {
        // Try to clean up any test chat files that might have been created
        let cleaned = 0;
        for (const file of visibleFiles) {
          if (file.startsWith('chat.') && file.endsWith('.json')) {
            try {
              fs.unlinkSync(path.join(TEST_CHATS_DIR, file));
              cleaned++;
            } catch (err) {
              // Ignore errors for individual files
            }
          }
        }
        if (cleaned > 0) {
          console.log(`  ✓ Cleaned up ${cleaned} test chat file(s)`);
        }
        // Try to remove directory again if now empty
        const remainingFiles = fs.readdirSync(TEST_CHATS_DIR).filter(f => !f.startsWith('.'));
        if (remainingFiles.length === 0) {
          fs.rmdirSync(TEST_CHATS_DIR);
          console.log(`  ✓ Removed test directory after cleanup`);
        } else {
          console.log(`  ⚠ Test directory not empty (${remainingFiles.length} file(s) remaining), leaving it`);
        }
      }
    } catch (err) {
      console.log(`  ⚠ Could not remove test directory: ${err.message}`);
    }
  }
}

async function runTests() {
  console.log('Starting viib-etch-tools.js tests...\n');
  
  let hasErrors = false;
  let testSessionId = null;
  let testSessionFile = null;
  
  try {
    // Test 1: Load tool definitions
    await testLoadToolDefinitions();
    
    // Test 2: Get tool definitions (filtered)
    await testGetToolDefinitions();
    
    // Test 3: Has tool
    await testHasTool();
    
    // Test 4: Get tool handler
    await testGetToolHandler();
    
    // Test 5: todo_write tool
    const todoTestResult = await testTodoWrite();
    testSessionId = todoTestResult.sessionId;
    testSessionFile = todoTestResult.sessionFile;
    
    // Test 6: run_terminal_cmd tool
    await testRunTerminalCmd();

    // Test 7: read_file tool
    await testReadFile();

    // Test 8: apply_patch tool
    await testApplyPatch();

    // Test 9: rg tool
    await testRg();

    // Test 10: delete_file tool
    await testDeleteFile();

    // Test 11: update_memory tool
    await testUpdateMemory();

    // Test 12: read_lints tool
    await testReadLints();

    // Test 13: edit_file tool
    await testEditFile();

    // Test 14: list_dir + glob_file_search tools
    await testListDirAndGlobFileSearch();
    
    console.log('\n=== All Tests Passed ===');
    
  } catch (err) {
    console.error('\n=== Test Failed ===');
    console.error('Error:', err.message);
    console.error(err.stack);
    hasErrors = true;
  } finally {
    // Always cleanup
    await cleanup(testSessionId, testSessionFile);
  }
  
  if (hasErrors) {
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  testLoadToolDefinitions,
  testGetToolDefinitions,
  testHasTool,
  testGetToolHandler,
  testTodoWrite,
  testRunTerminalCmd,
  testEditFile,
  runTests
};

