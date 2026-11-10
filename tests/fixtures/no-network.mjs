/**
 * tests/fixtures/no-network.mjs —— 把"外网"从这台机器上拔掉。
 *
 * 用法：node --import ./tests/fixtures/no-network.mjs bin/nexi.mjs mcp
 * 之后任何 DNS 解析、任何非回环 socket、任何 fetch 都会当场抛错。
 * 这样"插件不依赖网络"就不是一句声明，而是一次会红的实验：
 * 只要启动路径里偷偷发了一个请求，测试立刻失败。
 */

import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0', '', undefined, null]);

function hostOf(args) {
  const first = args[0];
  if (typeof first === 'object' && first !== null) return first.host ?? first.path ?? null;
  if (typeof first === 'string' && !/^\d+$/.test(first)) return first; // unix socket path 也放行
  // connect(port, host)
  return args[1];
}

function guard(kind) {
  return function blocked(...args) {
    const host = hostOf(args);
    if (LOOPBACK.has(host) || (typeof host === 'string' && host.startsWith('/'))) {
      return kind === 'connect' ? connectOrig.apply(this, args) : requestOrig.apply(this, args);
    }
    throw new Error(`OFFLINE-TEST: 试图连网（${kind} → ${host}）`);
  };
}

const connectOrig = net.Socket.prototype.connect;
const requestOrig = http.request;
const httpsRequestOrig = https.request;

net.Socket.prototype.connect = function patchedConnect(...args) {
  const host = hostOf(args);
  if (LOOPBACK.has(host) || (typeof host === 'string' && host.startsWith('/'))) {
    return connectOrig.apply(this, args);
  }
  throw new Error(`OFFLINE-TEST: 试图连网（socket → ${host}）`);
};

net.connect = net.createConnection = function patchedNetConnect(...args) {
  const host = hostOf(args);
  if (LOOPBACK.has(host) || (typeof host === 'string' && host.startsWith('/'))) {
    return connectOrig.apply(new net.Socket(), args);
  }
  throw new Error(`OFFLINE-TEST: 试图连网（net.connect → ${host}）`);
};

http.request = guard('http');
https.request = function patchedHttps(...args) {
  void httpsRequestOrig;
  return guard('https').apply(this, args);
};

const failLookup = (hostname) => {
  throw new Error(`OFFLINE-TEST: 试图解析域名（${hostname}）`);
};
dns.lookup = (hostname, ...rest) => failLookup(hostname, ...rest);
if (dns.promises) dns.promises.lookup = async (hostname) => failLookup(hostname);
dns.resolve = (hostname) => failLookup(hostname);

globalThis.fetch = async (url) => {
  throw new Error(`OFFLINE-TEST: 试图 fetch（${typeof url === 'string' ? url : url?.url}）`);
};

process.env.NEXI_OFFLINE_TEST = '1';
