/** Task-only prompts. Expected results and behavior checks never enter the task workspace. */
export interface PlannerCase {
  name: string;
  prompt: string;
  files: Record<string, string>;
  expected: Record<string, unknown>;
  semantic?: boolean;
  replay?: boolean;
}

const deterministic = {
  prompt: "Use cached.json if it exists; otherwise sum the numbers in input.json. Write result.json as {\"total\": NUMBER}. Then report the total.",
  files: { "input.json": "[2,3,7]" },
};

export const plannerCases: PlannerCase[] = [
  {
    name: "independent-inputs",
    prompt: "Read alpha.json, beta.json, and gamma.json. Write totals.json with the sum of each file's numbers, using keys alpha, beta, and gamma. Report the three totals.",
    files: { "alpha.json": "[1,2,3]", "beta.json": "[10,20]", "gamma.json": "[-4,8]" },
    expected: { "totals.json": { alpha: 6, beta: 30, gamma: 4 } },
  },
  { name: "deterministic-missing", ...deterministic, expected: { "result.json": { total: 12 } } },
  { name: "deterministic-present", ...deterministic, files: { ...deterministic.files, "cached.json": '{"total":99}' }, expected: { "result.json": { total: 99 } } },
  {
    name: "semantic-batch", semantic: true,
    prompt: "Read messages.json. Classify each support message as billing (payments, invoices, refunds), technical (product errors or broken features), or review (unclear or neither). For each message, write its original text to work/CATEGORY/ID.txt. Write routes.json mapping message IDs to categories and report category counts. Deliver a workflow that can reproduce these outputs from the input file.",
    files: { "messages.json": JSON.stringify([
      { id: "a", text: "I paid twice for one subscription. Can you reverse the duplicate charge?" },
      { id: "b", text: "The export button crashes the app every time I click it." },
      { id: "c", text: "Please send last month's invoice for our accounting records." },
      { id: "d", text: "The dashboard displays a blank screen after sign-in." },
      { id: "e", text: "I'd like to discuss a possible partnership." },
      { id: "f", text: "Could someone help? I don't know what to ask yet." },
    ]) },
    expected: { "routes.json": { a: "billing", b: "technical", c: "billing", d: "technical", e: "review", f: "review" } },
  },
  {
    name: "saved-file", replay: true,
    prompt: "Run workflow.json unchanged and confirm the contents of result.json.",
    files: { "workflow.json": JSON.stringify({ version: 1, label: "Saved workflow", nodes: { write: { type: "bash", script: "printf '%s' '{\"total\":42}' > result.json" } }, returns: ["write"] }) },
    expected: { "result.json": { total: 42 } },
  },
];
