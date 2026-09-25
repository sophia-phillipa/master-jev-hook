#!/usr/bin/env node
// Minimal stdio MCP adapter: no inference here, just named tools for our HTTP gateway.
import { createInterface } from "node:readline";
const endpoint = new URL(process.env.MASTER_JEV_GATEWAY_URL ?? "http://127.0.0.1:8795");
if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("Invalid gateway URL");
const item = { type: "object", additionalProperties: false, required: ["id", "text"], properties: { id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" }, text: { type: "string", minLength: 1, maxLength: 8000 } } };
const text8000 = { type: "string", minLength: 1, maxLength: 8000 };

// --- Argument validation shared by the /master/decide-backed tools. Every check here runs
// locally, before any network call, so malformed arguments never reach the gateway. ---
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (x) => typeof x === "string" && idPattern.test(x);
const isText = (x, max = 8000) => typeof x === "string" && x.length >= 1 && x.length <= max;
const isPlainObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const onlyKeys = (obj, keys) => isPlainObject(obj) && Object.keys(obj).every((k) => keys.includes(k));
// Riscos da ação que a resposta vai orientar; o gateway aplica limiares crescentes (0,65/0,80/0,90).
const RISCOS = { baixo: "low", medio: "medium", alto: "high" };
const risco = { type: "string", enum: Object.keys(RISCOS), description: "Risco da ação que a resposta vai orientar: baixo (leitura, triagem), medio (mudança de código reversível), alto (irreversível, externo, segurança). Define a confiança mínima exigida." };
function withRisk(body, args) {
  if (args.risco === undefined) return body;
  if (!Object.hasOwn(RISCOS, args.risco)) invalid("Invalid risco: expected baixo, medio or alto");
  return { ...body, risk: RISCOS[args.risco] };
}
function invalid(message) { const e = new Error(message); e.code = -32602; throw e; }
function parseItem(x) {
  if (!isPlainObject(x) || Object.keys(x).length !== 2 || !isId(x.id) || !isText(x.text)) invalid("Invalid item: expected { id, text }");
  return x;
}
function parseItems(arr, min, max) {
  if (!Array.isArray(arr) || arr.length < min || arr.length > max) invalid(`Invalid item list: expected between ${min} and ${max} entries`);
  arr.forEach(parseItem);
  const ids = arr.map((x) => x.id);
  if (new Set(ids).size !== ids.length) invalid("Duplicate item ids");
  return arr;
}

function buildClassificar(args) {
  if (!onlyKeys(args, ["finalidade", "categorias", "itens", "risco"])) invalid("Invalid arguments for jev_classificar");
  if (args.finalidade !== undefined && !isText(args.finalidade)) invalid("Invalid finalidade");
  const categorias = parseItems(args.categorias, 2, 64);
  const itens = parseItems(args.itens, 1, 32);
  const criteria = Object.fromEntries(categorias.map((c) => [c.id, c.text]));
  const questions = Object.fromEntries(itens.map((it) => [it.id, {
    type: "choice",
    instructions: `Classify the item in \`itens.${it.id}\` into the best-fitting category.` + (args.finalidade !== undefined ? ` Purpose (see \`finalidade\`): ${args.finalidade}.` : ""),
    criteria,
  }]));
  const state = { ...(args.finalidade !== undefined ? { finalidade: args.finalidade } : {}), itens: Object.fromEntries(itens.map((it) => [it.id, it.text])) };
  return withRisk({ state, questions }, args);
}

function buildVerificar(args) {
  if (!onlyKeys(args, ["pergunta", "estado", "criterios", "risco"])) invalid("Invalid arguments for jev_verificar");
  if (!isText(args.pergunta)) invalid("Invalid pergunta");
  if (!isText(args.estado)) invalid("Invalid estado");
  let criteria;
  if (args.criterios !== undefined) {
    if (!isPlainObject(args.criterios) || Object.keys(args.criterios).length !== 2 || !isText(args.criterios.true) || !isText(args.criterios.false)) invalid("Invalid criterios: expected { true, false }");
    criteria = { true: args.criterios.true, false: args.criterios.false };
  }
  return withRisk({ state: args.estado, questions: { verificacao: { type: "noul", instructions: args.pergunta, ...(criteria ? { criteria } : {}) } } }, args);
}

function buildPontuar(args) {
  if (!onlyKeys(args, ["estado", "criterios", "pesos", "risco"])) invalid("Invalid arguments for jev_pontuar");
  if (!isText(args.estado)) invalid("Invalid estado");
  if (!Array.isArray(args.criterios) || args.criterios.length < 1 || args.criterios.length > 32) invalid("Invalid criterios: expected between 1 and 32 entries");
  const ids = [];
  const questions = {};
  for (const c of args.criterios) {
    if (!isPlainObject(c) || Object.keys(c).length !== 3 || !isId(c.id) || !isText(c.pergunta) || !Array.isArray(c.niveis) || c.niveis.length < 2 || c.niveis.length > 10 || !c.niveis.every((n) => isText(n))) invalid("Invalid criterio: expected { id, pergunta, niveis }");
    if (ids.includes(c.id)) invalid("Duplicate criterio id");
    ids.push(c.id);
    questions[c.id] = { type: "score", instructions: c.pergunta, criteria: c.niveis };
  }
  let composite;
  if (args.pesos !== undefined) {
    if (!isPlainObject(args.pesos) || Object.keys(args.pesos).length === 0) invalid("Invalid pesos");
    for (const [k, v] of Object.entries(args.pesos)) {
      if (!ids.includes(k)) invalid(`Peso references unknown criterio id "${k}"`);
      if (typeof v !== "number" || !Number.isFinite(v)) invalid("Invalid peso value");
    }
    composite = args.pesos;
  }
  return withRisk({ state: args.estado, questions, ...(composite ? { composite } : {}) }, args);
}

// Perguntas em inglês (idioma em que o jev-1.13 é mais preciso), citando campos do state pelo nome.
const DEFAULT_NIVEIS = ["Does not meet the criterion", "Weak fit", "Adequate fit", "Good fit", "Excellent fit"];
function buildRanquear(args) {
  if (!onlyKeys(args, ["criterio", "candidatos", "niveis", "risco"])) invalid("Invalid arguments for jev_ranquear");
  if (!isText(args.criterio)) invalid("Invalid criterio");
  const candidatos = parseItems(args.candidatos, 2, 32);
  let niveis = DEFAULT_NIVEIS;
  if (args.niveis !== undefined) {
    if (!Array.isArray(args.niveis) || args.niveis.length < 2 || args.niveis.length > 10 || !args.niveis.every((n) => isText(n))) invalid("Invalid niveis");
    niveis = args.niveis;
  }
  const state = { criterio: args.criterio, candidatos: Object.fromEntries(candidatos.map((c) => [c.id, c.text])) };
  const questions = Object.fromEntries(candidatos.map((c) => [c.id, {
    type: "score",
    instructions: `How well does the candidate in \`candidatos.${c.id}\` meet the criterion in \`criterio\`?`,
    criteria: niveis,
  }]));
  return withRisk({ state, questions }, args);
}
function rankResult(result, args) {
  if (!isPlainObject(result)) return result;
  const order = args.candidatos.map((c) => c.id);
  const answers = isPlainObject(result.answers) ? result.answers : {};
  const ranking = order
    .filter((id) => answers[id]?.status === "ok" && typeof answers[id].score === "number")
    .sort((a, b) => answers[b].score - answers[a].score);
  return { ...result, ranking };
}

const tools = [
  {
    name: "solicitar_decisao",
    description: "Pede ao gateway Master-JEV Hook uma escolha entre alternativas reais, avaliação lógica ou apoio em evidências. Envie objetivo, critério e dados; o gateway monta a consulta. Resultado não concede permissões nem comprova verdade factual.",
    inputSchema: { type: "object", additionalProperties: false, required: ["objective", "context"], properties: {
      objective: text8000,
      context: { type: "object", additionalProperties: false, required: ["kind"], properties: {
        kind: { type: "string", enum: ["argumentation", "comparison", "factual", "planning"] },
        criterion: text8000, claim: text8000,
        candidates: { type: "array", minItems: 2, maxItems: 32, items: item },
        evidence: { type: "array", maxItems: 32, items: item },
        risk: { type: "string", enum: ["low", "medium", "high"], description: "Risco da ação decidida: low (0,65), medium (0,80) ou high (0,90) de confiança mínima." },
      } },
    } },
    path: "/master/context",
    build: (args) => args,
  },
  {
    name: "jev_classificar",
    description: "Pede ao JEV para classificar cada item na categoria mais adequada, via /master/decide (limiar de confiança 0,65; abaixo disso o item fica sem categoria).",
    inputSchema: { type: "object", additionalProperties: false, required: ["categorias", "itens"], properties: {
      finalidade: text8000,
      categorias: { type: "array", minItems: 2, maxItems: 64, items: item },
      itens: { type: "array", minItems: 1, maxItems: 32, items: item },
      risco,
    } },
    path: "/master/decide",
    build: buildClassificar,
  },
  {
    name: "jev_verificar",
    description: "Pede ao JEV uma verificação booleana sobre o estado informado, via /master/decide. O Noul devolvido é a probabilidade estimada de \"sim\", não uma confiança.",
    inputSchema: { type: "object", additionalProperties: false, required: ["pergunta", "estado"], properties: {
      pergunta: text8000,
      estado: text8000,
      criterios: { type: "object", additionalProperties: false, required: ["true", "false"], properties: { true: text8000, false: text8000 } },
      risco,
    } },
    path: "/master/decide",
    build: buildVerificar,
  },
  {
    name: "jev_pontuar",
    description: "Pede ao JEV para pontuar um ou mais critérios sobre o estado informado, via /master/decide (limiar de confiança 0,65); com pesos, o gateway também calcula um valor composto.",
    inputSchema: { type: "object", additionalProperties: false, required: ["estado", "criterios"], properties: {
      estado: text8000,
      criterios: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["id", "pergunta", "niveis"], properties: {
        id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" }, pergunta: text8000,
        niveis: { type: "array", minItems: 2, maxItems: 10, items: text8000 },
      } } },
      pesos: { type: "object" },
      risco,
    } },
    path: "/master/decide",
    build: buildPontuar,
  },
  {
    name: "jev_ranquear",
    description: "Pede ao JEV para pontuar candidatos segundo um critério, via /master/decide (limiar de confiança 0,65), e devolve também um campo ranking com os candidatos aceitos ordenados por score.",
    inputSchema: { type: "object", additionalProperties: false, required: ["criterio", "candidatos"], properties: {
      criterio: text8000,
      candidatos: { type: "array", minItems: 2, maxItems: 32, items: item },
      niveis: { type: "array", minItems: 2, maxItems: 10, items: text8000 },
      risco,
    } },
    path: "/master/decide",
    build: buildRanquear,
    postprocess: rankResult,
  },
];

// Standard MCP guidance, including for clients without CLAUDE.md/SessionStart hooks.
const instructions = "Havendo alternativas explícitas elegíveis, consulte o JEV antes de decidir: solicitar_decisao (objective + context com candidates, criterion, evidence) ou, para lotes, jev_classificar, jev_verificar, jev_pontuar e jev_ranquear. State enxuto, sem segredos; perguntas independentes numa só chamada. Informe o risco da ação (risco/risk): o gateway exige confiança 0,65 (baixo), 0,80 (médio) ou 0,90 (alto) em Choice/Score; Noul é probabilidade de sim, não confiança. Abstenção ou erro: alternativa local sem retry. Avise com uma linha 🔷 antes e depois de cada consulta. O resultado não executa ações nem concede permissões.";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const error = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let message;
  try { if (Buffer.byteLength(line) > 65536) throw new Error(); message = JSON.parse(line); }
  catch { error(null, -32700, "Invalid JSON request"); continue; }
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") { error(message?.id ?? null, -32600, "Invalid request"); continue; }
  if (message.id === undefined) continue;
  if (message.method === "initialize") {
    const supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
    reply(message.id, { protocolVersion: supported.includes(message.params?.protocolVersion) ? message.params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, instructions, serverInfo: { name: "master-jev-hook", version: "0.1.0" } });
  } else if (message.method === "ping") reply(message.id, {});
  else if (message.method === "tools/list") reply(message.id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  else if (message.method === "tools/call") {
    const toolDef = tools.find((t) => t.name === message.params?.name);
    if (!toolDef) { error(message.id, -32602, "Unknown tool"); continue; }
    let body;
    try { body = toolDef.build(message.params.arguments); }
    catch (e) { error(message.id, e.code ?? -32602, e.message || "Invalid arguments"); continue; }
    try {
      const res = await fetch(new URL(toolDef.path, endpoint), {
        method: "POST", headers: { "content-type": "application/json", ...(process.env.MASTER_JEV_GATEWAY_KEY ? { authorization: `Bearer ${process.env.MASTER_JEV_GATEWAY_KEY}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(17000),
      });
      let result = await res.json();
      if (toolDef.postprocess) result = toolDef.postprocess(result, message.params.arguments);
      reply(message.id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: !res.ok || result.status === "fallback" });
    } catch { reply(message.id, { content: [{ type: "text", text: "Gateway indisponível. Nenhuma decisão foi aplicada." }], isError: true }); }
  } else error(message.id, -32601, "Method not found");
}
