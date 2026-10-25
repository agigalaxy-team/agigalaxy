// Only overlapping reads share a network attempt. Settled results are not cached.
const configurationReads = new WeakMap();

async function readConfigurationText(fetcher) {
  const response = await fetcher('/galaxy-web-config.json', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('当前网站尚未配置业务服务。');
  const raw = await response.text(); if (raw.length > 16000) throw new Error('网站服务配置无效。');
  return raw;
}

function configurationText(fetcher) {
  let pending = configurationReads.get(fetcher);
  if (!pending) {
    pending = readConfigurationText(fetcher);
    configurationReads.set(fetcher, pending);
    void pending.finally(() => {
      if (configurationReads.get(fetcher) === pending) configurationReads.delete(fetcher);
    }).catch(() => {});
  }
  return pending;
}

export async function loadWebConfiguration(fetcher = globalThis.fetch) {
  const raw = await configurationText(fetcher);
  // Parse for each caller so deployment pins and their Maps are never shared.
  const config = JSON.parse(raw);
  if (config.version !== 1 || !Array.isArray(config.signingKeys) || config.signingKeys.length < 1) throw new Error('网站服务配置无效。');
  // No received manifest can silently replace these deployment-selected pins.
  return { endpoint: config.endpoint, trustedKeys: new Map(config.signingKeys.map(pin => [pin.kid, pin])), operator: config.operator ?? '银河技术团队' };
}
