
ALTER TABLE forum_versions_v1 ADD COLUMN topic text
 CHECK(topic IN ('technology','arts','learning','life','galaxy'));
CREATE INDEX forum_posts_publication_v1 ON forum_posts_v1(created_at DESC,id DESC) WHERE state='published';
CREATE INDEX forum_posts_owner_publication_v1 ON forum_posts_v1(subject_id,created_at DESC,id DESC);
CREATE INDEX forum_versions_topic_v1 ON forum_versions_v1(topic,post_id,id);
