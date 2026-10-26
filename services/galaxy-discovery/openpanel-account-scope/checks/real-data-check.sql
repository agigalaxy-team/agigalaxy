-- Read-only literal-row acceptance, for root to use with the existing native
-- ClickHouse at activation. No INSERT, CREATE, migration, or real profile data.
-- This checks the key/filter semantics, not the whole native HTTP pipeline.
-- Also verify both actual scoped API responses after root activation. Do not
-- count the build's transport doubles as ClickHouse execution.
WITH fixture AS (
  SELECT tupleElement(row, 1) AS profile_id, tupleElement(row, 2) AS session_id,
         tupleElement(row, 3) AS event_name
  FROM (SELECT arrayJoin([
    ('visitor:fixture', 'shared-device-session', 'entry'),
    ('visitor:fixture', 'shared-device-session', 'anonymous-only'),
    ('account:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'shared-device-session', 'entry'),
    ('account:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'shared-device-session', 'alpha'),
    ('account:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'shared-device-session', 'entry'),
    ('account:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'shared-device-session', 'beta')
  ]) AS row)
), account_paths AS (
  SELECT tuple(profile_id, session_id) AS account_session_id, groupArray(event_name) AS events
  FROM fixture WHERE profile_id LIKE 'account:%' GROUP BY account_session_id
)
SELECT throwIf(count() != 2, 'account/session partition must contain exactly A and B'),
       throwIf(countIf(has(events, 'anonymous-only')) != 0, 'anonymous event leaked'),
       throwIf(countIf(has(events, 'alpha') AND has(events, 'beta')) != 0, 'A and B session events merged')
FROM account_paths;
