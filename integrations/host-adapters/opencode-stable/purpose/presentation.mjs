export const unwrap = (result) => {
  if (result?.isError)
    throw new Error(
      result.structuredContent?.error ?? 'current_content_unavailable',
    );
  if (result?.structuredContent) return result.structuredContent;
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return result;
  }
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
