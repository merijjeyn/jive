#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { executeGraph } from "./core/executor";
import { graphSchema } from "./core/schema";
import { graphToolParameters } from "./core/tool-schema";
import { runtimeCatalog } from "./core/catalog";
import { ExtractorRegistry } from "./plugins/registry";
import { JevClient } from "./jev/client";
import { createDemoController, demoGraph, FixtureJev } from "./demo";
import { CURATED_MODELS, fetchOpenRouterModelCatalog, saveModelCatalog } from "./planner/models";
import { listSessions, resolveSessionReference } from "./session/index";

const {values,positionals}=parseArgs({args:process.argv.slice(2),allowPositionals:true,options:{
  help:{type:"boolean",short:"h"},version:{type:"boolean",short:"v"},demo:{type:"boolean"},headless:{type:"boolean"},json:{type:"boolean"},
  run:{type:"string"},model:{type:"string"},resume:{type:"string"},cwd:{type:"string"},prompt:{type:"string"},prefill:{type:"string"},
  schema:{type:"boolean"},models:{type:"boolean"},"refresh-models":{type:"boolean"},sessions:{type:"boolean"},search:{type:"string"},effort:{type:"string"},
}});
const cwd=resolve(values.cwd??process.cwd());

async function main(){
  if(values.version){const pkg=JSON.parse(await readFile(resolve(import.meta.dir,"../package.json"),"utf8"));console.log(`jive ${pkg.version}`);return;}
  if(values.help){console.log(`Jive

  jive                              Interactive agent in the current directory
  jive --prefill "Inspect this repository"  Editable draft; press Enter to start
  jive --demo                       Interactive demo (no API calls)
  jive --headless --prompt "Inspect this repository"
  jive --run examples/parallel.json --json
  jive --demo --headless            Execute local fixture graph
  jive --resume SESSION_ID          Restore a session, without resuming commands
  jive --sessions                   List saved sessions
  jive --resume ID --search QUERY
  jive --models                     List curated planner models
  jive --refresh-models             Refresh OpenRouter model capabilities
  jive --schema                     Print execute_graph JSON Schema
  jive --version                    Print the installed version
  jive update                       Pull the latest sources (git installs)

Options: --cwd DIR --model ID --effort LEVEL --json --headless --prompt TEXT --prefill TEXT
Headless mode skips automatic session naming.
--prompt submits immediately. --prefill fills the interactive composer without submitting.
Interactive commands: /resume [ID], /sessions, /name TEXT, /rename TEXT,
/model, /effort [LEVEL], /new, /clear, /pin TEXT, /quit.
The agent works in the current directory: AGENTS.md, .jev/extractors and
.jev/sessions are read and written there. Override with --cwd DIR.
See README.md for keys.
Credentials: OPENROUTER_API_KEY and JEV_API_TOKEN, from .env in the working
directory (searched upward) or the jive checkout. Install: see README.md.
`);return;}
  if(values.prefill!==undefined && (values.headless || values.run || values.prompt!==undefined || positionals.length))throw new Error("--prefill is interactive-only and cannot be combined with --prompt, positional prompts, --headless, or --run");
  if(values.schema){console.log(JSON.stringify(graphSchema,null,2));return;}
  if(values["refresh-models"]){const catalog=await fetchOpenRouterModelCatalog({signal:AbortSignal.timeout(15000)});await saveModelCatalog(cwd,catalog);console.log(`Saved ${catalog.models.length} tool-capable models.`);return;}
  if(values.models){for(const model of CURATED_MODELS)console.log(`${model.id}\t${model.name}`);return;}
  if(values.sessions){for(const session of await listSessions(cwd))console.log(`${session.id}\t${session.name}\t${session.updatedAt}`);return;}
  if(values.search!==undefined){
    if(!values.resume || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(values.resume))throw new Error("--search requires a valid --resume SESSION_ID");
    const sessionId=await resolveSessionReference(cwd,values.resume);
    const lines=(await readFile(join(cwd,".jev/sessions",sessionId,"session.jsonl"),"utf8")).split("\n");
    for(let index=0;index<lines.length;index++)if(lines[index]!.toLowerCase().includes(values.search.toLowerCase()))console.log(`${index+1}: ${lines[index]}`);
    return;
  }
  if(values.run || values.demo&&values.headless){
    const graph=values.run?JSON.parse(await readFile(resolve(cwd,values.run),"utf8")):demoGraph();
    const abort=new AbortController();const cancel=()=>abort.abort(new Error("Interrupted by user"));process.once("SIGINT",cancel);
    try{
      const report=await executeGraph(graph,{cwd,signal:abort.signal,jev:values.demo?new FixtureJev():new JevClient(),onEvent:values.json?event=>console.log(JSON.stringify(event)):event=>{if(event.type==="node.finished"){const r=event.data.result as any;console.log(`${r.status.padEnd(10)} ${r.id}`);}}});
      if(!values.json)console.log(`${report.status}: ${report.recordPath}`);
      if(report.status!=="done")process.exitCode=1;
    }finally{process.removeListener("SIGINT",cancel);}return;
  }
  let controller;
  if(values.demo)controller=createDemoController(cwd);
  else{
    const {createAgent}=await import("./planner/agent");
    const sessionId=values.resume?await resolveSessionReference(cwd,values.resume):undefined;
    controller=await createAgent({cwd,model:values.model??(sessionId?undefined:process.env.OPENROUTER_MODEL??"google/gemini-3.8-flash"),sessionId,toolSchema:graphToolParameters,
      generateSessionName:values.headless?false:undefined,
      supportsStreaming:true,
      execute:async(graph,signal,onEvent,streaming)=>executeGraph(graph,{cwd,signal,onEvent,...streaming,plugins:await ExtractorRegistry.load(cwd)}),
      getPluginCatalog:async()=>runtimeCatalog(cwd),
    });
  }
  if(values.effort)await controller.setEffort(values.effort);
  const prompt=values.prompt??positionals.join(" ");
  if(values.headless){
    if(!prompt)throw new Error("Headless planner requires --prompt TEXT (or use --demo --headless)");
    const unsubscribe=controller.subscribe(()=>{if(values.json)console.log(JSON.stringify({type:"agent.snapshot",snapshot:controller.getSnapshot()}));});
    const cancel=()=>controller.interrupt();process.once("SIGINT",cancel);
    try{
      await controller.submit(prompt);
      if(values.json)console.log(JSON.stringify({type:"agent.finished",snapshot:controller.getSnapshot()}));
      else for(const message of controller.getSnapshot().messages)if(message.role!=="user")console.log(message.text);
      if(controller.getSnapshot().error)process.exitCode=1;
    }finally{unsubscribe();process.removeListener("SIGINT",cancel);}return;
  }
  const {launchUI}=await import("./ui/app");
  if(prompt)void controller.submit(prompt);
  await launchUI(controller,{initialInput:values.prefill});
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
