export const recommendationSignalFields = {
  matchWeight:{label:'需求匹配权重',min:.01,max:10,step:'any'},
  recognitionWeight:{label:'内容认可权重',min:0,max:1,step:'any'},
  heatWeight:{label:'近期热度权重',min:0,max:1,step:'any'},
  smoothing:{label:'排序平滑程度',min:1,max:1000,step:'any'},
  maxPositionChange:{label:'最多调整位置',min:0,max:10,step:1},
} as const;

export const contentScoreFields = {
  likeWeight:{label:'有效点赞系数',min:0,max:10,step:'any'},
  contentRecognitionWeight:{label:'内容认可系数',min:0,max:10,step:'any'},
  freshnessWeight:{label:'发布时间系数',min:0,max:10,step:'any'},
  discussionWeight:{label:'近期讨论系数',min:0,max:10,step:'any'},
  diminishingScale:{label:'互动增量递减尺度',min:1,max:1000,step:'any'},
  halfLifeHours:{label:'热度减半时间（小时）',min:1,max:720,step:'any'},
} as const;

export const communitySignalFields = {...recommendationSignalFields,...contentScoreFields};
export type CommunitySignalKey = keyof typeof communitySignalFields;
export const communitySignalKeys = Object.keys(communitySignalFields) as CommunitySignalKey[];
