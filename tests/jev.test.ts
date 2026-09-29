import { expect, test } from "bun:test";
import { JevAnswerError, JevClient, validateAnswer } from "../src/jev/client";

test("Jev client sends structured questions and preserves uncertainty", async () => {
  let body:any, authorization:string|undefined;
  const transport = (async (_url:any,init:any) => {body=JSON.parse(init.body);authorization=init.headers.Authorization;return new Response(JSON.stringify({model:"jev-fixture",answers:{route:{type:"choice",choice:"a",confidence:.25,probabilities:{a:.55,b:.45}}},usage:{input_tokens:50,output_tokens:10}}));}) as unknown as typeof fetch;
  const client=new JevClient({apiKey:"test-key",fetch:transport});
  const result=await client.evaluate({state:{evidence:"x"},questions:{route:{type:"choice",instructions:{question:"Which fits?"},criteria:{a:{meaning:"First"},b:{meaning:"Second"}}}}});
  expect(body.questions.route.instructions).toEqual({question:"Which fits?"});
  expect(authorization).toBe("Bearer test-key");expect(result.answers.route.confidence).toBe(.25);
});

test("JEV_BASE_URL points the client at another System One server", async () => {
  const urls:string[]=[];
  const transport = (async (url:any) => {urls.push(String(url));return new Response(JSON.stringify({model:"m",answers:{ok:{type:"noul",noul:.9}},usage:{}}));}) as unknown as typeof fetch;
  const request={state:"x",questions:{ok:{type:"noul" as const,instructions:"Ok?"}}};
  const previous=process.env.JEV_BASE_URL;
  try {
    delete process.env.JEV_BASE_URL;
    await new JevClient({apiKey:"k",fetch:transport}).evaluate(request);
    process.env.JEV_BASE_URL="http://127.0.0.1:8080/v1";
    await new JevClient({apiKey:"k",fetch:transport}).evaluate(request);
    await new JevClient({apiKey:"k",fetch:transport,baseUrl:"http://explicit/v1"}).evaluate(request);
  } finally { if(previous===undefined)delete process.env.JEV_BASE_URL; else process.env.JEV_BASE_URL=previous; }
  expect(urls).toEqual(["https://api.typesafe.ai/v1/systemone","http://127.0.0.1:8080/v1/systemone","http://explicit/v1/systemone"]);
});

test("malformed Jev answers cannot drive downstream execution", () => {
  const request={state:"x",questions:{route:{type:"choice",instructions:"Which?",criteria:{a:"A",b:"B"}}}};
  expect(()=>validateAnswer(request,{model:"x",answers:{route:{type:"choice",choice:"outside",confidence:1,probabilities:{a:.9,b:.1}}}})).toThrow("selected choice");
  expect(()=>validateAnswer(request,{model:"x",answers:{route:{type:"choice",choice:"a",confidence:1,probabilities:{a:1}}}})).toThrow("Incomplete distribution");
});

test("rounded distributions inside the tolerance are renormalized and rejections carry the payload", () => {
  const request={state:"x",questions:{colour:{type:"choice",instructions:"Which?",criteria:{a:"A",b:"B",c:"C",d:"D",e:"E",f:"F",g:"G",h:"H",i:"I"}}}};
  const rounded={model:"x",answers:{colour:{type:"choice",choice:"a",confidence:.9,probabilities:{a:.92,b:.01,c:0,d:.01,e:.02,f:0,g:0,h:.03,i:.02}}}}; // sums to 1.01
  expect(()=>validateAnswer(request,rounded)).not.toThrow();
  const values=Object.values(rounded.answers.colour.probabilities);
  expect(values.reduce((s,v)=>s+v,0)).toBeCloseTo(1,9);expect(rounded.answers.colour.choice).toBe("a");
  const broken={model:"x",answers:{colour:{type:"choice",choice:"a",confidence:.9,probabilities:{a:.5,b:.1,c:0,d:0,e:0,f:0,g:0,h:0,i:0}}}};
  try{validateAnswer(request,broken);throw new Error("expected rejection");}
  catch(error){expect(error).toBeInstanceOf(JevAnswerError);expect((error as Error).message).toContain("Unnormalized distribution for colour (sum 0.6000)");expect((error as JevAnswerError).payload).toBe(broken);}
});

test("the client retries a rejected answer once and then surfaces the payload", async () => {
  const bad={model:"x",answers:{route:{type:"choice",choice:"a",confidence:1,probabilities:{a:.6,b:.1}}}};
  const good={model:"x",answers:{route:{type:"choice",choice:"a",confidence:1,probabilities:{a:.9,b:.1}}}};
  const request={state:"x",questions:{route:{type:"choice",instructions:"Which?",criteria:{a:"A",b:"B"}}}};
  let calls=0;
  const flaky=(async()=>{calls++;return new Response(JSON.stringify(calls===1?bad:good));}) as unknown as typeof fetch;
  expect((await new JevClient({apiKey:"k",fetch:flaky}).evaluate(request)).answers.route.probabilities.a).toBe(.9);expect(calls).toBe(2);
  calls=0;
  const alwaysBad=(async()=>{calls++;return new Response(JSON.stringify(bad));}) as unknown as typeof fetch;
  await expect(new JevClient({apiKey:"k",fetch:alwaysBad}).evaluate(request)).rejects.toBeInstanceOf(JevAnswerError);expect(calls).toBe(2);
  calls=0;
  const serverError=(async()=>{calls++;return new Response("down",{status:503});}) as unknown as typeof fetch;
  await expect(new JevClient({apiKey:"k",fetch:serverError}).evaluate(request)).rejects.toThrow("Jev HTTP 503");expect(calls).toBe(2);
});
