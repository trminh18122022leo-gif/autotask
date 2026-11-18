/** Connection tester for AI models. Measures latency and categorizes errors safely. */
import type { ProviderId, ProviderKind, TestConnectionResult, ConnectionErrorCategory } from './types.js';
import { sanitizeError } from './keyring.js';
import { normalizeModelSlug } from './catalog.js';

export interface PingTarget {
  provider: ProviderId;
  kind: ProviderKind;
  model: string;
  endpoint: string;
  apiKey: string;
}

export function categorizeError(status?: number, rawMessage = ''): { category: ConnectionErrorCategory; suggestion: string } {
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid.*key|authentication/i.test(rawMessage)) {
    return {
      category: 'AUTH_INVALID_KEY',
      suggestion: 'API key không hợp lệ, đã hết hạn hoặc không đủ quyền. Hãy kiểm tra lại API key trong API Key Manager.'
    };
  }
  if (status === 429 || /quota|rate limit|resource.*exhausted|credits|exceeded.*budget/i.test(rawMessage)) {
    return {
      category: 'QUOTA_EXCEEDED',
      suggestion: 'Hết hạn mức sử dụng (Quota) hoặc bị nghẽn Rate Limit từ nhà cung cấp. Kiểm tra số dư tài khoản AI.'
    };
  }
  if (status === 404 || /not found|does not exist|model_not_found/i.test(rawMessage)) {
    return {
      category: 'MODEL_NOT_FOUND',
      suggestion: 'Model ID không tồn tại hoặc tài khoản chưa được cấp quyền truy cập model này.'
    };
  }
  if (/fetch failed|econnrefused|enotfound|timeout|timed out|abort/i.test(rawMessage)) {
    return {
      category: 'NETWORK_ERROR',
      suggestion: 'Không thể kết nối đến máy chủ API. Kiểm tra kết nối Internet, proxy hoặc endpoint URL.'
    };
  }
  return {
    category: 'UNKNOWN_ERROR',
    suggestion: 'Gặp lỗi không xác định từ máy chủ. Kiểm tra log chi tiết.'
  };
}

export async function testConnection(target: PingTarget): Promise<TestConnectionResult> {
  const { provider, kind, model, endpoint, apiKey } = target;
  if (!apiKey) {
    return {
      success: false,
      latencyMs: 0,
      category: 'AUTH_INVALID_KEY',
      errorMessage: 'Chưa có API key được lưu trong OS credential vault cho profile này.',
      suggestion: 'Thêm API key trong mục API Key Manager.',
      modelUsed: model,
      provider
    };
  }

  const start = Date.now();
  try {
    let url = endpoint;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let body: any;

    if (kind === 'gemini') {
      const normalizedModel = normalizeModelSlug('gemini', model);
      url = `${endpoint.replace(/\/$/, '')}/models/${encodeURIComponent(normalizedModel)}:generateContent`;
      headers['x-goog-api-key'] = apiKey;
      body = {
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1 }
      };
    } else if (kind === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = {
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }]
      };
    } else {
      // OpenAI compatible / Groq
      headers.Authorization = `Bearer ${apiKey}`;
      body = {
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      let errorBody = '';
      try {
        const errorJson: any = await response.json();
        errorBody = errorJson.error?.message || errorJson.message || JSON.stringify(errorJson);
      } catch {
        errorBody = await response.text();
      }

      const cleanMessage = sanitizeError(errorBody, apiKey);
      const { category, suggestion } = categorizeError(response.status, cleanMessage);

      return {
        success: false,
        latencyMs,
        statusCode: response.status,
        category,
        errorMessage: `HTTP ${response.status}: ${cleanMessage}`,
        suggestion,
        modelUsed: model,
        provider
      };
    }

    return {
      success: true,
      latencyMs,
      statusCode: 200,
      modelUsed: model,
      provider
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const rawMsg = err instanceof Error ? err.message : String(err);
    const cleanMessage = sanitizeError(rawMsg, apiKey);
    const { category, suggestion } = categorizeError(undefined, cleanMessage);

    return {
      success: false,
      latencyMs,
      category,
      errorMessage: cleanMessage,
      suggestion,
      modelUsed: model,
      provider
    };
  }
}
