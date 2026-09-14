// Event order is reporting order, not an inferred clock or a competence score.
export function historyReportedProgress(rows){
  const corrections=new Set(rows.filter(row=>row.payload.kind==='revision'&&!row.payload.review).map(row=>row.payload.correctsEventId));
  const timeline=[],subsequentReports=[];let previousSuccess=null;
  for(const row of rows){
    const event=row.payload;if(event.kind!=='result')continue;
    const report={resultId:event.id,attemptId:event.attemptId,outcome:event.outcome,sourceEventVersion:row.version,corrected:corrections.has(event.id)};
    timeline.push(report);
    if(previousSuccess&&event.outcome!=='succeeded')subsequentReports.push({previousSuccessId:previousSuccess.resultId,resultId:event.id,
      attemptRelation:event.attemptId===previousSuccess.attemptId?'same-attempt':'different-attempt',regressionVerified:false});
    if(event.outcome==='succeeded')previousSuccess=report;
  }
  return {version:1,authority:'case-owner-reported',latestResultId:timeline.at(-1)?.resultId??null,timeline,subsequentReports,
    capabilityVerified:false,attemptCountIsCapability:false};
}
