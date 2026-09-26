import { useMemo, useState } from 'react';
import type { Rule } from '../types';
import { REQUEST_METHODS } from '../types';
import {
  MAX_REDIRECTS,
  followRedirects,
  redirectMethod,
  type ChainTerminal,
  type RedirectChain,
  type RedirectHop,
} from '../redirectChain';
import { StepCard } from './TraceView';

const CHAIN_STATUS_META: Record<
  RedirectChain['status'],
  { cls: string; icon: string; title: string }
> = {
  final: { cls: 'ok', icon: '✅', title: '链正常结束' },
  loop: { cls: 'error', icon: '🔁', title: '失败 · 检测到跨跳循环' },
  'max-redirects': {
    cls: 'error',
    icon: '⚠️',
    title: `失败 · 超过 ${MAX_REDIRECTS} 次重定向上限`,
  },
  'engine-error': { cls: 'error', icon: '❌', title: '失败 · 引擎模拟失败' },
};

/** 一跳重定向：头部展示入站方法 / URL 与状态码 + Location，可展开内部重写轨迹 */
function HopRow({
  hop,
  expanded,
  onToggle,
}: {
  hop: RedirectHop;
  expanded: boolean;
  onToggle: () => void;
}) {
  // 该跳状态码决定的下一跳方法；与入站方法不同时标注改写
  const next = redirectMethod(hop.method, hop.status);
  const rewritten = next !== hop.method;
  return (
    <div className="chain-hop">
      <button type="button" className="chain-hop-head" onClick={onToggle}>
        <span className="cov-caret">{expanded ? '▼' : '▶'}</span>
        <span className="chain-hop-n">第 {hop.n} 跳</span>
        <span className="tag case-method">{hop.method}</span>
        <code className="chain-hop-url">{hop.url}</code>
      </button>
      <div className="chain-hop-loc">
        <span className="tag action-redirect">{hop.status}</span>
        <span className="chain-loc-label">Location：</span>
        <code className="url-to">{hop.location}</code>
        {rewritten && (
          <span
            className="tag tag-method-change"
            title="按状态码语义改写下一跳方法：301/302 仅 POST→GET，303 除 HEAD 外→GET"
          >
            方法改写 {hop.method} → {next}
          </span>
        )}
      </div>
      {expanded && (
        <div className="chain-hop-trace">
          <p className="chain-trace-caption">
            该跳内部模拟轨迹（{hop.sim.steps.length} 步，从首条规则重新匹配）：
          </p>
          {hop.sim.steps.map((s) => (
            <StepCard key={s.n} step={s} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 终止跳：非重定向结果或引擎失败，链到此结束 */
function TerminalRow({
  terminal,
  n,
  expanded,
  onToggle,
}: {
  terminal: ChainTerminal;
  /** 在链中的跳号（= 重定向跳数 + 1） */
  n: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { sim } = terminal;
  return (
    <div className={`chain-hop chain-terminal${sim.ok ? '' : ' chain-terminal-error'}`}>
      <button type="button" className="chain-hop-head" onClick={onToggle}>
        <span className="cov-caret">{expanded ? '▼' : '▶'}</span>
        <span className="chain-hop-n">终止 · 第 {n} 跳</span>
        <span className="tag case-method">{terminal.method}</span>
        <code className="chain-hop-url">{terminal.url}</code>
      </button>
      <div className="chain-hop-loc">
        {sim.status === 'final' && (
          <>
            <span className="tag chain-tag-final">最终响应</span>
            <span className="chain-loc-label">最终 URL：</span>
            <code className="url-to">{sim.finalUrl}</code>
          </>
        )}
        {sim.status === 'stopped' && (
          <>
            <span className="tag action-stop">已停止</span>
            <span className="chain-loc-label">请求被规则停止，不再继续</span>
          </>
        )}
        {!sim.ok && (
          <>
            <span className="tag chain-tag-error">模拟失败</span>
            <span className="chain-loc-label">{sim.reason}</span>
          </>
        )}
      </div>
      {expanded && (
        <div className="chain-hop-trace">
          {sim.steps.length === 0 ? (
            <p className="empty">（该跳没有任何规则命中）</p>
          ) : (
            sim.steps.map((s) => <StepCard key={s.n} step={s} />)
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  rules: Rule[];
}

/**
 * 重定向链预演：独立面板，输入「方法 + URL」后在本地跟随 Location（不发网络请求）。
 * 运行基于当时的规则快照；之后规则或输入变化时，旧结果仅标记过期、不清空。
 */
export function RedirectChainPanel({ rules }: Props) {
  // 输入与结果只保存在当前页面会话（内存），不写入 localStorage
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('http://blog.example.com/posts/hello-world');
  const [touched, setTouched] = useState(false);
  const [lastRun, setLastRun] = useState<{ stamp: string; chain: RedirectChain } | null>(
    null,
  );
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  // 输入指纹：规则或输入变化后，上次结果标记为过期
  const stamp = useMemo(
    () => JSON.stringify({ rules, method, url }),
    [rules, method, url],
  );
  const stale = lastRun !== null && lastRun.stamp !== stamp;
  const chain = lastRun?.chain ?? null;

  const invalid = touched && url.trim() === '';

  const run = () => {
    setTouched(true);
    if (url.trim() === '') return;
    setLastRun({ stamp, chain: followRedirects(rules, method, url) });
    setExpanded(new Set());
  };

  const toggle = (n: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const meta = chain ? CHAIN_STATUS_META[chain.status] : null;
  const terminalN = chain ? chain.hops.length + 1 : 0;

  return (
    <section className="panel">
      <h2>重定向链预演</h2>
      <p className="baseline-info">
        复用当前规则表在本地跟随 Location，<strong>不发出真实网络请求</strong>：
        每跳从首条规则重新模拟；301/302 仅将 POST 改为 GET，303 除 HEAD 外改为 GET，
        307/308 保持方法；以「方法 + URL」识别跨跳循环，最多跟随 {MAX_REDIRECTS} 次重定向。
      </p>
      <form
        className="sim-form chain-form"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {REQUEST_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          className={invalid ? 'invalid' : ''}
          value={url}
          placeholder="http://blog.example.com/posts/hello-world"
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" className="primary">
          预演重定向链
        </button>
      </form>
      {invalid && <div className="banner error">请输入待预演的 URL</div>}

      {chain && meta && (
        <div className="chain-report">
          {stale && (
            <div className="banner warn">
              ⚠️ 规则或输入在上次运行后已变更，以下结果已过期，请重新预演。
            </div>
          )}
          <h3 className="reg-subtitle">
            共 {chain.hops.length} 跳重定向
            {chain.terminal ? '，外加 1 跳终止响应' : ''}
          </h3>
          {chain.hops.map((hop) => (
            <HopRow
              key={hop.n}
              hop={hop}
              expanded={expanded.has(hop.n)}
              onToggle={() => toggle(hop.n)}
            />
          ))}
          {chain.terminal && (
            <TerminalRow
              terminal={chain.terminal}
              n={terminalN}
              expanded={expanded.has(terminalN)}
              onToggle={() => toggle(terminalN)}
            />
          )}
          <div className={`banner ${meta.cls}`}>
            <strong>
              {meta.icon} {meta.title}
            </strong>
            <p>{chain.reason}</p>
          </div>
        </div>
      )}
    </section>
  );
}
