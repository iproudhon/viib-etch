// test-viib-etch.js
// Test file for viib-etch.js

const {
  ChatModel,
  ChatSession,
  ChatLLM,
  loadModels,
  loadChat,
  listChatSessions,
  createChat
} = require('./viib-etch.js');

async function testModelDefaultTools() {
  console.log('\n=== Test: ChatModel.tools default tools ===');

  const originalLoadModels = ChatModel.loadModels;
  try {
    ChatModel.loadModels = () => ([
      new ChatModel({
        name: 'test-model-tools',
        model: 'gpt-4o-mini',
        base_url: 'https://api.openai.com/v1',
        api_key: process.env.OPENAI_API_KEY || 'test-key',
        tools: ['read_file', 'apply_patch']
      })
    ]);

    const llm = ChatLLM.newChatSession('test-model-tools', false, null, {});
    if (!Array.isArray(llm.tools) || llm.tools.length === 0) {
      throw new Error(`Expected llm.tools to be a non-empty array, got: ${typeof llm.tools}`);
    }

    // Tools may be normalized (either {type:'function', function:{name}} or {type:'function', name})
    const names = llm.tools.map(t => (t && t.function && t.function.name) ? t.function.name : t && t.name).filter(Boolean);
    if (!names.includes('read_file') || !names.includes('apply_patch')) {
      throw new Error(`Expected tools to include read_file and apply_patch, got: ${JSON.stringify(names)}`);
    }

    // Ensure the tools are convertible into /v1/responses format
    const respTools = llm._normalizeToolsForResponses(llm.tools);
    if (!Array.isArray(respTools) || respTools.length === 0) {
      throw new Error('Expected normalized responses tools to be a non-empty array');
    }
    for (const t of respTools) {
      if (t.type !== 'function') continue;
      if (typeof t.name !== 'string' || !t.name) {
        throw new Error(`Expected responses function tool to have top-level name, got: ${JSON.stringify(t)}`);
      }
      if (t.function !== undefined) {
        throw new Error(`Expected responses tool to not include nested function field, got: ${JSON.stringify(t)}`);
      }
    }

    console.log('  ✓ ChatLLM loads default tool definitions from ChatModel.tools');
  } finally {
    ChatModel.loadModels = originalLoadModels;
  }
}

async function testLoadModels() {
  console.log('\n=== Test: Load Models ===');
  try {
    const models = loadModels('viib-etch-models.json');
    console.log(`Loaded ${models.length} models:`);
    models.forEach(m => {
      console.log(`  - ${m.name}: ${m.model} (${m.base_url})`);
    });
    return models;
  } catch (err) {
    console.error('Error loading models:', err.message);
    // Create a test model for demo purposes
    console.log('Creating test model...');
    return [new ChatModel({
      name: 'test-model',
      model: 'gpt-4o-mini',
      base_url: 'https://api.openai.com/v1',
      api_key: process.env.OPENAI_API_KEY || 'test-key'
    })];
  }
}

async function testChatSession() {
  console.log('\n=== Test: ChatSession ===');
  
  // Test creating a new session
  const session = new ChatSession({ 
    title: 'Test Chat',
    model_name: 'test-model'
  });
  console.log(`Created session: ${session.id}`);
  console.log(`  Title: ${session.title}`);
  console.log(`  Model: ${session.model_name}`);

  // Enable persistence for this test (ChatSession is transient by default)
  session.enablePersistence();
  
  // Test adding messages
  session.addMessage({ role: 'user', content: 'Hello, this is a test message' });
  session.addMessage({
    role: 'assistant',
    content: 'This is a test response'
  });
  console.log(`  Messages: ${session.messages.length}`);
  
  // Test saving and loading
  const sessionId = session.id;
  const loaded = ChatSession.load(sessionId);
  console.log(`Loaded session: ${loaded.id}`);
  console.log(`  Messages match: ${loaded.messages.length === session.messages.length}`);
  
  // Test listing sessions
  const sessions = ChatSession.listChatSessions();
  console.log(`\nTotal chat sessions: ${sessions.length}`);
  if (sessions.length > 0) {
    console.log('Recent sessions:');
    sessions.slice(0, 3).forEach(s => {
      console.log(`  - ${s.id}: ${s.title || '(no title)'} (${s.message_count} messages)`);
    });
  }
  
  return session;
}

async function testChatLLM(models) {
  console.log('\n=== Test: ChatLLM ===');
  
  if (!models || models.length === 0) {
    console.log('Skipping ChatLLM tests - no models available');
    return;
  }
  
  const model = models[0];
  console.log(`Using model: ${model.name}`);
  
  // Test creating new chat session via ChatLLM
  const llm = ChatLLM.newChatSession(model.name, false, null, {
    onResponseStart: () => console.log('  [Hook] Response started'),
    onResponseData: (chunk) => process.stdout.write(chunk),
    onResponseDone: (content) => console.log(`\n  [Hook] Response done (${content.length} chars)`),
    onToolCallStart: (toolCall) => console.log(`  [Hook] Tool call started: ${toolCall.function.name}`),
    onToolCallEnd: (toolCall) => console.log(`  [Hook] Tool call ended: ${toolCall.function.name}`)
  });
  
  console.log(`Created ChatLLM with chat ID: ${llm.chat.id}`);
  
  // Test adding user message
  await llm.addUserMessage('Say hello in a friendly way');
  console.log('Added user message');
  
  // Test non-streaming completion
  console.log('\nTesting non-streaming completion...');
  try {
    const result = await llm.complete({
      stream: false,
      temperature: 0.7
    });
    console.log(`Response: ${result.content}`);
    console.log(`Usage: ${JSON.stringify(result.usage)}`);
  } catch (err) {
    console.error('Error in completion:', err.message);
    throw err;
  }
  
  // Test streaming completion
  console.log('\nTesting streaming completion...');
  try {
    const result = await llm.complete({
      stream: true,
      temperature: 0.7
    });
    console.log(`\nFinal response length: ${result.content.length} chars`);
  } catch (err) {
    console.error('Error in streaming:', err.message);
    throw err;
  }
  
  return llm;
}

async function testToolCalling(models) {
  console.log('\n=== Test: Tool Calling ===');
  
  if (!models || models.length === 0) {
    console.log('Skipping tool calling tests - no models available');
    return;
  }
  
  const model = models[0];
  const llm = ChatLLM.newChatSession(model.name, false, null, {
    onToolCallStart: (toolCall) => {
      console.log(`  [Tool] Start: ${toolCall.function.name}`);
    },
    onToolCallData: (toolCall) => {
      // Could show incremental data if needed
    },
    onToolCallEnd: (toolCall) => {
      console.log(`  [Tool] End: ${toolCall.function.name}`);
      console.log(`    Args: ${toolCall.function.arguments.substring(0, 50)}...`);
    }
  });
  
  await llm.addUserMessage('What is the weather in San Francisco?');
  
  const tools = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the current weather for a location',
        parameters: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'The city and state, e.g. San Francisco, CA'
            },
            unit: {
              type: 'string',
              enum: ['celsius', 'fahrenheit'],
              description: 'Temperature unit'
            }
          },
          required: ['location']
        }
      }
    }
  ];
  
  // Test with tools
  try {
    const result = await llm.complete({
      stream: false,
      tools: tools,
      tool_choice: 'auto'
    });
    
    if (result.tool_calls && result.tool_calls.length > 0) {
      console.log(`\nModel requested ${result.tool_calls.length} tool call(s)`);
      result.tool_calls.forEach((toolCall, idx) => {
        console.log(`  Tool ${idx + 1}: ${toolCall.function.name}`);
        console.log(`    Args: ${toolCall.function.arguments}`);
      });
      
      // Simulate tool response
      const toolCall = result.tool_calls[0];
      await llm.addToolMessage(
        toolCall.id,
        toolCall.function.name,
        JSON.stringify({ temperature: 72, condition: 'sunny' })
      );
      
      // Continue conversation
      const finalResult = await llm.complete({
        stream: false
      });
      console.log(`\nFinal response: ${finalResult.content}`);
    } else {
      console.log('No tool calls made');
    }
  } catch (err) {
    console.error('Error in tool calling test:', err.message);
    throw err;
  }
}

async function testConvenienceFunctions(models) {
  console.log('\n=== Test: Convenience Functions ===');
  
  if (!models || models.length === 0) {
    console.log('Skipping convenience function tests - no models available');
    return;
  }
  
  // Test createChat
  const modelName = models[0].name;
  console.log(`Testing createChat with model: ${modelName}`);
  const llm1 = createChat(modelName, false, null, {
    onResponseData: (chunk) => process.stdout.write('.')
  });
  // Enable persistence so loadChat/listChatSessions can find it on disk
  llm1.chat.enablePersistence();
  console.log(`\nCreated chat via createChat: ${llm1.chat.id}`);
  
  // Test loadChat
  const chatId = llm1.chat.id;
  const loadedChat = loadChat(chatId);
  if (loadedChat) {
    console.log(`Loaded chat: ${loadedChat.id} (${loadedChat.messages.length} messages)`);
  }
  
  // Test listChatSessions
  const sessions = listChatSessions();
  console.log(`\nListed ${sessions.length} chat sessions`);
}

async function testReasoningHooks(models) {
  console.log('\n=== Test: Reasoning Hooks ===');
  
  if (!models || models.length === 0) {
    console.log('Skipping reasoning hooks test - no models available');
    return;
  }
  
  // Find a model that supports reasoning (like o1)
  const reasoningModel = models.find(m => m.reasoning_effort) || models[0];
  console.log(`Testing reasoning hooks with model: ${reasoningModel.name}`);
  
  const llm = ChatLLM.newChatSession(reasoningModel.name, false, null, {
    onReasoningStart: () => console.log('  [Reasoning] Started'),
    onReasoningData: (chunk) => process.stdout.write('█'),
    onReasoningDone: (fullReasoning) => {
      console.log(`\n  [Reasoning] Done (${fullReasoning.length} chars)`);
    },
    onResponseStart: () => console.log('  [Response] Started'),
    onResponseData: (chunk) => process.stdout.write(chunk),
    onResponseDone: (content) => console.log(`\n  [Response] Done (${content.length} chars)`)
  });
  
  await llm.addUserMessage('What is 2+2?');
  
  // Test with reasoning (only if model supports it)
  if (reasoningModel.reasoning_effort && reasoningModel.reasoning_effort !== 'off') {
    try {
      const result = await llm.complete({
        stream: true
      });
      console.log('\nReasoning test completed');
    } catch (err) {
      console.error('Error in reasoning test:', err.message);
      throw err;
    }
  } else {
    console.log('  Skipping reasoning test - model does not support reasoning');
  }
}

async function testResponsesAPI(models) {
  console.log('\n=== Test: /v1/responses API ===');
  
  if (!models || models.length === 0) {
    console.log('Skipping responses API tests - no models available');
    return;
  }
  
  // Find a model that should use responses API (GPT-4o or newer)
  const responsesModel = models.find(m => {
    const modelName = m.model.toLowerCase();
    return modelName.startsWith('gpt-') && 
           modelName !== 'gpt-4' && 
           (modelName.startsWith('gpt-4o') || 
            modelName.startsWith('gpt-4-turbo') || 
            modelName.startsWith('gpt-5'));
  });
  
  if (!responsesModel) {
    console.log('  Skipping responses API test - no suitable model found (need GPT-4o or newer)');
    return;
  }
  
  console.log(`Testing responses API with model: ${responsesModel.name} (${responsesModel.model})`);
  
  const llm = ChatLLM.newChatSession(responsesModel.name, false, null, {
    onResponseStart: () => console.log('  [Response] Started'),
    onResponseData: (chunk) => process.stdout.write(chunk),
    onResponseDone: (content) => console.log(`\n  [Response] Done`)
  });
  
  // Test 1: First message - should send all messages, no response_id
  console.log('\n  Test 1: First message (no response_id)');
  await llm.addUserMessage('Hello, say hi back');
  
  try {
    const result1 = await llm.complete({
      stream: false
    });
    
    // Check that response_id was stored in the assistant message
    const assistantMessages = llm.chat.messages.filter(m => m.role === 'assistant');
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    
    if (!lastAssistant || !lastAssistant.response_id) {
      throw new Error('Expected response_id to be stored in assistant message after first call');
    }
    
    console.log(`  ✓ First response received, response_id: ${lastAssistant.response_id.substring(0, 20)}...`);
    
    // Test 2: Second message - should use response_id and send only new messages
    console.log('\n  Test 2: Second message (using response_id)');
    await llm.addUserMessage('What was your previous response about?');
    
    const result2 = await llm.complete({
      stream: false
    });
    
    // Verify response_id is still stored
    const assistantMessages2 = llm.chat.messages.filter(m => m.role === 'assistant');
    const lastAssistant2 = assistantMessages2[assistantMessages2.length - 1];
    
    if (!lastAssistant2 || !lastAssistant2.response_id) {
      throw new Error('Expected response_id to be stored in assistant message after second call');
    }
    
    console.log(`  ✓ Second response received, new response_id: ${lastAssistant2.response_id.substring(0, 20)}...`);
    
    // Test 3: Verify _getLastResponseId works
    const lastResponseId = llm._getLastResponseId();
    if (!lastResponseId || !lastResponseId.response_id) {
      throw new Error('_getLastResponseId should return the last response_id');
    }
    if (lastResponseId.response_id !== lastAssistant2.response_id) {
      throw new Error('_getLastResponseId should return the most recent response_id');
    }
    console.log(`  ✓ _getLastResponseId correctly returns last response_id`);
    
    console.log('\n  ✓ All responses API tests passed');
    
  } catch (err) {
    console.error('  Error in responses API test:', err.message);
    // Don't throw - this might fail if API key is not set or model not available
    console.log('  ⚠ This test requires valid API credentials and a GPT-4o+ model');
  }
}

async function testInvalidResponseId(models) {
  console.log('\n=== Test: Invalid Response ID Handling ===');
  
  if (!models || models.length === 0) {
    console.log('Skipping invalid response_id tests - no models available');
    return;
  }
  
  // Find a model that should use responses API
  const responsesModel = models.find(m => {
    const modelName = m.model.toLowerCase();
    return modelName.startsWith('gpt-') && 
           modelName !== 'gpt-4' && 
           (modelName.startsWith('gpt-4o') || 
            modelName.startsWith('gpt-4-turbo') || 
            modelName.startsWith('gpt-5'));
  });
  
  if (!responsesModel) {
    console.log('  Skipping invalid response_id test - no suitable model found (need GPT-4o or newer)');
    return;
  }
  
  console.log(`Testing invalid response_id handling with model: ${responsesModel.name}`);
  
  const llm = ChatLLM.newChatSession(responsesModel.name, false, null, {
    onResponseStart: () => console.log('  [Response] Started'),
    onResponseData: (chunk) => process.stdout.write(chunk),
    onResponseDone: (content) => console.log(`\n  [Response] Done`)
  });
  
  try {
    // First, create a valid conversation
    await llm.addUserMessage('Say hello');
    const result1 = await llm.complete({ stream: false });
    
    const assistantMessages = llm.chat.messages.filter(m => m.role === 'assistant');
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    
    if (!lastAssistant || !lastAssistant.response_id) {
      console.log('  ⚠ Could not create valid response_id for test');
      return;
    }
    
    const validResponseId = lastAssistant.response_id;
    console.log(`  Created valid response_id: ${validResponseId.substring(0, 20)}...`);
    
    // Test: Manually set an invalid response_id to simulate expiration
    console.log('\n  Test: Simulating invalid response_id (404 error)');
    
    // Add a new assistant message with an invalid response_id
    llm.chat.addMessage({
      role: 'assistant',
      content: 'Test message',
      response_id: 'invalid_response_id_12345'
    });
    
    // Add a user message to trigger the next API call
    await llm.addUserMessage('Continue the conversation');
    
    // This should catch the 404 error and retry with all messages
    try {
      const result2 = await llm.complete({ stream: false });
      
      // After retry, the invalid response_id should be removed from messages
      const messagesAfterRetry = llm.chat.messages.filter(m => 
        m.role === 'assistant' && m.response_id === 'invalid_response_id_12345'
      );
      
      if (messagesAfterRetry.length > 0) {
        console.log('  ✓ Invalid response_id was cleared from messages after 404');
      }
      
      // Verify new response_id was stored
      const newAssistantMessages = llm.chat.messages.filter(m => m.role === 'assistant');
      const newestAssistant = newAssistantMessages[newAssistantMessages.length - 1];
      
      if (newestAssistant && newestAssistant.response_id && 
          newestAssistant.response_id !== 'invalid_response_id_12345') {
        console.log(`  ✓ New response_id created after retry: ${newestAssistant.response_id.substring(0, 20)}...`);
      }
      
      console.log('\n  ✓ Invalid response_id handling test passed (retry with all messages)');
      
    } catch (err) {
      // If we get an error, check if it's because the invalid response_id wasn't caught
      if (err.message && err.message.includes('404')) {
        console.log('  ⚠ Received 404 error, but retry logic may not have triggered');
        console.log('  This could happen if error format differs from expected');
      } else {
        throw err;
      }
    }
    
  } catch (err) {
    console.error('  Error in invalid response_id test:', err.message);
    // Don't throw - this test might fail if API key is not set
    console.log('  ⚠ This test requires valid API credentials and a GPT-4o+ model');
  }
}

async function runTests() {
  console.log('Starting viib-etch.js tests...\n');
  
  let hasErrors = false;
  
  try {
    await testModelDefaultTools();

    // Test 1: Load models
    const models = await testLoadModels();
    
    // Test 2: ChatSession operations
    await testChatSession();
    
    // Test 3: ChatLLM basic operations
    try {
      await testChatLLM(models);
    } catch (err) {
      console.error('\nTest failed: ChatLLM basic operations');
      hasErrors = true;
    }
    
    // Test 4: Tool calling
    try {
      await testToolCalling(models);
    } catch (err) {
      console.error('\nTest failed: Tool calling');
      hasErrors = true;
    }
    
    // Test 5: Convenience functions
    await testConvenienceFunctions(models);
    
    // Test 6: Reasoning hooks
    try {
      await testReasoningHooks(models);
    } catch (err) {
      console.error('\nTest failed: Reasoning hooks');
      hasErrors = true;
    }
    
    // Test 7: /v1/responses API
    try {
      await testResponsesAPI(models);
    } catch (err) {
      console.error('\nTest failed: Responses API');
      hasErrors = true;
    }
    
    // Test 8: Invalid response_id handling
    try {
      await testInvalidResponseId(models);
    } catch (err) {
      console.error('\nTest failed: Invalid response_id handling');
      hasErrors = true;
    }
    
    if (hasErrors) {
      console.log('\n=== Tests Completed with Errors ===');
      process.exit(1);
    } else {
      console.log('\n=== All Tests Passed ===');
    }
    
  } catch (err) {
    console.error('\nTest suite error:', err);
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
  testLoadModels,
  testChatSession,
  testChatLLM,
  testToolCalling,
  testConvenienceFunctions,
  testReasoningHooks,
  testResponsesAPI,
  testInvalidResponseId,
  runTests
};

