// Tests assert the exact machine result separately from user-facing text.
export const nativeData=result=>result.structuredContent??JSON.parse(result.content[0].text);
