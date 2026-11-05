export const unwrap = (result) => {
  if (result?.resultType === 'input_required') return {state: 'host-choice-required'};
  let data = result?.structuredContent;
  if (data === undefined && result?.content?.[0]?.type === 'text') {
    try { data = JSON.parse(result.content[0].text); } catch { /* Human-readable content is not machine data. */ }
  }
  data ??= result;
  if (result?.isError || data?.error) {
    const code = data?.error ?? 'current_content_unavailable';
    throw Object.assign(new Error(code), {code, ...(data && typeof data === 'object' ? data : {})});
  }
  return data;
};
export const plain = (value) =>
  String(value ?? '')
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .slice(0, 16000);
export const fingerprint = (status) =>
  JSON.stringify(
    status.connectionChoice
      ? [
          status.identity,
          status.endpoint,
          status.connectionChoice.revision,
          status.connectionChoice.enabled,
          status.connectionChoice.deviceId,
        ]
      : [
          status.identity,
          status.endpoint,
          status.connection?.bindingId ?? null,
          status.connection?.generation ?? null,
        ],
  );
