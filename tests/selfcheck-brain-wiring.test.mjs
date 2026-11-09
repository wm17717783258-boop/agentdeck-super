/**
 * 入口级回归：插件配置里的 llm.baseUrl/model 必须真的送到大脑。
 *
 * 以前 makeBrain() 把整份 cfg 直接交给 createBrain()，而 createBrain()
 * 认的是扁平的 baseUrl/model，结果宿主里配了 OpenAI 兼容通道，super_agent
 * 却一次 HTTP 请求都不发，只回一句“未完全完成”。这条测试专门钉住入口接线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHub } from '../lib/hub.js';

function text(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((b) => (typeof b?.text === 'string' ? b.text : JSON.stringify(b)))
    .join('\n');
}

test('config.llm 的 API 通道真的被 super_agent 用上', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexi-brain-wire-'));
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      requests.push({ url: req.url, auth: req.headers.authorization || '', body });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'chatcmpl-brain-wire',
        object: 'chat.completion',
        model: 'fake-brain',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '大脑接线正常，收到目标。', tool_calls: [] },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      }));
    });
  });

  let hub = null;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    hub = await createHub({
      workspace: root,
      boardRoot: root,
      licenseRoot: root,
      config: {
        automation: { enabled: false },
        llm: {
          mode: 'api',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'brain-wire-token',
          model: 'fake-brain',
        },
      },
      onLog: () => {},
    });

    const out = text(await hub.call('super_agent', { goal: '验证入口模型通道', maxSteps: 1 }));
    assert.match(out, /【super_agent】✅ 已完成/, out.slice(0, 300));
    assert.match(out, /大脑接线正常/);
    assert.equal(requests.length, 1, `应只发一次模型请求，实际 ${requests.length} 次`);
    assert.equal(requests[0].url, '/v1/chat/completions');
    assert.equal(requests[0].auth, 'Bearer brain-wire-token');
    assert.equal(requests[0].body.model, 'fake-brain');
  } finally {
    if (hub) await hub.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
