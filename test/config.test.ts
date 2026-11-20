import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('DEEPSEEK_* работают как запасные имена LLM_*', () => {
    const config = loadConfig({ DEEPSEEK_API_KEY: 'sk-d', DEEPSEEK_BASE_URL: 'http://ds:1' });

    expect(config.LLM_API_KEY).toBe('sk-d');
    expect(config.LLM_BASE_URL).toBe('http://ds:1');
    expect(config.LLM_METADATA).toBe(false);
  });

  it('LLM_* важнее DEEPSEEK_*', () => {
    const config = loadConfig({
      DEEPSEEK_API_KEY: 'sk-d',
      LLM_API_KEY: 'sk-litellm',
      LLM_BASE_URL: 'http://litellm.llm:4000',
      LLM_METADATA: 'true',
    });

    expect(config.LLM_API_KEY).toBe('sk-litellm');
    expect(config.LLM_BASE_URL).toBe('http://litellm.llm:4000');
    expect(config.LLM_METADATA).toBe(true);
  });

  it('без ключа ошибка без значений других переменных', () => {
    expect(() => loadConfig({ LANGFUSE_SECRET_KEY: 'sk-lf-secret' })).toThrow(/LLM_API_KEY/);
    expect(() => loadConfig({ LANGFUSE_SECRET_KEY: 'sk-lf-secret' })).not.toThrow(/sk-lf/);
  });

  it('LANGFUSE_* задаются все три или ни одного', () => {
    expect(() => loadConfig({ LLM_API_KEY: 'k', LANGFUSE_HOST: 'http://lf:3000' })).toThrow(
      /LANGFUSE_/,
    );
    const config = loadConfig({
      LLM_API_KEY: 'k',
      LANGFUSE_HOST: 'http://lf:3000',
      LANGFUSE_PUBLIC_KEY: 'pk',
      LANGFUSE_SECRET_KEY: 'sk',
    });
    expect(config.LANGFUSE_HOST).toBe('http://lf:3000');
  });

  it('FAULT_ERROR_RATE: по умолчанию 0, доля от 0 до 1', () => {
    expect(loadConfig({ LLM_API_KEY: 'k' }).FAULT_ERROR_RATE).toBe(0);
    expect(loadConfig({ LLM_API_KEY: 'k', FAULT_ERROR_RATE: '0.5' }).FAULT_ERROR_RATE).toBe(0.5);
    expect(() => loadConfig({ LLM_API_KEY: 'k', FAULT_ERROR_RATE: '1.5' })).toThrow(
      /FAULT_ERROR_RATE/,
    );
  });
});
