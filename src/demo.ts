import { executeGraph } from "./core/executor";
import { GraphBuildingRound } from "./planner/graph-building";
import { SessionStore } from "./session/store";
import { fallbackSessionName, listSessions } from "./session/index";
import type { AgentController, AgentSnapshot, Graph, JevAdapter, JevRequest, JevResponse } from "./core/types";

export function demoGraph(scenario: "success" | "uncertain" | "failure" = "success"): Graph {
  return {
    version: 1, label: `Demo · ${scenario} · investigate a session failure`,
    context: { fixture: true, scenario }, limits: { concurrency: 3 },
    nodes: {
      search: { type: "bash", label: "Find candidate files", script: "sleep .35; printf '%s\\n' src/session.ts src/token.ts src/session.test.ts" },
      choose: { type: "jev", label: "Select relevant source", prepare: [{ use: "lines", as: "files", input: { $ref: "/nodes/search/output/stdout" } }],
        state: { candidates: { $ref: "/prepared/files/records" }, scenario },
        questions: { file: { type: "choice", instructions: "Which candidate is the session implementation?", criteria: { $ref: "/prepared/files/options" } } },
        accept: { op: "gte", args: [{ $ref: "/answers/file/confidence" }, .75] },
        select: { file: { from: { $ref: "/prepared/files/records" }, key: { $ref: "/answers/file/choice" } } },
      },
      test: { type: "bash", label: "Run fixture tests", needs: ["choose"], script: scenario === "failure" ? "sleep .6; echo 'Fixture: test runner failed to start' >&2; exit 2" : "sleep .6; echo 'Fixture: 4 tests passed'" },
      finish: { type: "bash", label: "Gather findings", needs: ["inspect", "test"], script: "printf '%s\\n' 'Fixture investigation completed. No source files were changed.'" },
    },
    groups: {
      inspect: { kind: "foreach", label: "Inspect candidates", needs: ["choose"], items: { $ref: "/nodes/choose/output/prepared/files/items" }, template: "inspect_file", maxItems: 3, concurrency: 2 },
    },
    templates: {
      inspect_file: { nodes: {
        read: { type: "bash", label: "Read evidence", env: { FILE: { $ref: "/input/text" } }, script: "sleep .45; printf 'Fixture evidence for %s\\n' \"$FILE\"" },
        judge: { type: "jev", label: "Assess relevance", state: { $ref: "/nodes/read/output/stdout" }, questions: { relevant: { type: "noul", instructions: "Is this evidence relevant to session refresh?" } }, accept: { op: "gte", args: [{ $ref: "/answers/relevant/noul" }, .8] } },
      }, output: { $ref: "/nodes/judge/output/answers" } },
    },
    returns: ["choose", "test", "finish"],
  };
}
export class FixtureJev implements JevAdapter {
  async evaluate(request: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    await new Promise<void>((done, reject) => {
      signal?.throwIfAborted();
      const abort = () => { clearTimeout(timer); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort",abort); done(); }, 450);
      signal?.addEventListener("abort",abort,{once:true});
    });
    const uncertain = (request.state as any)?.scenario === "uncertain";
    const answers = Object.fromEntries(Object.entries(request.questions).map(([key,q]:[string,any]) => {
      if (q.type === "noul") return [key,{type:"noul",noul:.97}];
      if (q.type === "score") return [key,{type:"score",score:0,confidence:.95,probabilities:Object.fromEntries(q.criteria.map((_:unknown,i:number)=>[String(i),i===0?1:0]))}];
      const options=Object.keys(q.criteria), choice=options[0]!;
      return [key,{type:"choice",choice,confidence:uncertain?.3:.96,probabilities:Object.fromEntries(options.map((id,i)=>[id,uncertain?1/options.length:i===0?.97:.03/(options.length-1)]))}];
    }));
    return {model:"local-fixture (no API call)",answers};
  }
}
export function createDemoController(cwd:string):AgentController {
  const efforts=["none","minimal","low","medium","high","xhigh","max"];
  const firstSessionId=`demo-${crypto.randomUUID()}`;
  let snapshot:AgentSnapshot={messages:[],busy:false,phase:"idle",model:"local-fixture",models:[{id:"local-fixture",name:"Local demo · no API calls",reasoningEfforts:efforts}],events:[],sessionId:firstSessionId,sessionName:fallbackSessionName(firstSessionId),contextTokens:0,contextLimit:0,cachedTokens:0};
  const listeners=new Set<()=>void>();let abort:AbortController|undefined;
  let active:Promise<void>|undefined,resetting:Promise<void>|undefined;
  const notify=()=>listeners.forEach(fn=>fn());
  const add=(role:"user"|"assistant"|"notice",text:string)=>{snapshot={...snapshot,messages:[...snapshot.messages,{id:crypto.randomUUID(),role,text}]};notify();};
  const controller:AgentController = {
    getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
    submit(text){
      if(resetting)return resetting.then(()=>controller.submit(text));
      if(active)return Promise.resolve();
      const work=(async()=>{
      add("user",text);snapshot={...snapshot,busy:true,phase:"thinking",activityStartedAt:Date.now(),error:undefined};abort=new AbortController();notify();
      const scenario=/uncertain|yield/i.test(text)?"uncertain":/fail|error/i.test(text)?"failure":"success";
      const store = new SessionStore({cwd,sessionId:snapshot.sessionId});
      const building = new GraphBuildingRound({store,signal:abort.signal,supportsStreaming:true,
        execute:(graph,signal,onEvent,streaming)=>executeGraph(graph,{cwd,signal,onEvent,...streaming,jev:new FixtureJev()}),
        onEvent:event=>{
          const phase=event.type==="graph.building"?"building":event.type==="graph.building.finished"?"executing":snapshot.phase;
          snapshot={...snapshot,phase,activityStartedAt:snapshot.activityStartedAt??Date.now(),events:[...snapshot.events,event]};notify();
        },
      });
      try {
        add("assistant",`Building the ${scenario} fixture. Commands run as nodes arrive; graph generation and Jev answers are simulated.`);
        const graph = demoGraph(scenario);
        // Put the final join in a complete subgraph so all streamed root
        // dependencies refer to previously committed nodes or groups.
        const {finish,...nodes}=graph.nodes;
        const {needs,...gather}=finish!;
        graph.templates!.gather = {nodes:{gather}};
        graph.groups!.finish = {kind:"foreach",label:"Gather findings",items:[null],maxItems:1,template:"gather",needs};
        const header = JSON.stringify({version:1,label:graph.label,context:graph.context??{},templates:graph.templates,limits:graph.limits??{},returns:graph.returns??[]});
        const chunks=[header.slice(0,-1)+',"nodes":{',
          ...Object.entries(nodes).map(([id,node],index)=>(index?',':'')+JSON.stringify(id)+':'+JSON.stringify(node)),
          '},"groups":{',...Object.entries(graph.groups!).map(([id,group],index)=>(index?',':'')+JSON.stringify(id)+':'+JSON.stringify(group)),'}}'];
        let argumentsText="";
        for(const chunk of chunks){
          abort.signal.throwIfAborted();
          argumentsText+=chunk;
          await building.receive({index:0,id:"demo-call",name:"execute_graph",arguments:argumentsText,argumentsDelta:chunk});
          await Bun.sleep(240);
        }
        await building.finish([{id:"demo-call"}]);
        const result=(await building.states.get(0)?.run)?.report;
        await building.flush();
        if(!result)throw new Error("Demo graph did not produce a result");
        await store.append("graph.stream.published",{streamId:building.states.get(0)!.id});
        add("assistant",`${result.label}: ${result.status}. ${result.reason??"All requested work finished."}\nRecords: ${result.recordPath}`);
      }catch(error){await building.interrupt(String(error));snapshot={...snapshot,error:String(error)};add("notice",String(error));}
      finally{snapshot={...snapshot,busy:false,phase:"idle",activityStartedAt:undefined};notify();}
      })();
      active=work;void work.finally(()=>{if(active===work)active=undefined;}).catch(()=>{});
      return work;
    },
    interrupt(){abort?.abort(new Error("Interrupted by user"));},
    setModel(){add("notice","Demo mode uses local fixtures. Start without --demo to use real models.");},
    async setEffort(level){
      if(snapshot.busy){snapshot={...snapshot,error:"Interrupt the active turn before changing effort."};notify();return;}
      const effort=["auto","default"].includes(level)?undefined:level;
      if(effort&&!efforts.includes(effort)){snapshot={...snapshot,error:`Unknown effort ${level}`};notify();return;}
      snapshot={...snapshot,effort,error:undefined};notify();
    },
    newSession(){
      if(resetting)return resetting;
      resetting=(async()=>{
        abort?.abort(new Error("Starting a new session"));await active;
        const sessionId=`demo-${crypto.randomUUID()}`;
        snapshot={...snapshot,messages:[],events:[],sessionId,sessionName:fallbackSessionName(sessionId),busy:false,phase:"idle",activityStartedAt:undefined,error:undefined};notify();
      })().finally(()=>{resetting=undefined;});
      return resetting;
    },
    listSessions:()=>listSessions(cwd),
    async resumeSession(){throw new Error("Session resume is unavailable in demo mode.");},
    async setSessionName(name){
      const store=new SessionStore({cwd,sessionId:snapshot.sessionId});
      await store.initialize();
      const saved=await store.setName(name,"manual");
      snapshot={...snapshot,sessionName:saved,error:undefined};notify();
    },
    pin(text){add("notice",`Demo pin: ${text}`);},
  };
  return controller;
}
