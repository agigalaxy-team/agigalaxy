export type Publication={id:string;state:'queued'|'building'|'published'|'failed';createdAt:string;updatedAt:string;publishedAt:string|null;requestedBy:string;result:null|{publicUrl:string;siteVersion:string;publicationId:string};error:null|{code:string;message:string;retryable:boolean}};
export type PublicationPage={items:Publication[];nextAfter:string|null};
export type SnapshotSummary={pages:{id:string;path:string;title:string;updatedAt:string}[];siteTitle:string};
