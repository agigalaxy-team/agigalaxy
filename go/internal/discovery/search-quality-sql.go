package discovery

// Original request-bound quality aggregation; source predicates are unchanged.
const qualityFactsSQL = `WITH base AS (
   SELECT name,payload FROM discovery_usage_events_v1 WHERE endpoint=$1 AND purpose='site-usage-analytics'
    AND name IN ('search','search-click','content-bookmark','content-participate') AND created_at>=$2::timestamptz AND created_at<$3::timestamptz),
   searches AS (SELECT lower(regexp_replace(normalize(trim(payload->>'query'),NFKC),'[[:space:]]+',' ','g')) AS key,payload FROM base WHERE name='search'),
   measured AS (SELECT DISTINCT payload->'search'->>'requestId' AS id,key,payload->'search'->>'resultState' AS result_state FROM searches WHERE payload->'search' IS NOT NULL),
   query_counts AS (SELECT key,min(payload->>'query') AS label,count(*)::integer AS searches FROM searches GROUP BY key),
   measurements AS (SELECT key,count(*)::integer AS measured_searches,count(*) FILTER(WHERE result_state<>'scan-limited')::integer AS known_searches,count(*) FILTER(WHERE result_state='no-results')::integer AS no_results,count(*) FILTER(WHERE result_state='scan-limited')::integer AS scan_limited FROM measured GROUP BY key),
   effects AS (SELECT m.key,count(*) FILTER(WHERE e.name='search-click')::integer AS clicks,count(DISTINCT m.id) FILTER(WHERE e.name='search-click')::integer AS clicked_searches,count(*) FILTER(WHERE e.name IN ('content-bookmark','content-participate'))::integer AS follow_ups FROM measured m JOIN base e ON e.payload->'search'->>'requestId'=m.id GROUP BY m.key),
   facts AS (SELECT q.*,coalesce(m.measured_searches,0) AS measured_searches,coalesce(m.known_searches,0) AS known_searches,coalesce(m.no_results,0) AS no_results,coalesce(m.scan_limited,0) AS scan_limited,coalesce(e.clicks,0) AS clicks,coalesce(e.clicked_searches,0) AS clicked_searches,coalesce(e.follow_ups,0) AS follow_ups FROM query_counts q LEFT JOIN measurements m USING(key) LEFT JOIN effects e USING(key)),
   filtered AS (SELECT * FROM facts WHERE ($4='' OR position($4 in key)>0) AND
    CASE $5 WHEN 'all' THEN true WHEN 'no-results' THEN no_results>0 WHEN 'no-recorded-click' THEN measured_searches>0 AND clicked_searches=0 WHEN 'scan-limited' THEN scan_limited>0 WHEN 'unmeasured' THEN searches>measured_searches ELSE false END
    AND ($6='' OR key COLLATE "C">$6 COLLATE "C") ORDER BY key COLLATE "C" LIMIT $7)
   SELECT coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY key COLLATE "C") FROM filtered f),'[]'::jsonb) AS items,
    (SELECT jsonb_build_object('searches',coalesce(sum(searches),0),'measured_searches',coalesce(sum(measured_searches),0),'known_searches',coalesce(sum(known_searches),0),'no_results',coalesce(sum(no_results),0),'scan_limited',coalesce(sum(scan_limited),0),'clicks',coalesce(sum(clicks),0),'clicked_searches',coalesce(sum(clicked_searches),0),'follow_ups',coalesce(sum(follow_ups),0)) FROM facts) AS totals`
