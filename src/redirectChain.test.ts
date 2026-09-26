import { describe, expect, it } from 'vitest';
import {
  MAX_REDIRECTS,
  followRedirects,
  redirectMethod,
} from './redirectChain';
import type { Rule } from './types';

function rule(partial: Partial<Rule> & { id: string }): Rule {
  return {
    name: partial.id,
    enabled: true,
    method: 'ANY',
    host: 'example.com',
    pathTemplate: '/',
    query: [],
    action: { type: 'rewrite', target: '/', status: 302 },
    ...partial,
  };
}

function redirect(
  id: string,
  host: string,
  pathTemplate: string,
  target: string,
  status: number,
  method: Rule['method'] = 'ANY',
): Rule {
  return rule({
    id,
    host,
    pathTemplate,
    method,
    action: { type: 'redirect', target, status },
  });
}

describe('redirectMethod', () => {
  it('301 / 302 仅将 POST 改为 GET，其余方法保持', () => {
    for (const status of [301, 302]) {
      expect(redirectMethod('POST', status)).toBe('GET');
      expect(redirectMethod('GET', status)).toBe('GET');
      expect(redirectMethod('PUT', status)).toBe('PUT');
      expect(redirectMethod('PATCH', status)).toBe('PATCH');
      expect(redirectMethod('DELETE', status)).toBe('DELETE');
      expect(redirectMethod('HEAD', status)).toBe('HEAD');
      expect(redirectMethod('OPTIONS', status)).toBe('OPTIONS');
    }
  });

  it('303 除 HEAD 外一律改为 GET', () => {
    expect(redirectMethod('POST', 303)).toBe('GET');
    expect(redirectMethod('PUT', 303)).toBe('GET');
    expect(redirectMethod('PATCH', 303)).toBe('GET');
    expect(redirectMethod('DELETE', 303)).toBe('GET');
    expect(redirectMethod('OPTIONS', 303)).toBe('GET');
    expect(redirectMethod('GET', 303)).toBe('GET');
    expect(redirectMethod('HEAD', 303)).toBe('HEAD');
  });

  it('307 / 308 保持方法', () => {
    for (const status of [307, 308]) {
      expect(redirectMethod('POST', status)).toBe('POST');
      expect(redirectMethod('PUT', status)).toBe('PUT');
      expect(redirectMethod('DELETE', status)).toBe('DELETE');
      expect(redirectMethod('GET', status)).toBe('GET');
      expect(redirectMethod('HEAD', status)).toBe('HEAD');
    }
  });

  it('方法大小写不敏感', () => {
    expect(redirectMethod('post', 301)).toBe('GET');
    expect(redirectMethod('head', 303)).toBe('HEAD');
  });
});

describe('followRedirects · 跟随与方法改写', () => {
  it('301 把 POST 改写为 GET 后继续跟随，直到非重定向终止', () => {
    const rules = [
      redirect('r1', 'a.com', '/old', 'http://b.com/new', 301),
      // 仅 GET 命中：POST 若未被改写则不会走到这里
      redirect('r2', 'b.com', '/new', 'http://c.com/landing', 307, 'GET'),
    ];
    const chain = followRedirects(rules, 'POST', 'http://a.com/old');
    expect(chain.status).toBe('final');
    expect(chain.ok).toBe(true);
    expect(chain.hops).toHaveLength(2);
    expect(chain.hops[0]).toMatchObject({
      n: 1,
      method: 'POST',
      url: 'http://a.com/old',
      status: 301,
      location: 'http://b.com/new',
    });
    expect(chain.hops[1]).toMatchObject({
      n: 2,
      method: 'GET', // 301 改写
      url: 'http://b.com/new',
      status: 307,
      location: 'http://c.com/landing',
    });
    expect(chain.terminal).toMatchObject({
      method: 'GET', // 307 保持
      url: 'http://c.com/landing',
    });
    expect(chain.terminal?.sim.status).toBe('final');
  });

  it('302 对非 POST 方法不改写', () => {
    const rules = [
      redirect('r1', 'a.com', '/x', 'http://b.com/y', 302),
      // 仅 PUT 命中：验证 PUT 经 302 后保持
      redirect('r2', 'b.com', '/y', 'http://c.com/z', 307, 'PUT'),
    ];
    const chain = followRedirects(rules, 'PUT', 'http://a.com/x');
    expect(chain.status).toBe('final');
    expect(chain.hops).toHaveLength(2);
    expect(chain.hops[1].method).toBe('PUT');
    expect(chain.terminal?.method).toBe('PUT');
    expect(chain.terminal?.url).toBe('http://c.com/z');
  });

  it('303 把 POST 改为 GET（命中 GET 专属规则才继续）', () => {
    const rules = [
      redirect('r1', 'a.com', '/x', 'http://b.com/y', 303),
      redirect('r2', 'b.com', '/y', 'http://c.com/z', 308, 'GET'),
    ];
    const chain = followRedirects(rules, 'POST', 'http://a.com/x');
    expect(chain.status).toBe('final');
    expect(chain.hops.map((h) => h.method)).toEqual(['POST', 'GET']);
    expect(chain.terminal?.method).toBe('GET'); // 308 保持 GET
  });

  it('303 对 HEAD 保持 HEAD', () => {
    const rules = [
      redirect('r1', 'a.com', '/x', 'http://b.com/y', 303),
      // 仅 HEAD 命中：HEAD 若被改写为 GET 则不会命中
      redirect('r2', 'b.com', '/y', 'http://c.com/z', 307, 'HEAD'),
    ];
    const chain = followRedirects(rules, 'HEAD', 'http://a.com/x');
    expect(chain.status).toBe('final');
    expect(chain.hops.map((h) => h.method)).toEqual(['HEAD', 'HEAD']);
    expect(chain.terminal?.method).toBe('HEAD');
  });

  it('307 / 308 全程保持 POST', () => {
    const rules = [
      redirect('r1', 'a.com', '/x', 'http://b.com/y', 307),
      redirect('r2', 'b.com', '/y', 'http://c.com/z', 308, 'POST'),
    ];
    const chain = followRedirects(rules, 'POST', 'http://a.com/x');
    expect(chain.status).toBe('final');
    expect(chain.hops.map((h) => h.method)).toEqual(['POST', 'POST']);
    expect(chain.terminal?.method).toBe('POST');
  });

  it('每跳从首条规则重新模拟：入站 URL 先经内部重写再重定向', () => {
    const rules = [
      rule({
        id: 'rw',
        host: 'a.com',
        pathTemplate: '/old',
        action: { type: 'rewrite', target: '/new', status: 302 },
      }),
      redirect('red', 'a.com', '/new', 'http://b.com/final', 301),
    ];
    const chain = followRedirects(rules, 'GET', 'http://a.com/old');
    expect(chain.status).toBe('final');
    expect(chain.hops).toHaveLength(1);
    // 该跳的内部轨迹：重写步骤 + 重定向步骤
    expect(chain.hops[0].sim.steps).toHaveLength(2);
    expect(chain.hops[0].sim.steps[0].urlAfter).toBe('http://a.com/new');
    expect(chain.hops[0].sim.steps[1].status).toBe(301);
    expect(chain.hops[0].location).toBe('http://b.com/final');
  });

  it('Location 为相对路径时按当前 URL 解析为绝对地址', () => {
    const rules = [redirect('r1', 'a.com', '/x', '/y?from=a', 301)];
    const chain = followRedirects(rules, 'GET', 'http://a.com/x?q=1');
    expect(chain.hops[0].location).toBe('http://a.com/y?from=a');
    expect(chain.terminal?.url).toBe('http://a.com/y?from=a');
  });
});

describe('followRedirects · 终止条件', () => {
  it('首跳无规则命中：零跳直接结束（成功）', () => {
    const chain = followRedirects([], 'GET', 'http://a.com/anything');
    expect(chain.status).toBe('final');
    expect(chain.ok).toBe(true);
    expect(chain.hops).toHaveLength(0);
    expect(chain.terminal?.sim.status).toBe('final');
    expect(chain.terminal?.sim.finalUrl).toBe('http://a.com/anything');
  });

  it('被规则停止是非重定向终止（链正常结束）', () => {
    const rules = [
      rule({
        id: 'stop',
        host: 'a.com',
        pathTemplate: '/admin',
        action: { type: 'stop', target: '', status: 302 },
      }),
    ];
    const chain = followRedirects(rules, 'GET', 'http://a.com/admin');
    expect(chain.status).toBe('final');
    expect(chain.ok).toBe(true);
    expect(chain.terminal?.sim.status).toBe('stopped');
  });

  it('跨跳循环：入站「方法 + 序列化 URL」重复即判循环', () => {
    const rules = [
      redirect('r1', 'a.com', '/a', 'http://a.com/b', 301),
      redirect('r2', 'a.com', '/b', 'http://a.com/a', 302),
    ];
    const chain = followRedirects(rules, 'GET', 'http://a.com/a');
    expect(chain.status).toBe('loop');
    expect(chain.ok).toBe(false);
    expect(chain.hops).toHaveLength(2);
    expect(chain.terminal).toBeNull();
    expect(chain.reason).toContain('跨跳循环');
  });

  it('循环检测按序列化 URL 判定：http://a.com 与 http://a.com/ 视为同一状态', () => {
    const rules = [redirect('r1', 'a.com', '/', 'http://a.com', 301)];
    const chain = followRedirects(rules, 'GET', 'http://a.com');
    expect(chain.status).toBe('loop');
    expect(chain.hops).toHaveLength(1);
  });

  it('单跳内部的重写循环由引擎判失败，链以引擎失败终止', () => {
    const rules = [
      rule({
        id: 'l1',
        host: 'a.com',
        pathTemplate: '/a',
        action: { type: 'rewrite', target: '/b', status: 302 },
      }),
      rule({
        id: 'l2',
        host: 'a.com',
        pathTemplate: '/b',
        action: { type: 'rewrite', target: '/a', status: 302 },
      }),
    ];
    const chain = followRedirects(rules, 'GET', 'http://a.com/a');
    expect(chain.status).toBe('engine-error');
    expect(chain.ok).toBe(false);
    expect(chain.hops).toHaveLength(0);
    expect(chain.terminal?.sim.status).toBe('loop');
  });

  it('输入 URL 无法解析：引擎失败终止', () => {
    const chain = followRedirects([], 'GET', 'not a url');
    expect(chain.status).toBe('engine-error');
    expect(chain.ok).toBe(false);
    expect(chain.terminal?.sim.status).toBe('invalid-url');
  });
});

describe('followRedirects · 重定向次数上限', () => {
  /** 生成 n 条首尾相接的重定向规则：/h0 → /h1 → … → /hn */
  function chainRules(n: number): Rule[] {
    return Array.from({ length: n }, (_, i) =>
      redirect(`r${i}`, 'a.com', `/h${i}`, `/h${i + 1}`, 301),
    );
  }

  it(`恰好 ${MAX_REDIRECTS} 次重定向后终止：成功`, () => {
    const chain = followRedirects(
      chainRules(MAX_REDIRECTS),
      'GET',
      'http://a.com/h0',
    );
    expect(chain.status).toBe('final');
    expect(chain.ok).toBe(true);
    expect(chain.hops).toHaveLength(MAX_REDIRECTS);
    expect(chain.terminal?.url).toBe(`http://a.com/h${MAX_REDIRECTS}`);
  });

  it(`第 ${MAX_REDIRECTS + 1} 跳仍遇重定向：超限，不显示成功`, () => {
    const chain = followRedirects(
      chainRules(MAX_REDIRECTS + 1),
      'GET',
      'http://a.com/h0',
    );
    expect(chain.status).toBe('max-redirects');
    expect(chain.ok).toBe(false);
    // 超限那一跳的重定向响应也记录在案（只是不再跟随）
    expect(chain.hops).toHaveLength(MAX_REDIRECTS + 1);
    expect(chain.terminal).toBeNull();
    expect(chain.reason).toContain('超过上限');
  });
});

describe('followRedirects · 规则快照', () => {
  it('运行不改动调用方传入的规则表', () => {
    const rules = [redirect('r1', 'a.com', '/x', 'http://b.com/y', 301)];
    const before = JSON.stringify(rules);
    followRedirects(rules, 'GET', 'http://a.com/x');
    expect(JSON.stringify(rules)).toBe(before);
  });
});
