import * as z from 'zod/v4';

export const forumTopicSchema = z.enum(['technology', 'arts', 'learning', 'life', 'galaxy']);
export const forumReadTopicSchema = z.enum(['technology', 'arts', 'learning', 'life', 'galaxy', 'unclassified']);

/** @type {ReadonlyArray<Readonly<{id: 'technology'|'arts'|'learning'|'life'|'galaxy', label: string, description: string}>>} */
export const forumTopics = Object.freeze([
  Object.freeze({id: 'technology', label: '技术与工具', description: '交流技术问题、工具使用与实际尝试。'}),
  Object.freeze({id: 'arts', label: '艺术与创作', description: '分享作品、创作过程与想法。'}),
  Object.freeze({id: 'learning', label: '阅读与学习', description: '交流阅读所得、学习过程与问题。'}),
  Object.freeze({id: 'life', label: '生活与兴趣', description: '聊生活、兴趣及日常发现。'}),
  Object.freeze({id: 'galaxy', label: '银河使用与反馈', description: '讨论银河的使用、建议与遇到的问题。'}),
]);
export const forumUnclassifiedTopic = Object.freeze({id: 'unclassified', label: '未分类'});
