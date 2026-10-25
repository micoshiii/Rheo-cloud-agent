import { providerPreferencesIgnoreToJSON, type ChatFunctionTool , type ChatMessages , type ChatResult , type ChatToolCall  } from "@openrouter/sdk/models" ;
import { OpenRouter } from "@openrouter/sdk";
import { CommandExitError, Sandbox } from "e2b";


const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if(!OPENROUTER_API_KEY){
    throw new Error("Set OPENROUTER_API_KEY in apps/agent/.env");
}

if(!process.env.E2B_API_KEY){
    throw new Error("Set E2B_API_KEY in apps/agent/.env");
}

const openRouter = new OpenRouter({
    apiKey : OPENROUTER_API_KEY ,
});

// const TODO_APP_PATH = resolve(import.meta.dir, '../../')

const REPO_URL= "https://github.com/anuzx/AI_flappy_bird";
const REPO_PATH="/home/user/rheo-testing"


console.log("Starting Sandbox");
const startTime = Date.now();
const sandbox = await Sandbox.create();

console.log(`It took ${ (Date.now() - startTime) / 1000 } seconds to start the sandbox`);
console.log(`Sandbox started: ${sandbox.sandboxId}`);

console.log(`Cloning ${REPO_URL}...`);
await sandbox.commands.run(`git clone --depth 1 ${REPO_URL} ${REPO_PATH}` , { timeoutMs: 120_000 });

const baseTools: ChatFunctionTool[] = [
    {
        type: 'function' ,
        function: {
            name: 'bash' ,
            description: 'Run a bash command and return its stdout , stderr and exit code. Use it to explore the filesystem (ls, cat , find , grep , etc).' ,
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string'
                    }
                } ,
                required: ['command'],
            }
        }
    } ,
    {
        type: 'function' ,
        function: {
            name: 'read_file' ,
            description: 'Reads the file at the given path' ,
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string'
                    }
                } ,
                required: ['path'],
            }
        }
    }
];

const subAgentTool: ChatFunctionTool = {
    type: 'function' ,
    function: {
        name: 'sub_agent' ,
        description: 'Delegate a difficult, self-contained task (deep investigation, multi-step analysis, tracing logic across many files) to a sub-agent. The sub-agent has its own fresh context and the same bash/read_file tools, but cannot see this conversation, so describe the task and any relevant context fully. Returns the sub-agent\'s final report.' ,
        parameters: {
            type: 'object' ,
            properties: {
                task: {
                    type: 'string' ,
                    description: 'A complete , standalone description of what the sub-agent should do and what it should report back.' ,
                } ,
            } ,
            required: ['task'] ,
        },
    },

};

// the sub-agent only gets the base tools, so it can't spawn sub-agents of its own
const mainTools: ChatFunctionTool[] = [...baseTools, subAgentTool];

async function runBash(command: string){
    try{
        const result = await sandbox.commands.run(command , { cwd: REPO_PATH });
    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
    };
    }catch(err){
        // commands.run throws on a non-zero exit code; pass it back to the model as a result
     if (err instanceof CommandExitError) {
      return {
        exitCode: err.exitCode,
        stdout: err.stdout,
        stderr: err.stderr,
            };
       }
     throw err;
     }
    }


async function ReadFile(path: string){
   try {
    const content = await sandbox.files.read(path);
    return { exitCode: 0, stdout: content, stderr: '' };
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: String(err) };
  }
}

const messages: ChatMessages[] = [
    {
        role: 'system' ,
        content: 'You are a helpful coding agent. Use the bash toool to explore files before answering'
    } ,
    {
        role: 'user' ,
        content: `tell me more about the project ${REPO_PATH} , dont make so much efforts just a  basic idea `
    } ,
];

async function callLLM(messages: ChatMessages[] , tools: ChatFunctionTool[]): Promise<ChatResult> {    
    const result = await openRouter.chat.send({
        chatRequest: {
            model: 'openrouter/free' ,
            tools,
            messages ,
            stream: false ,
        }
    });

    if(!('choices' in result)) {
        throw new Error("Expected a non-streaming response");
    }

    const choice = result.choices[0];

    if(!choice) {
        throw new Error('Expected the model to return a choice')
    }

    messages.push(choice.message);
    return result;

}

async function runTool(toolCall: ChatToolCall, tools: ChatFunctionTool[]) {
  const name = toolCall.function.name;

  if (!tools.some((tool) => 'function' in tool && tool.function.name === name)) {
    return { exitCode: 1, stdout: '', stderr: `Unknown tool: ${name}` };
  }

  if (name === 'sub_agent') {
    const { task } = JSON.parse(toolCall.function.arguments) as { task: string };
    console.log(`Tool: SubAgent > ${task}`);
    return { result: await runSubAgent(task) };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ stdout: string }>((resolve) => {
    timer = setTimeout(() => {
      console.log('timeout received');
      resolve({ stdout: 'Timeout while running the tool' });
    }, 30000);
  });

  const run = async () => {
    if (name === 'bash') {
      const { command } = JSON.parse(toolCall.function.arguments) as { command: string };
      console.log(`Tool: Bash $ ${command}`);
      return runBash(command);
    }
    const { path } = JSON.parse(toolCall.function.arguments) as { path: string };
    console.log(`Tool: ReadFile ${path}`);
    return ReadFile(path);
     };

  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function getToolResponse(toolCall: ChatToolCall, tools: ChatFunctionTool[]): Promise<ChatMessages> {
  return {
    role: 'tool',
    toolCallId: toolCall.id,
    content: JSON.stringify(await runTool(toolCall, tools)),
  };
}

const MAX_CONTEXT_TOKENS = 100_000;
// system prompt + original user task are always kept verbatim
const PINNED_MESSAGE_COUNT = 2;

async function summarizeMessages(messages: ChatMessages[]) {
  const pinned = messages.slice(0, PINNED_MESSAGE_COUNT);
  const history = messages.slice(PINNED_MESSAGE_COUNT);

  if (history.length === 0) {
    return;
  }

  console.log(`Summarizing ${history.length} messages...`);

  const result = await openRouter.chat.send({
    chatRequest: {
      model: 'google/gemini-3-flash-preview',
      messages: [
        {
          role: 'system',
          content:
            'You compress the working history of a coding agent so it can continue its task. Write a concise but complete summary covering: what has been explored, commands run and their key results, important file paths and contents/findings, decisions made, and what remains to be done. Do not drop facts the agent will need to finish the task.',
        },
        {
          role: 'user',
          content: `Original task:\n${JSON.stringify(pinned[1]?.content)}\n\nHistory to summarize:\n${JSON.stringify(history)}`,
        },
      ],
      stream: false,
    },
  });

  if (!('choices' in result)) {
    throw new Error('Expected a non-streaming response');
  }

  const summary = result.choices[0]?.message.content;

  if (!summary) {
    throw new Error('Expected the model to return a summary');
  }

  messages.splice(PINNED_MESSAGE_COUNT, history.length, {
    role: 'user',
    content: `Summary of your progress so far (earlier messages were compacted to save context):\n\n${typeof summary === 'string' ? summary : JSON.stringify(summary)}\n\nContinue the task from here.`,
  });
}

async function runAgent(messages: ChatMessages[], tools: ChatFunctionTool[], maxIterations: number, label: string) {
  let iterationCount = 0;

  while (iterationCount < maxIterations) {
    iterationCount++;
    const response = await callLLM(messages, tools);
    const contextTokens = (response.usage?.promptTokens ?? 0) + (response.usage?.completionTokens ?? 0);
    console.log(`[${label}] Iteration ${iterationCount}: context ${contextTokens} tokens`);
    const choice = response.choices[0];

    if (!choice) {
      throw new Error('Expected the model to return a choice');
    }

    const toolCalls = choice.message.toolCalls;

    if (!toolCalls || toolCalls.length === 0) {
      return choice.message.content;
    }

    for (const toolCall of toolCalls) {
      messages.push(await getToolResponse(toolCall, tools));
    }

    if (contextTokens > MAX_CONTEXT_TOKENS) {
      await summarizeMessages(messages);
      console.log(messages);
    }
  }

  console.warn(`[${label}] Warning: Maximum iterations reached`);
  return messages[messages.length - 1]?.content;
}

async function runSubAgent(task: string) {
  const subMessages: ChatMessages[] = [
    {
      role: 'system',
      content: `You are a sub-agent of a coding agent, running inside a sandbox. You have been delegated one specific task. Use the bash and read_file tools to complete it thoroughly. The working directory is ${REPO_PATH}. When you are done, reply with a complete, self-contained report of your findings or results - it is the only thing the main agent will see.`,
    },
    {
      role: 'user',
      content: task,
    },
  ];

  const result = await runAgent(subMessages, baseTools, 30, 'sub-agent');
  console.log('[sub-agent] Done');
  return result ?? 'The sub-agent did not produce a result.';
}

const finalAnswer = await runAgent(messages, mainTools, 50, 'main');

console.log(finalAnswer);

await sandbox.kill();

