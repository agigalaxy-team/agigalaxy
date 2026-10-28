package discovery

// Original qualified-source/request-bound topic aggregation.
const topicMetricsSQL = `WITH themes AS (SELECT * FROM jsonb_to_recordset($4::jsonb) AS t(key text,query_terms jsonb)),
   refs AS (SELECT * FROM jsonb_to_recordset($5::jsonb) AS r(item_key text,version text,theme_keys jsonb)),
   events AS (SELECT e.name,e.payload,r.theme_keys FROM discovery_usage_events_v1 e LEFT JOIN refs r
    ON r.item_key=e.payload->>'itemKey' AND r.version=e.payload->>'sourceVersion'
    WHERE e.endpoint=$1 AND e.purpose='site-usage-analytics' AND e.created_at>=$2::timestamptz AND e.created_at<$3::timestamptz)
   SELECT t.key,
    count(*) FILTER(WHERE e.name IN ('content-view','content-click','content-bookmark','content-participate','search-click','search')
     AND (coalesce(e.theme_keys,'[]'::jsonb) ? t.key OR e.name='search' AND t.query_terms ? lower(regexp_replace(normalize(trim(coalesce(e.payload->>'query','')),NFKC),'[[:space:]]+',' ','g'))))::integer AS demand,
    count(*) FILTER(WHERE e.name='content-exposure' AND e.payload->'recommendation'->'themeKeys' ? t.key)::integer AS exposures,
    count(*) FILTER(WHERE e.name='content-click' AND e.payload->'recommendation'->'themeKeys' ? t.key)::integer AS clicks,
    count(*) FILTER(WHERE e.name='content-bookmark' AND e.payload->'recommendation'->'themeKeys' ? t.key)::integer AS bookmarks,
    count(*) FILTER(WHERE e.name='not-interested' AND e.payload->'recommendation'->'themeKeys' ? t.key)::integer AS negative,
    count(*) FILTER(WHERE e.payload->'recommendation'->'themeKeys' ? t.key)::integer AS attributed
   FROM themes t LEFT JOIN events e ON coalesce(e.theme_keys,'[]'::jsonb) ? t.key
    OR e.payload->'recommendation'->'themeKeys' ? t.key OR e.name='search' AND t.query_terms ? lower(regexp_replace(normalize(trim(coalesce(e.payload->>'query','')),NFKC),'[[:space:]]+',' ','g'))
   GROUP BY t.key`
