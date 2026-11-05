/**
 * tests/llm.test.mjs —— 大脑接入层（lib/engine/llm.js）的单元测试
 *
 * 为什么这么测：
 *   llm.js 是"三条腿走路"的适配层（宿主模型 / 直连 OpenAI 兼容 / 本机 CLI），
 *   最容易出问题的地方全在"形状适配"和"降级链路"上，而不是真实模型聪不聪明。
 *   所以这里**一律不碰真模型**：宿主用假对象，直连用注入的假 fetch（和本地假服务），
 *   CLI 用注入的 runCli 缝——不联网、不烧额度、可在 CI 里反复跑。
 *
 * 覆盖点（对应 CONTRACTS 2.5）：
 *   1) 纯函数：normalizeUsage / extractJson / parseToolProtocol / parseSse / messagesToPrompt / normalizeCliOutput
 *   2) 各种返回形状抹平：契约形状 / OpenAI / AI SDK / Anthropic blocks / 纯文本
 *   3) 通道选择：resolveChain、brain.url 拼接、models() 去重
 *   4) 真实调用路径：host 载荷、api 载荷与鉴权、500 重试、400 去工具重试、SSE、api→cli 降级、全挂
 *   5) 文本工具协议兜底：正文里出现 <<<TOOL 时要被解析成 toolCalls
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBrain,
  normalizeCompletion,
  normalizeUsage,
  extractJson,
  parseToolProtocol,
  parseSse,
  resolveChain,
  messagesToPrompt,
  normalizeCliOutput,
  TOOL_PROTOCOL_PROMPT,
} from '../lib/engine/llm.js';
import { startOpenai } from './fixtures/fake-openai.mjs';

// ---------------------------------------------------------------------------
// 测试小工具：造假 Response / 假 fetch / 假宿主
// ---------------------------------------------------------------------------

/** 造一个最小的 Response 替身（apiCall 只用到 ok/status/headers.get/text）。 */
function jsonResponse(data, status = 200, ctype = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? ctype : null) },
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  };
}

/** 一个永远挂着、只对 abort 有反应的 fetch（验超时/取消不会把测试卡死）。 */
function hangingFetch() {
  return (url, init) =>
    new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
}

/** 记录每次请求，按队列返回预设响应；队列耗尽后重复最后一个。 */
function scriptedFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (typeof next === 'function') return next(url, init);
    return next;
  };
  fn.calls = calls;
  return fn;
}

/** 假的 OpenAI 非流式返回体。 */
function openaiBody(content, { model = 'fake-gpt', toolCalls = null } = {}) {
  const message = { role: 'assistant', content };
  if (toolCalls) message.tool_calls = toolCalls;
  return {
    id: 'chatcmpl-x',
    model,
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

/** 造一个只用于"最后一条腿"的 CLI 缝：失败时不该被调用。 */
function forbiddenCli() {
  let n = 0;
  const fn = async () => {
    n += 1;
    throw new Error('测试不该走到 CLI');
  };
  fn.count = () => n;
  return fn;
}

// ---------------------------------------------------------------------------
// 1) 纯函数
// ---------------------------------------------------------------------------

test('normalizeUsage：各家字段名都归一成 { in, out }', () => {
  assert.deepEqual(normalizeUsage(null), { in: 0, out: 0 });
  assert.deepEqual(normalizeUsage('x'), { in: 0, out: 0 });

  // OpenAI 风格
  assert.deepEqual(normalizeUsage({ prompt_tokens: 12, completion_tokens: 5 }), { in: 12, out: 5, total: 17 });
  // camelCase（AI SDK / dsh）
  assert.deepEqual(normalizeUsage({ inputTokens: 3, outputTokens: 4 }), { in: 3, out: 4, total: 7 });
  // 契约简写
  assert.deepEqual(normalizeUsage({ in: 1, out: 2 }), { in: 1, out: 2, total: 3 });
  // 字符串数字也要认（中转常见）
  assert.deepEqual(normalizeUsage({ prompt_tokens: '9', completion_tokens: '1' }), { in: 9, out: 1, total: 10 });
  // 费用与估算标记要带出来
  assert.deepEqual(normalizeUsage({ in: 1, out: 1, cost: 0.002, estimated: true }), { in: 1, out: 1, total: 2, cost: 0.002, estimated: true });
  // 全空时不硬塞 total（否则上层会以为"有用量")
  assert.deepEqual(normalizeUsage({}), { in: 0, out: 0 });
});

test('extractJson：围栏、正文夹带、对象/数组偏好', () => {
  assert.equal(extractJson(''), null);
  assert.equal(extractJson('这里没有任何 JSON'), null);

  // ```json 围栏
  assert.deepEqual(extractJson('好的，计划如下：\n```json\n{"tasks":[{"title":"a"}]}\n```\n以上。'), {
    tasks: [{ title: 'a' }],
  });

  // 无围栏，但正文里夹了一个对象
  assert.deepEqual(extractJson('先说结论 {"ok":true} 再说别的'), { ok: true });

  // 数组优先
  assert.deepEqual(extractJson('任务：[{"id":"t1"},{"id":"t2"}]', { prefer: 'array' }), [{ id: 't1' }, { id: 't2' }]);

  // 字符串里的括号不能把配平搞坏（这里故意把 } 放进字符串）
  assert.deepEqual(extractJson('xx {"a":"}","b":"[1,2]"} yy'), { a: '}', b: '[1,2]' });

  // 先给一个残缺对象再给一个完整对象：要能跳过残缺的
  assert.deepEqual(extractJson('{"a": 坏的} {"b": 1}'), { b: 1 });
});

test('parseToolProtocol：<<<TOOL...TOOL>>> 要解析成 toolCalls 并从正文里剔掉', () => {
  const text = [
    '我先把文件读一下。',
    '<<<TOOL{"name":"fs_read","args":{"path":"a.txt"}}TOOL>>>',
    '',
    '',
    '',
    '然后再总结。',
  ].join('\n');
  const out = parseToolProtocol(text);
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].name, 'fs_read');
  assert.deepEqual(out.toolCalls[0].args, { path: 'a.txt' });
  assert.ok(!out.content.includes('<<<TOOL'), '正文里不该再残留标记');
  assert.ok(!out.content.includes('TOOL>>>'));
  assert.ok(out.content.includes('我先把文件读一下'));
  assert.ok(!/\n{3,}/.test(out.content), '空行要压掉');

  // 兼容 {tool:..., arguments:"json 字符串"} 和 function.name 两种写法
  const alt = parseToolProtocol('<<<TOOL{"tool":"shell","arguments":"{\\"command\\":\\"ls\\"}"}TOOL>>>');
  assert.equal(alt.toolCalls[0].name, 'shell');
  assert.deepEqual(alt.toolCalls[0].args, { command: 'ls' });

  const fn = parseToolProtocol('<<<TOOL{"function":{"name":"fs_list","arguments":{"path":"."}}}TOOL>>>');
  assert.equal(fn.toolCalls[0].name, 'fs_list');

  // 解析不出来时不许吞掉模型的话
  const broken = parseToolProtocol('<<<TOOL{这不是 JSON}TOOL>>>');
  assert.equal(broken.toolCalls.length, 0);
  assert.ok(broken.content.includes('这不是 JSON'));

  // 没有标记就原样返回
  const plain = parseToolProtocol('就是一段普通回答');
  assert.equal(plain.content, '就是一段普通回答');
  assert.deepEqual(plain.toolCalls, []);
});

test('parseSse：data 行聚合（正文 + 分片 tool_calls）', () => {
  const sse = [
    ': keep-alive',
    'data: {"choices":[{"delta":{"role":"assistant","content":"你好"}}]}',
    'data: {"choices":[{"delta":{"content":"，世界"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fs_read","arguments":"{\\"path\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}',
    'data: not-json-should-be-skipped',
    'data: [DONE]',
    '',
  ].join('\n');

  const raw = parseSse(sse);
  assert.ok(raw, 'SSE 应该能聚合出非空结果');
  assert.equal(raw.choices[0].message.content, '你好，世界');
  assert.equal(raw.choices[0].message.role, 'assistant');

  const norm = normalizeCompletion(raw);
  assert.equal(norm.content, '你好，世界');
  assert.equal(norm.toolCalls.length, 1);
  assert.equal(norm.toolCalls[0].name, 'fs_read');
  assert.deepEqual(norm.toolCalls[0].args, { path: 'a.txt' }, '分片 arguments 必须拼起来再解析');

  // 空流 / 只有 [DONE] → null（apiCall 靠它识别"空 SSE"）
  assert.equal(parseSse('data: [DONE]\n'), null);
  assert.equal(parseSse(''), null);
});

test('messagesToPrompt：CLI 模式要的中文分段 prompt', () => {
  const prompt = messagesToPrompt(
    [
      { role: 'system', content: '你是专家' },
      { role: 'user', content: '帮我看看' },
      { role: 'assistant', content: '好的' },
      { role: 'tool', content: '文件内容' },
    ],
    { system: '顶层系统指令' },
  );
  assert.ok(prompt.startsWith('【系统指令】\n顶层系统指令'));
  assert.ok(prompt.includes('【系统】\n你是专家'));
  assert.ok(prompt.includes('【用户】\n帮我看看'));
  assert.ok(prompt.includes('【助手】\n好的'));
  assert.ok(prompt.includes('【工具结果】\n文件内容'));
  assert.ok(prompt.trimEnd().endsWith('【要求】只输出最终答复正文。'));
});

test('normalizeCliOutput：从 CLI 的 stdout 里抽正文', () => {
  assert.equal(normalizeCliOutput(''), '');
  assert.equal(normalizeCliOutput('裸文本回答'), '裸文本回答');
  assert.equal(normalizeCliOutput(JSON.stringify({ result: 'claude 的答案' })), 'claude 的答案');
  assert.equal(normalizeCliOutput(JSON.stringify({ type: 'result', output: 'codex 的答案' })), 'codex 的答案');
  assert.equal(
    normalizeCliOutput(JSON.stringify({ messages: [{ text: '第一条' }, { text: '最后一条' }] })),
    '最后一条',
    'dsh 的 events 形状要取最后一条正文',
  );
  // 前面有日志、后面才是 JSON：保底返回原文，绝不返回空
  const noisy = '[claude-code:unrecognized_model] {}\n{"result":"真正的答案"}';
  assert.equal(normalizeCliOutput(noisy), noisy);
});

// ---------------------------------------------------------------------------
// 2) 返回形状抹平（normalizeCompletion）
// ---------------------------------------------------------------------------

test('normalizeCompletion：契约形状 / OpenAI / AI SDK / Anthropic / 纯文本', () => {
  // 契约形状（host 适配层直出）
  const contract = normalizeCompletion({
    content: '结论',
    toolCalls: [{ name: 'fs_list', args: { path: '.' }, id: 'c9' }],
    usage: { in: 2, out: 3 },
    model: 'm-contract',
  });
  assert.equal(contract.content, '结论');
  assert.equal(contract.toolCalls[0].name, 'fs_list');
  assert.equal(contract.toolCalls[0].id, 'c9');
  assert.deepEqual(contract.usage, { in: 2, out: 3, total: 5 });
  assert.equal(contract.model, 'm-contract');

  // OpenAI 形状（含老式 function_call 单函数）
  const oa = normalizeCompletion({
    model: 'gpt-x',
    choices: [{ message: { content: '正文', tool_calls: [{ id: 't', function: { name: 'shell', arguments: '{"command":"dir"}' } }] } }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  assert.equal(oa.content, '正文');
  assert.equal(oa.toolCalls[0].name, 'shell');
  assert.deepEqual(oa.toolCalls[0].args, { command: 'dir' });
  assert.equal(oa.model, 'gpt-x');

  const legacy = normalizeCompletion({ choices: [{ message: { content: null, function_call: { name: 'fs_read', arguments: '{"path":"a"}' } } }] });
  assert.equal(legacy.toolCalls[0].name, 'fs_read');
  assert.equal(legacy.content, '');

  // AI SDK / dsh 直出
  const ai = normalizeCompletion({ text: '答', toolCalls: [{ toolName: 'fs_grep', args: '{"pattern":"x"}' }], usage: { inputTokens: 4, outputTokens: 6 } });
  assert.equal(ai.content, '答');
  assert.equal(ai.toolCalls[0].name, 'fs_grep');
  assert.deepEqual(ai.toolCalls[0].args, { pattern: 'x' });
  assert.deepEqual(ai.usage, { in: 4, out: 6, total: 10 });

  // Anthropic content blocks
  const anth = normalizeCompletion({
    model: 'claude-x',
    content: [
      { type: 'text', text: '先看目录' },
      { type: 'tool_use', name: 'fs_list', input: { path: '.' }, id: 'tu1' },
    ],
    usage: { input_tokens: 5, output_tokens: 8 },
  });
  assert.equal(anth.content, '先看目录');
  assert.equal(anth.toolCalls[0].name, 'fs_list');
  assert.deepEqual(anth.toolCalls[0].args, { path: '.' });
  assert.deepEqual(anth.usage, { in: 5, out: 8, total: 13 });

  // 纯文本也给成契约形状，并带上估算用量
  const str = normalizeCompletion('只有正文');
  assert.equal(str.content, '只有正文');
  assert.deepEqual(str.toolCalls, []);
  assert.equal(str.usage.estimated, true);
  assert.equal(str.usage.in, 0);

  // null / 数字都不许炸
  assert.equal(normalizeCompletion(null).content, '');
  assert.equal(normalizeCompletion(42).content, '42');
});

// ---------------------------------------------------------------------------
// 3) 通道选择与元信息
// ---------------------------------------------------------------------------

test('resolveChain：能走哪几条腿、显式 mode 排最前但保留降级', () => {
  assert.deepEqual(resolveChain({}), ['cli'], '什么都没有时只剩本机 CLI');
  assert.deepEqual(resolveChain({ host: { chat: async () => '' } }), ['host', 'cli']);
  assert.deepEqual(resolveChain({ cfg: { baseUrl: 'http://x', model: 'm' } }), ['api', 'cli']);
  assert.deepEqual(
    resolveChain({ host: { chat: async () => '' }, cfg: { baseUrl: 'http://x', model: 'm' } }),
    ['host', 'api', 'cli'],
  );
  // 只配了 baseUrl 没配 model → api 不算可用（免得请求必然失败）
  assert.deepEqual(resolveChain({ cfg: { baseUrl: 'http://x' } }), ['cli']);
  // 显式 mode 提前，但不砍掉其它可用通道
  assert.deepEqual(
    resolveChain({ host: { chat: async () => '' }, cfg: { mode: 'api', baseUrl: 'http://x', model: 'm' } }),
    ['api', 'host', 'cli'],
  );
});

test('createBrain：url 拼接与 models() 去重', () => {
  const b1 = createBrain({ cfg: { baseUrl: 'http://x', model: 'm1' } });
  assert.equal(b1.url, 'http://x/v1/chat/completions');
  assert.equal(b1.mode, 'api');
  assert.deepEqual(b1.modes, ['api', 'cli']);
  assert.ok(b1.describe().includes('http://x/v1/chat/completions'));

  assert.equal(createBrain({ cfg: { baseUrl: 'http://x/v1', model: 'm' } }).url, 'http://x/v1/chat/completions');
  assert.equal(
    createBrain({ cfg: { baseUrl: 'http://x/v1/chat/completions', model: 'm' } }).url,
    'http://x/v1/chat/completions',
  );
  assert.equal(createBrain({ cfg: { baseUrl: 'http://x/v4beta', model: 'm' } }).url, 'http://x/v4beta/chat/completions');

  const host = { chat: async () => ({ content: '' }), models: () => ['host-a', 'host-b'] };
  const b2 = createBrain({ host, cfg: { models: ['cfg-a', 'host-a'], model: 'fallback-model' } });
  const list = b2.models();
  assert.deepEqual([...list].sort(), ['cfg-a', 'fallback-model', 'host-a', 'host-b']);
  assert.equal(new Set(list).size, list.length, '不能有重复模型');
  // models() 返回副本，外部改动不能污染缓存
  list.push('external');
  assert.ok(!b2.models().includes('external'));

  const b3 = createBrain({ cfg: { mode: 'cli', cliAgent: 'codex' } });
  assert.equal(b3.mode, 'cli');
  assert.ok(b3.models().includes('codex'));
  assert.ok(b3.describe().includes('codex'));
});

// ---------------------------------------------------------------------------
// 4) host 通道
// ---------------------------------------------------------------------------

test('host 通道：载荷形状正确 + 结果抹平', async () => {
  const seen = [];
  const host = {
    async chat(payload) {
      seen.push(payload);
      return { content: '宿主模型的回答', usage: { in: 3, out: 5 }, model: 'host-model' };
    },
  };
  const brain = createBrain({ host, cfg: { temperature: 0.3, maxTokens: 512 } });
  const res = await brain.chat({
    messages: [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '干活' },
    ],
    tools: [{ name: 'fs_read', description: '读文件', parameters: { type: 'object', properties: {} } }],
  });

  assert.equal(res.content, '宿主模型的回答');
  assert.equal(res.mode, 'host');
  assert.equal(res.model, 'host-model');
  assert.deepEqual(res.usage, { in: 3, out: 5, total: 8 });

  assert.equal(seen.length, 1);
  const payload = seen[0];
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[1].content, '干活');
  assert.equal(payload.tools[0].type, 'function');
  assert.equal(payload.tools[0].function.name, 'fs_read');
  assert.equal(payload.temperature, 0.3);
  assert.equal(payload.maxTokens, 512);
  // cfg 里没给 model 就不该硬塞一个空 model 字段
  assert.ok(!('model' in payload), '没有模型名时不要带 model 字段');
});

test('host 通道：不认 tools 时自动去掉工具、改用文本协议再问一次', async () => {
  const seen = [];
  const host = {
    async chat(payload) {
      seen.push(payload);
      if (payload.tools) throw new Error('this provider does not support tools');
      return { content: '我用文字回答' };
    },
  };
  const brain = createBrain({ host });
  const res = await brain.chat({
    messages: [{ role: 'user', content: '你好' }],
    tools: [{ name: 'fs_read', description: '读', parameters: { type: 'object' } }],
  });

  assert.equal(res.content, '我用文字回答');
  assert.equal(res.mode, 'host');
  assert.equal(seen.length, 2, '应该只重试一次');
  assert.equal(seen[1].tools, undefined, '第二次不能带 tools');
  assert.equal(seen[1].messages[0].role, 'system');
  assert.equal(seen[1].messages[0].content, TOOL_PROTOCOL_PROMPT);
});

test('host 通道：异步流（async iterable）要聚合成一段正文', async () => {
  const host = {
    async chat() {
      return (async function* stream() {
        yield { choices: [{ delta: { content: '流式' } }] };
        yield { choices: [{ delta: { content: '聚合' } }], usage: { prompt_tokens: 2, completion_tokens: 2 } };
      })();
    },
  };
  const brain = createBrain({ host });
  const res = await brain.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.content, '流式聚合');
  assert.deepEqual(res.usage, { in: 2, out: 2, total: 4 });
});

// ---------------------------------------------------------------------------
// 5) api 通道（注入假 fetch，绝不联网）
// ---------------------------------------------------------------------------

test('api 通道：请求体/鉴权/结果都对', async () => {
  const fetch = scriptedFetch([jsonResponse(openaiBody('直连的回答'))]);
  const brain = createBrain({
    cfg: {
      mode: 'api',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetch,
      temperature: 0.2,
      maxTokens: 256,
    },
  });

  const res = await brain.chat({
    messages: [{ role: 'user', content: '问一句' }],
    tools: [{ name: 'shell', description: '跑命令', parameters: { type: 'object', properties: {} } }],
  });

  assert.equal(res.content, '直连的回答');
  assert.equal(res.mode, 'api');
  assert.equal(res.model, 'fake-gpt', '模型名优先取响应里的');
  assert.deepEqual(res.usage, { in: 11, out: 7, total: 18 });

  assert.equal(fetch.calls.length, 1);
  const { url, init, body } = fetch.calls[0];
  assert.equal(url, 'http://127.0.0.1:1/v1/chat/completions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer sk-test');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 256);
  assert.equal(body.tools[0].function.name, 'shell');
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.messages[0].content, '问一句');
});

test('api 通道：500 会重试一次（可配置零延迟）', async () => {
  const fetch = scriptedFetch([
    jsonResponse({ error: 'boom' }, 500),
    jsonResponse(openaiBody('第二次成功')),
  ]);
  const brain = createBrain({
    cfg: { mode: 'api', baseUrl: 'http://h/v1', model: 'm', fetch, retryDelayMs: 0 },
  });
  const res = await brain.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.content, '第二次成功');
  assert.equal(fetch.calls.length, 2, '500 属于可恢复状态，应该重试一次');
});

test('api 通道：401 也重试一次，但最终失败时把状态码带出来', async () => {
  const fetch = scriptedFetch([jsonResponse({ error: 'invalid api key' }, 401)]);
  const forbidden = forbiddenCli();
  const brain = createBrain({
    cfg: { mode: 'api', baseUrl: 'http://h/v1', model: 'm', apiKey: 'bad', fetch, retryDelayMs: 0, runCli: forbidden },
  });
  await assert.rejects(
    () => brain.chat({ messages: [{ role: 'user', content: 'x' }] }),
    (err) => {
      assert.equal(err.code, 'all_modes_failed');
      assert.ok(err.message.includes('401'), `错误信息要带状态码：${err.message}`);
      return true;
    },
  );
  assert.equal(fetch.calls.length, 2);
  assert.ok(brain.lastError, 'lastError 要留给工具层如实汇报');
});

test('api 通道：400（不认 tools）要去掉工具用文本协议再问一次', async () => {
  const fetch = scriptedFetch([
    (url, init) => {
      const body = JSON.parse(init.body);
      // 第一次带 tools → 服务端拒绝
      if (body.tools) return jsonResponse({ error: { message: 'this model does not support function calling' } }, 400);
      return jsonResponse(openaiBody('用文本协议回答'));
    },
  ]);
  const brain = createBrain({
    cfg: { mode: 'api', baseUrl: 'http://h/v1', model: 'm', fetch, retryDelayMs: 0 },
  });
  const res = await brain.chat({
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 'fs_list', description: '列目录', parameters: { type: 'object' } }],
  });

  assert.equal(res.content, '用文本协议回答');
  assert.equal(fetch.calls.length, 2);
  assert.ok(!('tools' in fetch.calls[1].body), '第二次不能带 tools');
  assert.ok(!('tool_choice' in fetch.calls[1].body));
  assert.equal(fetch.calls[1].body.messages[0].content, TOOL_PROTOCOL_PROMPT);
});

test('api 通道：服务端无视 stream:false 照样吐 SSE 也能吃下', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"假的"}}]}',
    'data: {"choices":[{"delta":{"content":"流式"}}]}',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":6}}',
    'data: [DONE]',
    '',
  ].join('\n');
  const fetch = scriptedFetch([jsonResponse(sse, 200, 'text/event-stream')]);
  const brain = createBrain({ cfg: { mode: 'api', baseUrl: 'http://h/v1', model: 'm', fetch } });
  const res = await brain.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.content, '假的流式');
  assert.deepEqual(res.usage, { in: 5, out: 6, total: 11 });
});

test('api 通道：正文不是 JSON 时靠 extractJson 抠出来', async () => {
  const fetch = scriptedFetch([jsonResponse('好的，结果如下：\n```json\n' + JSON.stringify(openaiBody('抠出来的')) + '\n```')]);
  const brain = createBrain({ cfg: { mode: 'api', baseUrl: 'http://h/v1', model: 'm', fetch } });
  const res = await brain.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.content, '抠出来的');
});

test('api 通道：超时/取消不会卡死，会按链路降级到 CLI', async () => {
  let cliCalled = 0;
  const brain = createBrain({
    cfg: {
      mode: 'api',
      baseUrl: 'http://h/v1',
      model: 'm',
      fetch: hangingFetch(),
      timeoutMs: 20,
      retryDelayMs: 0,
      runCli: async () => {
        cliCalled += 1;
        return { out: 'CLI 兜底的回答' };
      },
    },
  });
  const res = await brain.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.content, 'CLI 兜底的回答');
  assert.equal(res.mode, 'cli');
  assert.equal(cliCalled, 1);
});

// ---------------------------------------------------------------------------
// 6) CLI 通道 + 全挂
// ---------------------------------------------------------------------------

test('cli 通道：prompt 拼接、agent 透传、usage 归一', async () => {
  const seen = [];
  const brain = createBrain({
    cfg: {
      mode: 'cli',
      cliAgent: 'codex',
      cwd: process.cwd(),
      runCli: async (opts) => {
        seen.push(opts);
        return { out: JSON.stringify({ result: 'CLI 的结论', usage: { input_tokens: 3, output_tokens: 4 } }) , usage: { input_tokens: 3, output_tokens: 4 } };
      },
    },
  });

  const res = await brain.chat({
    messages: [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '任务' },
    ],
    tools: [{ name: 'fs_read', description: '读', parameters: { type: 'object' } }],
  });

  assert.equal(res.content, 'CLI 的结论');
  assert.equal(res.mode, 'cli');
  assert.equal(res.model, 'cli:codex');
  assert.deepEqual(res.usage, { in: 3, out: 4, total: 7 });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].agent, 'codex');
  assert.ok(seen[0].prompt.includes('【系统指令】'));
  assert.ok(seen[0].prompt.includes('【用户】\n任务'));
  // CLI 不能调工具，所以必须把文本协议说明塞进 prompt（且只塞一次）
  const hits = seen[0].prompt.split('<<<TOOL').length - 1;
  assert.ok(hits >= 1, 'CLI 模式必须带上文本工具协议说明');
});

test('cli 通道：runCli 只给字符串也能用', async () => {
  const brain = createBrain({ cfg: { mode: 'cli', cliAgent: 'claude', runCli: async () => '纯文本 CLI 回答' } });
  const res = await brain.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.content, '纯文本 CLI 回答');
});

test('所有通道全挂：抛 all_modes_failed，并且不重复刷底层错误', async () => {
  const brain = createBrain({
    cfg: {
      mode: 'cli',
      runCli: async () => {
        throw new Error('CLI 不在 PATH 上');
      },
    },
  });
  await assert.rejects(
    () => brain.chat({ messages: [{ role: 'user', content: 'x' }] }),
    (err) => {
      assert.equal(err.name, 'BrainError');
      assert.equal(err.code, 'all_modes_failed');
      assert.equal(err.retryable, false);
      assert.ok(err.message.startsWith('所有模型通道都不可用'), err.message);
      assert.ok(err.message.includes('CLI 不在 PATH 上'), '要带上底层原因，方便用户自查');
      return true;
    },
  );
});

test('用户主动取消后不再换通道（不白烧 CLI 额度）', async () => {
  const forbidden = forbiddenCli();
  const fetch = scriptedFetch([jsonResponse({ error: 'boom' }, 500)]);
  const ctrl = new AbortController();
  ctrl.abort();

  const brain = createBrain({
    cfg: { mode: 'api', baseUrl: 'http://h/v1', model: 'm', fetch, retryDelayMs: 0, runCli: forbidden },
  });
  await assert.rejects(() => brain.chat({ messages: [{ role: 'user', content: 'x' }], signal: ctrl.signal }));
  assert.equal(forbidden.count(), 0, '取消之后不该再调用本机 CLI');
});

// ---------------------------------------------------------------------------
// 7) 文本工具协议兜底（CLI / 不认 tools 的模型靠它活命）
// ---------------------------------------------------------------------------

test('正文里出现 <<<TOOL 时，无论哪条通道都要解析成 toolCalls', async () => {
  const content = '我读一下文件。\n<<<TOOL{"name":"fs_read","args":{"path":"a.txt"}}TOOL>>>';
  // 走 api：返回的 message.content 里带协议标记
  const fetch = scriptedFetch([jsonResponse(openaiBody(content))]);
  const brain = createBrain({ cfg: { mode: 'api', baseUrl: 'http://h/v1', model: 'm', fetch } });
  const res = await brain.chat({ messages: [{ role: 'user', content: 'x' }] });

  assert.equal(res.mode, 'api');
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, 'fs_read');
  assert.deepEqual(res.toolCalls[0].args, { path: 'a.txt' });
  assert.ok(!res.content.includes('<<<TOOL'), '标记要从正文里剔除');

  // 走 cli：runCli 吐出带标记的文本
  const cliBrain = createBrain({ cfg: { mode: 'cli', runCli: async () => ({ out: content }) } });
  const cliRes = await cliBrain.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(cliRes.toolCalls.length, 1);
  assert.equal(cliRes.toolCalls[0].name, 'fs_read');
});

// ---------------------------------------------------------------------------
// 8) 对着本地假 OpenAI 服务跑一遍真实 HTTP（仍然不联网、不用真模型）
// ---------------------------------------------------------------------------

test('真实 HTTP：假 OpenAI 服务（JSON 模式）端到端可用', async (t) => {
  const srv = await startOpenai({ model: 'fake-gpt', reply: '假服务的中文回答' });
  t.after(() => srv.close());

  const brain = createBrain({
    cfg: { mode: 'api', baseUrl: srv.url, apiKey: 'sk-fake', model: 'fake-gpt', retryDelayMs: 0 },
  });
  const res = await brain.chat({ messages: [{ role: 'user', content: '你好' }] });

  assert.equal(res.content, '假服务的中文回答');
  assert.equal(res.mode, 'api');
  assert.equal(srv.requests.length, 1);
  assert.equal(srv.requests[0].path, '/v1/chat/completions');
  assert.match(srv.requests[0].headers.authorization || '', /^Bearer sk-fake$/);
  assert.equal(JSON.parse(srv.requests[0].body).model, 'fake-gpt');
});

test('真实 HTTP：假 OpenAI 服务（SSE 模式）也能吃下', async (t) => {
  const srv = await startOpenai({ sse: true });
  t.after(() => srv.close());

  const brain = createBrain({ cfg: { mode: 'api', baseUrl: srv.url, model: 'fake-gpt', retryDelayMs: 0 } });
  const res = await brain.chat({ messages: [{ role: 'user', content: '你好' }] });
  assert.equal(res.content, '假的流式回答');
  assert.deepEqual(res.usage, { in: 5, out: 6, total: 11 });
});

test('真实 HTTP：鉴权失败要能翻译成人话并降级', async (t) => {
  const srv = await startOpenai({ requireKey: 'sk-right' });
  t.after(() => srv.close());

  const brain = createBrain({
    cfg: {
      mode: 'api',
      baseUrl: srv.url,
      model: 'fake-gpt',
      apiKey: 'sk-wrong',
      retryDelayMs: 0,
      runCli: async () => ({ out: JSON.stringify({ result: 'CLI 接手了' }) }),
    },
  });
  const res = await brain.chat({ messages: [{ role: 'user', content: '你好' }] });
  assert.equal(res.mode, 'cli');
  assert.equal(res.content, 'CLI 接手了');
});
