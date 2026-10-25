import type { ChatFunctionTool , ChatMessages , ChatResult , ChatToolCall  } from "@openrouter/sdk/models" ;
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

const tools : ChatFunctionTool[] = [
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

async function callLLM(messages: ChatMessages[]): Promise<ChatResult> {    
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

async function getToolResponse(toolCall: ChatToolCall) : Promise<ChatMessages> {
    //adding a timeout
    let resolved = false;
    return new Promise( async (resolve , reject)=>{
    let timer = setTimeout(()=>{
        if(!resolved){
            console.log("Timeout received")
            resolve({
                 role:'tool',
                 toolCallId: toolCall.id ,
                 content: JSON.stringify({
                    stdOut:"Timeout while running the tool"
                 }) ,
                 })
        }
    } , 5000);
       if(toolCall.function.name === 'bash'){
       const { command } = JSON.parse(toolCall.function.arguments) as { command: string };
       console.log(`Tool: Bash $ ${command}`);
       const toolResult = await runBash(command);

       resolved=true;
       clearTimeout(timer);
       resolve({
        role:'tool',
        toolCallId: toolCall.id ,
        content: JSON.stringify(toolResult) ,
    });
    }

  else if(toolCall.function.name === 'read_file'){
     const { path } = JSON.parse(toolCall.function.arguments) as { path: string };
     console.log(`Tool: ReadFile ${path}`);
     const toolResult = await ReadFile(path);

     resolved=true;
     clearTimeout(timer);
     resolve({
        role:'tool',
        toolCallId: toolCall.id ,
        content: JSON.stringify(toolResult) ,
    });
    }

    })   
}

const maxIterations = 100;
let iterationCount = 0;
let didReachMaxIterations = true;

while(iterationCount < maxIterations) {
    iterationCount++;
    const response = await callLLM(messages);
    const choice = response.choices[0];

    if(!choice) {
        throw new Error('Expected the model to return a choice');
    }

    const toolCalls = choice.message.toolCalls;

    if(!toolCalls || toolCalls.length === 0) {
        didReachMaxIterations = false;
        break;
    }

    for (const toolCall of toolCalls) {
        messages.push(await getToolResponse(toolCall));
    }
}

if(didReachMaxIterations) {
    console.warn('Warning: Maximum iterations reached');
}

console.log(messages[messages.length - 1]?.content);

await sandbox.kill();