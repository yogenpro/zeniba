import { CONTRACT_SHA256, validateDescriptor, validateHealth, validateProposal, validateRequestWindow } from '../contract';
import { requireSafe, SafeError } from '../errors';
import { byteLength, parseJson, readBody, MAX_BODY } from '../json';
import type { Clock, Descriptor, Health, Proposal, ProposalRequest, Transport } from '../types';

/** Backend-only transport. Explicit injection is mandatory; there is no default/global fetch. */
interface ProviderConfig {
  baseUrl: string; token: string; releaseId: string; inputId: string;
  transport: Transport; clock: Clock; timeoutMs?: number;
}
export class ProviderClient {
  private readonly origin: string;
  private readonly config: Readonly<ProviderConfig>;
  constructor(config: ProviderConfig) {
    this.config = Object.freeze({ ...config });
    let url: URL;
    try { url = new URL(config.baseUrl); } catch { throw new SafeError('invalid_provider_config', 503); }
    requireSafe(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === '/' && config.token.length > 0 && /^[0-9a-f]{64}$/.test(config.releaseId)
      && /^[0-9a-f]{64}$/.test(config.inputId), 'invalid_provider_config', 503);
    this.origin = url.origin;
  }
  private async call(path: string, body?: string): Promise<{ value: unknown; raw: string }> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = async () => {
        if (body !== undefined) requireSafe(byteLength(body) <= MAX_BODY, 'payload_too_large', 413);
        const headers: Record<string, string> = { Authorization: `Bearer ${this.config.token}`, Accept: 'application/json' };
        if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(byteLength(body)); }
        const request = new Request(this.origin + path, { method: body === undefined ? 'GET' : 'POST', headers,
          body, redirect: 'manual', signal: controller.signal });
        const response = await this.config.transport(request);
        requireSafe(response.status < 300 || response.status >= 400, 'provider_redirect_refused', 502);
        requireSafe(response.ok, response.status === 401 ? 'provider_auth_failed' : 'provider_rejected', 502);
        requireSafe(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json'
          && /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? ''), 'invalid_provider_response', 502);
        const raw = await readBody(response, controller.signal);
        return { value: parseJson(raw), raw };
      };
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new SafeError('provider_timeout', 504)); }, this.config.timeoutMs ?? 3000);
      })]);
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError('provider_unavailable', 502);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async health(): Promise<Health> {
    const { value } = await this.call('/v1/health');
    validateHealth(value, this.config.releaseId, CONTRACT_SHA256); return value;
  }
  async descriptor(): Promise<Descriptor> {
    const { value } = await this.call(`/v1/inputs/${this.config.inputId}`);
    validateDescriptor(value, this.config.releaseId, this.config.inputId, this.config.clock()); return value;
  }
  async propose(savedBody: string, descriptor: Descriptor): Promise<{ proposal: Proposal; raw: string }> {
    validateDescriptor(descriptor, this.config.releaseId, this.config.inputId, this.config.clock());
    const request = parseJson(savedBody) as ProposalRequest;
    validateRequestWindow(request, descriptor, this.config.clock());
    const { value, raw } = await this.call('/v1/proposals', savedBody);
    return { proposal: await validateProposal(value, request, descriptor, this.config.clock()), raw };
  }
}
