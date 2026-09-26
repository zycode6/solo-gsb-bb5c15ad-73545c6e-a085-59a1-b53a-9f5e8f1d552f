import type { Rule, Simulation } from './types';
import { simulate } from './engine';

/** 重定向链最多跟随的重定向次数；耗尽后仍遇重定向即判超限 */
export const MAX_REDIRECTS = 10;

/**
 * 按 HTTP 语义推算跟随重定向后的下一跳方法：
 * - 301 / 302：仅 POST 改为 GET，其余方法保持；
 * - 303：除 HEAD 外一律改为 GET；
 * - 307 / 308：保持原方法。
 */
export function redirectMethod(method: string, status: number): string {
  const m = method.toUpperCase();
  switch (status) {
    case 301:
    case 302:
      return m === 'POST' ? 'GET' : m;
    case 303:
      return m === 'HEAD' ? 'HEAD' : 'GET';
    default:
      // 307 / 308（及其余状态码）保持方法
      return m;
  }
}

/** 一跳重定向：一次完整模拟（可能含多步内部重写）以重定向告终 */
export interface RedirectHop {
  /** 第几跳（1 起） */
  n: number;
  /** 入站方法（上一跳按状态码改写后的方法；首跳为输入方法） */
  method: string;
  /** 入站 URL（URL API 序列化结果；首跳输入无法解析时为原文） */
  url: string;
  /** 该跳返回的重定向状态码 */
  status: number;
  /** 该跳返回的 Location（引擎已解析为绝对地址） */
  location: string;
  /** 该跳的完整模拟结果：内部重写轨迹 + 末尾的重定向步骤 */
  sim: Simulation;
}

/** 链的终止跳：以非重定向结果或引擎失败结束的那一跳 */
export interface ChainTerminal {
  /** 入站方法 */
  method: string;
  /** 入站 URL（序列化） */
  url: string;
  /** 该跳的完整模拟结果（ok 为 false 即引擎失败） */
  sim: Simulation;
}

export type ChainStatus =
  | 'final' // 某一跳返回非重定向结果（final / stopped），链正常结束
  | 'loop' // 跨跳循环：入站「方法 + 序列化 URL」重复出现（失败）
  | 'max-redirects' // 跟随 MAX_REDIRECTS 次后仍遇重定向（失败，不显示成功）
  | 'engine-error'; // 某一跳模拟本身失败（循环 / 超限 / 非法输入等）（失败）

export interface RedirectChain {
  status: ChainStatus;
  /** 是否为成功跑完的链（循环 / 超限 / 引擎失败为 false） */
  ok: boolean;
  /** 已记录的重定向跳（含超限时那条未被跟随的重定向响应） */
  hops: RedirectHop[];
  /** 终止跳；循环 / 超限时为 null */
  terminal: ChainTerminal | null;
  reason: string;
}

/**
 * 重定向链预演：复用 simulate 引擎在本地跟随 Location，不发出任何网络请求。
 *
 * 1. 运行前对规则表做深拷贝快照，整链都跑在这份快照上；
 * 2. 每一跳从第一条规则重新完整模拟（含内部重写），直到该跳以重定向终止；
 * 3. 按状态码改写方法（见 {@link redirectMethod}），以 Location 作为下一跳入站 URL；
 * 4. 非重定向结果（final / stopped）或引擎失败（ok 为 false）即终止；
 * 5. 每跳入站前以「方法 + 序列化 URL」检测跨跳循环；
 * 6. 最多跟随 MAX_REDIRECTS 次重定向，耗尽后仍遇重定向则判超限（不返回成功）。
 */
export function followRedirects(
  rules: Rule[],
  method: string,
  inputUrl: string,
): RedirectChain {
  const snapshot = structuredClone(rules);
  const hops: RedirectHop[] = [];
  // 入站状态 → 首次出现的跳号，用于跨跳循环检测
  const seen = new Map<string, number>();
  let m = method.toUpperCase();
  let url = inputUrl;

  for (;;) {
    const n = hops.length + 1;
    // URL 无法解析时以原文参与检测即可——本跳引擎会报 invalid-url 并终止
    let serialized: string;
    try {
      serialized = new URL(url).toString();
    } catch {
      serialized = url;
    }
    const stateKey = `${m} ${serialized}`;
    const firstSeenAt = seen.get(stateKey);
    if (firstSeenAt !== undefined) {
      return {
        status: 'loop',
        ok: false,
        hops,
        terminal: null,
        reason: `检测到跨跳循环：第 ${n} 跳的入站状态「${stateKey}」与第 ${firstSeenAt} 跳相同`,
      };
    }
    seen.set(stateKey, n);

    const sim = simulate(snapshot, m, url);

    if (!sim.ok) {
      return {
        status: 'engine-error',
        ok: false,
        hops,
        terminal: { method: m, url: serialized, sim },
        reason: `第 ${n} 跳模拟失败，链终止：${sim.reason}`,
      };
    }

    if (sim.status !== 'redirect') {
      return {
        status: 'final',
        ok: true,
        hops,
        terminal: { method: m, url: serialized, sim },
        reason:
          hops.length === 0
            ? '首跳即未返回重定向，链直接结束'
            : `共跟随 ${hops.length} 次重定向，第 ${n} 跳未再重定向，链正常结束`,
      };
    }

    // 引擎对 redirect 终止保证携带状态码与 Location
    const status = sim.redirectStatus!;
    const location = sim.redirectLocation!;
    hops.push({ n, method: m, url: serialized, status, location, sim });

    if (hops.length > MAX_REDIRECTS) {
      return {
        status: 'max-redirects',
        ok: false,
        hops,
        terminal: null,
        reason: `已跟随 ${MAX_REDIRECTS} 次重定向，第 ${n} 跳仍返回 ${status} 重定向，超过上限，判定失败`,
      };
    }

    m = redirectMethod(m, status);
    url = location;
  }
}
